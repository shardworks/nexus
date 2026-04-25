/**
 * Clockworks — writ-lifecycle and commission CDC observer tests.
 *
 * Drives `handleWritLifecycle` directly with synthetic ChangeEvents so
 * the assertions stay focused on (a) the phase → catalog-suffix mapping
 * (D2/D3/D17), (b) root-mandate gating for commission events
 * (D5/D15/D19), (c) the parentId walk for `commissionId` (D4), and
 * (d) the best-effort emission contract (D13).
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

describe('Clockworks — writ-lifecycle observer', () => {
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

  // ── Writ-lifecycle (root mandate) ──────────────────────────────────

  it('create-in-open root mandate → mandate.ready and commission.posted', async () => {
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

    assert.deepEqual(await eventNames(), [
      'mandate.ready',
      'commission.posted',
      'commission.state.changed',
    ]);

    const [ready] = await eventsByName('mandate.ready');
    assert.ok(ready);
    const payload = ready.payload as Record<string, unknown>;
    assert.equal(payload.writId, 'w-root-1');
    assert.equal(payload.commissionId, 'w-root-1');
    assert.equal(payload.phase, 'open');
    assert.equal(ready.emitter, 'framework');
  });

  it('new → open transition (publish) re-emits ready and commission.posted', async () => {
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

    assert.deepEqual(await eventNames(), [
      'mandate.ready',
      'commission.posted',
      'commission.state.changed',
    ]);
  });

  it('stuck → open re-entry re-emits mandate.ready (D21 — no first-time-only tracking)', async () => {
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

    const names = await eventNames();
    assert.ok(names.includes('mandate.ready'));
    // `commission.posted` ALSO re-fires per D15 — entry into `open` is the trigger.
    assert.ok(names.includes('commission.posted'));
  });

  it('open → completed root mandate fires sealed AND completed (D5 duplicate is intentional)', async () => {
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

    const names = await eventNames();
    assert.ok(names.includes('mandate.completed'));
    assert.ok(names.includes('commission.state.changed'));
    assert.ok(names.includes('commission.sealed'));
    assert.ok(names.includes('commission.completed'));
    // No `commission.posted` for completion — D15 gates `posted` to entry into `open`.
    assert.ok(!names.includes('commission.posted'));
  });

  it('open → failed root mandate fires mandate.failed and commission.failed', async () => {
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

    const names = await eventNames();
    assert.deepEqual(names, [
      'mandate.failed',
      'commission.state.changed',
      'commission.failed',
    ]);
    const [bust] = await eventsByName('commission.failed');
    assert.equal(
      (bust!.payload as { resolution?: string }).resolution,
      'no good',
    );
  });

  it('open → stuck root mandate fires mandate.stuck and commission.state.changed', async () => {
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

    const names = await eventNames();
    assert.deepEqual(names, ['mandate.stuck', 'commission.state.changed']);
    // No `commission.failed` — stuck is NOT terminal.
    assert.ok(!names.includes('commission.failed'));
  });

  // ── Silent phases (D3 / D17) ───────────────────────────────────────

  it('transitions into cancelled produce NO event row (D3)', async () => {
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

    assert.deepEqual(await eventNames(), []);
  });

  it('draft creation (entry into new) produces NO event row (D17)', async () => {
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

    assert.deepEqual(await eventNames(), []);
  });

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

  // ── Non-mandate writs / non-root writs (D5 / D19) ──────────────────

  it('non-mandate writ types fire {type}.ready but NOT commission.* events', async () => {
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

    const names = await eventNames();
    assert.deepEqual(names, ['piece.ready']);
    assert.ok(!names.some((n) => n.startsWith('commission.')));

    const [ready] = await eventsByName('piece.ready');
    const payload = ready!.payload as { commissionId: string; parentId?: string };
    // commissionId is derived by walking parentId to the root.
    assert.equal(payload.commissionId, 'w-parent');
    assert.equal(payload.parentId, 'w-parent');
  });

  it('child mandate (parentId set) fires mandate.ready but NOT commission.posted', async () => {
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

    const names = await eventNames();
    assert.ok(names.includes('mandate.ready'));
    assert.ok(!names.includes('commission.posted'));
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

    const [ready] = await eventsByName('piece.ready');
    const payload = ready!.payload as { commissionId: string };
    assert.equal(payload.commissionId, 'w-root');
  });

  // ── Best-effort emission ───────────────────────────────────────────

  it('emission failure does not propagate (best-effort per D13)', async () => {
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
