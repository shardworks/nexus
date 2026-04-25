/**
 * Animator — session emission helper tests.
 *
 * Covers the four invocation sites required by the commission:
 *
 *   - session.started fires for newly-running sessions (via the helper)
 *   - session.ended fires for terminal sessions, with the agreed payload
 *   - commission.session.ended fires only when metadata.writId resolves
 *     to a root mandate (D6)
 *   - session.record-failed fires from the SessionDoc / transcript
 *     write-failure paths with `phase` from the catalog taxonomy
 *     (`'insert' | 'write-record' | 'update-row'`)
 *   - anima.manifested co-fires with session.started when metadata.role
 *     is set; anima.session.ended co-fires with session.ended on the
 *     same condition. Animator's responsibility for the anima.* family
 *     stops here — the catalog's other two (`anima.instantiated`,
 *     `anima.state.changed`) are deferred until the Roster lands.
 *
 * Plus the soft-dependency contract: when the Clockworks is not
 * installed, every helper silently no-ops and never throws (D12).
 *
 * The terminal-site coverage (in-process attached, detached, orphan
 * recovery, rate-limit pre-check rejection) is asserted in a separate
 * end-to-end animator-emission integration test
 * (`session-emission.integration.test.ts`) that drives the actual
 * dispatch paths.
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
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import type { ClockworksApi, EventDoc } from '@shardworks/clockworks-apparatus';

import {
  emitSessionEnded,
  emitSessionRecordFailed,
  emitSessionStarted,
} from './session-emission.ts';
import type { SessionDoc } from './types.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  clockworks: ClockworksApi;
  eventsBook: Book<EventDoc>;
  apparatusMap: Map<string, unknown>;
}

interface FixtureOptions {
  /** Set to false to omit the Clockworks — exercises the no-op contract (D12). */
  withClockworks?: boolean;
  /** Set to false to omit the Clerk — `commission.session.ended` then never fires. */
  withClerk?: boolean;
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const withClockworks = options.withClockworks ?? true;
  const withClerk = options.withClerk ?? true;

  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);

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

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');

  // Pre-create books the helpers / clerk read.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {});
  backend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });

  await stacksPlugin.apparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  let clerk: ClerkApi = undefined as unknown as ClerkApi;
  if (withClerk) {
    const clerkPlugin = createClerk();
    if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
    await clerkPlugin.apparatus.start({ on: () => {}, kits: () => [] });
    clerk = clerkPlugin.apparatus.provides as ClerkApi;
    apparatusMap.set('clerk', clerk);
  }

  // Build a thin ClockworksApi that writes directly to the events book.
  // Bypasses the signal validator and the rest of the apparatus
  // machinery — the helpers under test only call `emit()`.
  let clockworks: ClockworksApi = undefined as unknown as ClockworksApi;
  if (withClockworks) {
    clockworks = {
      async emit(name, payload, emitter) {
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
  }

  return { stacks, clerk, clockworks, eventsBook, apparatusMap };
}

function makeSessionDoc(overrides: Partial<SessionDoc>): SessionDoc {
  const startedAt = new Date().toISOString();
  return {
    id: 'ses-test-001',
    status: 'running',
    startedAt,
    provider: 'claude-code',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Animator — session emission helper', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  async function findEvents(name: string): Promise<EventDoc[]> {
    return fix.eventsBook.find({
      where: [['name', '=', name]],
      orderBy: ['firedAt', 'asc'],
    }) as Promise<EventDoc[]>;
  }

  // ── session.started ────────────────────────────────────────────────

  it('emitSessionStarted fires session.started with metadata-derived anima/trigger', async () => {
    const doc = makeSessionDoc({
      id: 'ses-start-1',
      metadata: { role: 'artificer', trigger: 'summon' },
    });
    await emitSessionStarted(doc);

    const [event] = await findEvents('session.started');
    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-start-1');
    assert.equal(payload.anima, 'artificer');
    assert.equal(payload.trigger, 'summon');
    // Deliberately omitted per D7.
    assert.ok(!('workshop' in payload));
    assert.ok(!('workspaceKind' in payload));
  });

  it('emitSessionStarted omits anima/trigger when metadata is absent', async () => {
    await emitSessionStarted(makeSessionDoc({ id: 'ses-bare' }));
    const [event] = await findEvents('session.started');
    const payload = event!.payload as Record<string, unknown>;
    assert.ok(!('anima' in payload));
    assert.ok(!('trigger' in payload));
  });

  // ── anima.manifested ───────────────────────────────────────────────

  it('emitSessionStarted co-emits anima.manifested when metadata.role is set', async () => {
    const doc = makeSessionDoc({
      id: 'ses-anima-1',
      metadata: { role: 'artificer', trigger: 'summon' },
    });
    await emitSessionStarted(doc);

    const [manifested] = await findEvents('anima.manifested');
    assert.ok(manifested, 'anima.manifested must fire when role is present');
    const payload = manifested.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-anima-1');
    assert.equal(payload.anima, 'artificer');
    assert.equal(payload.trigger, 'summon');
  });

  it('emitSessionStarted does NOT emit anima.manifested when metadata.role is absent', async () => {
    await emitSessionStarted(makeSessionDoc({ id: 'ses-no-role' }));
    const events = await findEvents('anima.manifested');
    assert.equal(events.length, 0);
  });

  // ── session.ended + commission.session.ended ───────────────────────

  it('emitSessionEnded fires session.ended with terminal-payload fields', async () => {
    await emitSessionEnded({
      id: 'ses-end-1',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      costUsd: 0.42,
      metadata: { role: 'artificer' },
    });

    const [event] = await findEvents('session.ended');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-end-1');
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.durationMs, 60_000);
    assert.equal(payload.costUsd, 0.42);
    assert.equal(payload.anima, 'artificer');
  });

  it('emitSessionEnded co-emits anima.session.ended when metadata.role is set', async () => {
    await emitSessionEnded({
      id: 'ses-anima-end-1',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: { role: 'artificer' },
    });

    const [animaEnded] = await findEvents('anima.session.ended');
    assert.ok(animaEnded, 'anima.session.ended must fire when role is present');
    const payload = animaEnded.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-anima-end-1');
    assert.equal(payload.anima, 'artificer');
  });

  it('emitSessionEnded does NOT emit anima.session.ended when metadata.role is absent', async () => {
    await emitSessionEnded({
      id: 'ses-end-no-role',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: {},
    });
    const events = await findEvents('anima.session.ended');
    assert.equal(events.length, 0);
  });

  it('emitSessionEnded fires commission.session.ended when writId resolves to a root mandate', async () => {
    const root = await fix.clerk.post({ title: 'root', body: 'b' });

    await emitSessionEnded({
      id: 'ses-end-2',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: { role: 'artificer', writId: root.id },
    });

    const [end] = await findEvents('session.ended');
    const [comEnd] = await findEvents('commission.session.ended');
    assert.ok(end);
    assert.ok(comEnd);
    const comPayload = comEnd!.payload as Record<string, unknown>;
    assert.equal(comPayload.commissionId, root.id);
    assert.equal(comPayload.sessionId, 'ses-end-2');
  });

  it('emitSessionEnded fires commission.session.ended when writId is a child of a root mandate', async () => {
    const root = await fix.clerk.post({ title: 'root', body: 'b' });
    const child = await fix.clerk.post({
      title: 'child',
      body: 'b',
      type: 'mandate',
      parentId: root.id,
    });

    await emitSessionEnded({
      id: 'ses-end-3',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: { writId: child.id },
    });

    const [comEnd] = await findEvents('commission.session.ended');
    assert.ok(comEnd);
    const comPayload = comEnd!.payload as Record<string, unknown>;
    assert.equal(comPayload.commissionId, root.id);
  });

  it('emitSessionEnded does NOT fire commission.session.ended when metadata.writId is absent', async () => {
    await emitSessionEnded({
      id: 'ses-end-4',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: {},
    });

    const sessionEnd = await findEvents('session.ended');
    const comEnd = await findEvents('commission.session.ended');
    assert.equal(sessionEnd.length, 1);
    assert.equal(comEnd.length, 0);
  });

  it('emitSessionEnded does NOT fire commission.session.ended when the chain dead-ends at a non-mandate root', async () => {
    // Pre-seed the writs book with a writ whose type is NOT 'mandate'
    // and which has no parent. The emit should fire session.ended only.
    const writsBook = fix.stacks.book<WritDoc>('clerk', 'writs');
    await writsBook.put({
      id: 'w-task-1',
      type: 'task',
      phase: 'open',
      title: 'task root',
      body: 'b',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await emitSessionEnded({
      id: 'ses-end-5',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: { writId: 'w-task-1' },
    });

    assert.equal((await findEvents('session.ended')).length, 1);
    assert.equal((await findEvents('commission.session.ended')).length, 0);
  });

  // ── session.record-failed ──────────────────────────────────────────

  it('emitSessionRecordFailed fires with phase=insert and an error message', async () => {
    await emitSessionRecordFailed(
      'ses-fail-1',
      'insert',
      new Error('disk full'),
    );

    const [event] = await findEvents('session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-fail-1');
    assert.equal(payload.phase, 'insert');
    assert.equal(payload.error, 'disk full');
  });

  it('emitSessionRecordFailed fires with phase=update-row', async () => {
    await emitSessionRecordFailed(
      'ses-fail-2',
      'update-row',
      new Error('row clobbered'),
    );

    const [event] = await findEvents('session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.phase, 'update-row');
    assert.equal(payload.error, 'row clobbered');
  });

  it('emitSessionRecordFailed fires with phase=write-record', async () => {
    await emitSessionRecordFailed(
      'ses-fail-3',
      'write-record',
      'transcript-write-error',
    );

    const [event] = await findEvents('session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.phase, 'write-record');
    assert.equal(payload.error, 'transcript-write-error');
  });

  // ── No-clockworks soft dependency (D12) ────────────────────────────

  it('helpers silently no-op when Clockworks is not installed', async () => {
    clearGuild();
    const noCw = await buildFixture({ withClockworks: false });
    fix = noCw;

    // None of these should throw — and there should be no observable
    // event row even if there were a way to read one.
    await emitSessionStarted(makeSessionDoc({ id: 'ses-no-cw' }));
    await emitSessionEnded({
      id: 'ses-no-cw',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: { writId: 'something' },
    });
    await emitSessionRecordFailed('ses-no-cw', 'insert', new Error('x'));

    // The events book has no rows (and silence is the contract).
    assert.equal(await fix.eventsBook.count(), 0);
  });
});
