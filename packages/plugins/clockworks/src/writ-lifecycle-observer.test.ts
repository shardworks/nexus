/**
 * Clockworks — writ-lifecycle CDC observer tests.
 *
 * Drives `handleWritLifecycle` directly with synthetic ChangeEvents so
 * the assertions stay focused on the universal `writ.<type>.<phase>`
 * contract: every status transition (including initial entry into
 * `new` and entry into `cancelled`) fires exactly one event with the
 * writ's `phase` verbatim as the suffix; metadata-only updates fire
 * nothing; `commissionId` is populated by walking `parentId` to the
 * root; emission is best-effort and never propagates.
 *
 * Live integration with the Stacks CDC machinery is exercised by the
 * end-to-end integration test (`integration.test.ts`).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, generateId, setGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, ChangeEvent, ReadOnlyBook, StacksApi } from '@shardworks/stacks-apparatus';

import type { WritDoc } from '@shardworks/clerk-apparatus';

import type { ClockworksApi, EventDoc } from './types.ts';
import { handleWritLifecycle } from './writ-lifecycle-observer.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  eventsBook: ReturnType<StacksApi['book']>;
  writsBook: ReadOnlyBook<WritDoc>;
  apparatusMap: Map<string, unknown>;
}

async function buildFixture(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Seed the in-memory backend with the books the observer reads. We do
  // NOT start the clockworks apparatus here so the live CDC observer is
  // not registered — these tests drive `handleWritLifecycle` directly.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId'],
  });
  backend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });

  await stacksPlugin.apparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Build a thin ClockworksApi that writes directly to the events book.
  // This mirrors the production `emit()` shape without exercising the
  // signal validator or pulling in the rest of the apparatus machinery.
  const eventsBook: Book<EventDoc> = stacks.book<EventDoc>('clockworks', 'events');
  const clockworks: ClockworksApi = {
    async emit(name: string, payload: unknown, emitter: string): Promise<string> {
      const id = generateId('e');
      await eventsBook.put({
        id,
        name,
        payload: payload === undefined ? null : payload,
        emitter,
        firedAt: new Date().toISOString(),
        processed: false,
      });
      return id;
    },
  };
  apparatusMap.set('clockworks', clockworks);

  return {
    stacks,
    clockworks,
    eventsBook,
    writsBook: stacks.readBook<WritDoc>('clerk', 'writs'),
    apparatusMap,
  };
}

function makeWrit(overrides: Partial<WritDoc>): WritDoc {
  const now = new Date().toISOString();
  return {
    id: 'w-test-0001',
    type: 'mandate',
    phase: 'open',
    title: 'test writ',
    body: 'b',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Clockworks — writ-lifecycle observer (universal contract)', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  async function eventNames(): Promise<string[]> {
    const all = await fix.eventsBook.find({ orderBy: ['firedAt', 'asc'] });
    return (all as EventDoc[]).map((d) => d.name);
  }

  async function eventsByName(name: string): Promise<EventDoc[]> {
    const all = await fix.eventsBook.find({
      where: [['name', '=', name]],
      orderBy: ['firedAt', 'asc'],
    });
    return all as EventDoc[];
  }

  // ── Mandate writ — every status transition fires writ.mandate.<status> ─

  it('create-in-open root mandate fires writ.mandate.open', async () => {
    const writ = makeWrit({ id: 'w-root-1', phase: 'open' });
    // The observer reads commissionId via the writs book, so the row
    // must exist there even though the observer was driven by a
    // synthetic ChangeEvent.
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    await writsBook.put(writ);

    const event: ChangeEvent<WritDoc> = {
      type: 'create',
      ownerId: 'clerk',
      book: 'writs',
      entry: writ,
    };
    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      event,
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.open']);

    const [opened] = await eventsByName('writ.mandate.open');
    assert.ok(opened);
    const payload = opened.payload as Record<string, unknown>;
    assert.equal(payload.writId, 'w-root-1');
    assert.equal(payload.commissionId, 'w-root-1');
    assert.equal(payload.phase, 'open');
    assert.equal(opened.emitter, 'framework');
  });

  it('draft creation fires writ.mandate.new (universal contract — no silent gating)', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const drafted = makeWrit({ id: 'w-draft', phase: 'new' });
    await writsBook.put(drafted);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'create',
        ownerId: 'clerk',
        book: 'writs',
        entry: drafted,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.new']);
  });

  it('cancellation fires writ.mandate.cancelled (universal contract — no silent gating)', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const open = makeWrit({ id: 'w-nope', phase: 'open' });
    const cancelled = makeWrit({ id: 'w-nope', phase: 'cancelled' });
    await writsBook.put(cancelled);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: cancelled,
        prev: open,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.cancelled']);
  });

  it('new → open transition (publish) fires writ.mandate.open', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const drafted = makeWrit({ id: 'w-pub-1', phase: 'new' });
    const published = makeWrit({ id: 'w-pub-1', phase: 'open' });
    await writsBook.put(published);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: published,
        prev: drafted,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.open']);
  });

  it('stuck → open re-entry re-emits writ.mandate.open (no first-time-only tracking)', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const stuck = makeWrit({ id: 'w-restart', phase: 'stuck' });
    const reopened = makeWrit({ id: 'w-restart', phase: 'open' });
    await writsBook.put(reopened);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: reopened,
        prev: stuck,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.open']);
  });

  it('open → completed root mandate fires writ.mandate.completed', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const open = makeWrit({ id: 'w-done', phase: 'open' });
    const done = makeWrit({ id: 'w-done', phase: 'completed' });
    await writsBook.put(done);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: done,
        prev: open,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.completed']);
  });

  it('open → failed root mandate fires writ.mandate.failed', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const open = makeWrit({ id: 'w-bust', phase: 'open' });
    const failed = makeWrit({ id: 'w-bust', phase: 'failed', resolution: 'no good' });
    await writsBook.put(failed);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: failed,
        prev: open,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.failed']);
  });

  it('open → stuck root mandate fires writ.mandate.stuck', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const open = makeWrit({ id: 'w-jam', phase: 'open' });
    const stuck = makeWrit({ id: 'w-jam', phase: 'stuck' });
    await writsBook.put(stuck);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: stuck,
        prev: open,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.stuck']);
  });

  // ── Phase-delta gating (unchanged from prior contract) ─────────────

  it('metadata-only update without phase delta produces NO event row', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const open = makeWrit({ id: 'w-rename', phase: 'open', title: 'before' });
    const renamed = makeWrit({ id: 'w-rename', phase: 'open', title: 'after' });
    await writsBook.put(renamed);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'update',
        ownerId: 'clerk',
        book: 'writs',
        entry: renamed,
        prev: open,
      },
    );

    assert.deepEqual(await eventNames(), []);
  });

  // ── Non-mandate / non-root writs — same universal contract ─────────

  it('non-mandate writ types behave identically to mandate under the universal contract', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const piece = makeWrit({
      id: 'w-piece',
      type: 'piece',
      phase: 'open',
      parentId: 'w-parent',
    });
    // Set up a parent the walker can resolve.
    const parent = makeWrit({ id: 'w-parent', phase: 'open' });
    await writsBook.put(parent);
    await writsBook.put(piece);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'create',
        ownerId: 'clerk',
        book: 'writs',
        entry: piece,
      },
    );

    // Non-mandate types fire the same `writ.<type>.<status>` shape that
    // the mandate does — no privileged commission.* family, no special
    // gating. The universal contract is uniform across writ types.
    assert.deepEqual(await eventNames(), ['writ.piece.open']);

    const [ready] = await eventsByName('writ.piece.open');
    const payload = ready!.payload as { commissionId: string; parentId?: string };
    // commissionId is derived by walking parentId to the root.
    assert.equal(payload.commissionId, 'w-parent');
    assert.equal(payload.parentId, 'w-parent');
  });

  it('child mandate (parentId set) fires writ.mandate.<status> like any other writ', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const child = makeWrit({
      id: 'w-child',
      type: 'mandate',
      phase: 'open',
      parentId: 'w-parent-1',
    });
    const parent = makeWrit({
      id: 'w-parent-1',
      type: 'mandate',
      phase: 'open',
    });
    await writsBook.put(parent);
    await writsBook.put(child);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'create',
        ownerId: 'clerk',
        book: 'writs',
        entry: child,
      },
    );

    assert.deepEqual(await eventNames(), ['writ.mandate.open']);
  });

  it('commissionId walks multiple levels of parentId to the root', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const root = makeWrit({ id: 'w-root', type: 'mandate', phase: 'open' });
    const middle = makeWrit({
      id: 'w-mid',
      type: 'piece',
      phase: 'open',
      parentId: 'w-root',
    });
    const leaf = makeWrit({
      id: 'w-leaf',
      type: 'piece',
      phase: 'open',
      parentId: 'w-mid',
    });
    await writsBook.put(root);
    await writsBook.put(middle);
    await writsBook.put(leaf);

    await handleWritLifecycle(
      { clockworks: fix.clockworks, writsBook: fix.writsBook },
      {
        type: 'create',
        ownerId: 'clerk',
        book: 'writs',
        entry: leaf,
      },
    );

    const [ready] = await eventsByName('writ.piece.open');
    const payload = ready!.payload as { commissionId: string };
    assert.equal(payload.commissionId, 'w-root');
  });

  // ── Best-effort emission ───────────────────────────────────────────

  it('emission failure does not propagate (best-effort breadcrumb)', async () => {
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    const writ = makeWrit({ id: 'w-burn', phase: 'open' });
    await writsBook.put(writ);

    const failingClockworks: ClockworksApi = {
      async emit(): Promise<string> {
        throw new Error('events book write exploded');
      },
    };

    // Should not throw — must be swallowed with a `console.warn`.
    const originalWarn = console.warn;
    let warnCount = 0;
    console.warn = (..._args: unknown[]) => { warnCount++; };
    try {
      await handleWritLifecycle(
        { clockworks: failingClockworks, writsBook: fix.writsBook },
        {
          type: 'create',
          ownerId: 'clerk',
          book: 'writs',
          entry: writ,
        },
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warnCount >= 1, 'a console.warn breadcrumb must fire on emission failure');
  });
});
