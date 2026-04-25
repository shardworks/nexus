/**
 * Reckoner — idempotency under CDC replay.
 *
 * Drives the exported `handleWritChange` helper directly with synthetic
 * `update` events to simulate a duplicated Phase 2 CDC delivery. For each
 * of the three trigger types, the same event delivered twice must produce
 * exactly one pulse row. A legitimate re-transition (writ enters stuck,
 * re-opens, enters stuck again — with a fresh `updatedAt`) must still
 * produce a second pulse (the positive control).
 *
 * Harness reuses the fixture shape from `reckoner.test.ts` — the CDC
 * watcher registered inside `createReckoner().start()` is inert for the
 * synthetic events here because we invoke the helper directly instead of
 * going through `clerk.transition()`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  KitEntry,
  LoadedApparatus,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, BookEntry, ReadOnlyBook, UpdateEvent } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createLattice } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createClockworksRetry } from '@shardworks/clockworks-retry-apparatus';
import type { ClockworksRetryApi } from '@shardworks/clockworks-retry-apparatus';

import {
  createReckoner,
  handleWritChange,
  type ReckonerObserverDeps,
} from './reckoner.ts';
import {
  TRIGGER_QUEUE_DRAINED,
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
} from './types.ts';

// ── Fixture ────────────────────────────────────────────────────

interface RigRow extends BookEntry {
  id: string;
  writId: string;
  status: 'running' | 'blocked' | 'stuck' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}

function buildCtx(entries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...entries.filter((e) => e.type === type)];
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  lattice: LatticeApi;
  deps: ReckonerObserverDeps;
  seedRig: (writId: string, status?: RigRow['status']) => Promise<string>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
  pulsesBook: ReadOnlyBook<PulseDoc>;
}

async function buildFixture(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();
  const retryPlugin = createClockworksRetry();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice must be apparatus');
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner must be apparatus');
  if (!('apparatus' in retryPlugin)) throw new Error('retry must be apparatus');

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
    config<T>(_id: string): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return guildConfig;
    },
    kits(): LoadedKit[] {
      return [];
    },
    apparatuses(): LoadedApparatus[] {
      return [];
    },
    failedPlugins() {
      return [];
    },
    startupWarnings() {
      return [];
    },
  };

  setGuild(fakeGuild);

  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, { indexes: ['phase', 'type', 'createdAt', 'parentId'] });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, { indexes: ['sourceId', 'targetId'] });
  backend.ensureBook({ ownerId: 'spider', book: 'rigs' }, { indexes: ['status', 'writId', ['status', 'writId']] });
  backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, { indexes: ['triggerType', 'source', 'createdAt', 'deliveryState', 'writId'] });

  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  await latticePlugin.apparatus.start(buildCtx());
  const lattice = latticePlugin.apparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  await retryPlugin.apparatus.start(buildCtx());
  apparatusMap.set('clockworks-retry', retryPlugin.apparatus.provides as ClockworksRetryApi);

  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.readBook<RigRow>('spider', 'rigs');
  const pulsesBook = stacks.readBook<PulseDoc>('lattice', 'pulses');
  const writableRigs = stacks.book<RigRow>('spider', 'rigs');
  const writablePulses = stacks.book<PulseDoc>('lattice', 'pulses');

  async function seedRig(writId: string, status: RigRow['status'] = 'stuck'): Promise<string> {
    const id = generateId('rig', 4);
    await writableRigs.put({ id, writId, status, createdAt: new Date().toISOString() });
    return id;
  }

  async function pulsesOf(triggerType?: string): Promise<PulseDoc[]> {
    const where = triggerType !== undefined ? [['triggerType', '=', triggerType] as const] : [];
    return writablePulses.find({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: ['createdAt', 'asc'],
    });
  }

  const deps: ReckonerObserverDeps = {
    lattice,
    clerk,
    rigsBook,
    pulsesBook,
    resolveMaxAttempts: () => 2,
  };

  return { stacks, clerk, lattice, deps, seedRig, pulsesOf, pulsesBook };
}

/**
 * Build a synthetic CDC `update` event for a writ phase transition. The
 * triggering writ is materialized with a fresh `updatedAt` at `now` so
 * the dedupe identity is stable across both deliveries of the event.
 */
function makeUpdateEvent(params: {
  entry: WritDoc;
  prevPhase: WritDoc['phase'];
}): UpdateEvent<WritDoc> {
  const prev: WritDoc = { ...params.entry, phase: params.prevPhase };
  return {
    type: 'update',
    ownerId: 'clerk',
    book: 'writs',
    entry: params.entry,
    prev,
  };
}

/**
 * Read a writ from the writs book and guarantee it exists.
 */
async function mustWrit(fix: Fixture, id: string): Promise<WritDoc> {
  return fix.deps.clerk.show(id);
}

// ── Tests ──────────────────────────────────────────────────────

describe('Reckoner — idempotency under CDC replay', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  it('writ-stuck: same transition replayed twice yields exactly one pulse', async () => {
    // Use the real Clerk API to create the writ in `open` phase, then
    // invoke the observer helper directly with a synthetic update event
    // that fires twice — simulating a duplicated Phase 2 delivery.
    const writ = await fix.clerk.post({ title: 'stuck mandate', body: 'b' });

    // Pretend the writ is now in `stuck` phase with a non-retryable spider
    // status so `isTerminalStuck` returns true.
    const entry: WritDoc = {
      ...writ,
      phase: 'stuck',
      updatedAt: '2026-04-23T10:00:00.000Z',
      status: { spider: { retryable: false, stuckCause: 'engine-failure' } },
    };
    const event = makeUpdateEvent({ entry, prevPhase: 'open' });

    await handleWritChange(fix.deps, event);
    await handleWritChange(fix.deps, event);

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1, 'replay must not duplicate writ-stuck');
    assert.equal(pulses[0]?.writId, writ.id);
    const ctx = pulses[0]?.context as { writUpdatedAt?: string };
    assert.equal(
      ctx.writUpdatedAt,
      entry.updatedAt,
      'dedupe-identity field must be persisted to pulse.context',
    );
  });

  it('writ-failed: same transition replayed twice yields exactly one pulse', async () => {
    const writ = await fix.clerk.post({ title: 'failing mandate', body: 'b' });
    const entry: WritDoc = {
      ...writ,
      phase: 'failed',
      updatedAt: '2026-04-23T11:00:00.000Z',
      resolution: 'abandoned',
    };
    const event = makeUpdateEvent({ entry, prevPhase: 'open' });

    await handleWritChange(fix.deps, event);
    await handleWritChange(fix.deps, event);

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1, 'replay must not duplicate writ-failed');
    assert.equal(pulses[0]?.writId, writ.id);
    const ctx = pulses[0]?.context as { writUpdatedAt?: string };
    assert.equal(ctx.writUpdatedAt, entry.updatedAt);
  });

  it('queue-drained: same terminal transition replayed twice yields exactly one pulse', async () => {
    // Drive a real completion through Clerk so the writ ends up in the
    // book with phase=completed. That also fires the real CDC once and
    // may leave a drain pulse behind (open=0, rigs=0 ⇒ drained). We
    // snapshot the pulses book and then replay the synthetic event —
    // the second delivery must NOT add a second drain pulse.
    const writ = await fix.clerk.post({ title: 'draining mandate', body: 'b' });
    await fix.clerk.transition(writ.id, 'open');
    await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

    // After the real CDC ran once, there should be exactly one drain
    // pulse (no open writs, no active rigs).
    const afterReal = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(afterReal.length, 1, 'real CDC transition produces one drain pulse');

    // Construct the synthetic "same event" — same entry + prev — and
    // drive the helper with it.
    const persisted = await mustWrit(fix, writ.id);
    const event = makeUpdateEvent({ entry: persisted, prevPhase: 'open' });

    await handleWritChange(fix.deps, event);
    await handleWritChange(fix.deps, event);

    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(
      pulses.length,
      1,
      'replay (twice, after real CDC) must not duplicate queue-drained',
    );
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string; writUpdatedAt?: string };
    assert.equal(ctx.lastTerminalWritId, writ.id);
    assert.equal(ctx.writUpdatedAt, persisted.updatedAt);
  });

  it('positive control: a re-transition with a fresh updatedAt emits a second pulse', async () => {
    // A writ goes stuck, is re-opened, then goes stuck again. Each
    // stuck has its own fresh `updatedAt` — the dedupe identity is a
    // per-transition key, not a per-phase-pair key, so the second
    // stuck must still emit a pulse.
    const writ = await fix.clerk.post({ title: 'flap mandate', body: 'b' });

    const firstStuck: WritDoc = {
      ...writ,
      phase: 'stuck',
      updatedAt: '2026-04-23T12:00:00.000Z',
      status: { spider: { retryable: false } },
    };
    await handleWritChange(fix.deps, makeUpdateEvent({ entry: firstStuck, prevPhase: 'open' }));

    const secondStuck: WritDoc = {
      ...writ,
      phase: 'stuck',
      updatedAt: '2026-04-23T12:05:00.000Z', // fresh updatedAt
      status: { spider: { retryable: false } },
    };
    await handleWritChange(fix.deps, makeUpdateEvent({ entry: secondStuck, prevPhase: 'open' }));

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(
      pulses.length,
      2,
      're-transition with a new updatedAt must produce a second pulse',
    );
    const stamps = pulses
      .map((p) => (p.context as { writUpdatedAt?: string }).writUpdatedAt)
      .sort();
    assert.deepEqual(stamps, [firstStuck.updatedAt, secondStuck.updatedAt]);
  });

  it('persistence: dedupe survives a process restart (guard reads the pulses book)', async () => {
    // Emit once, simulate a restart by rebuilding the Reckoner-side
    // deps against a NEW helper instance while the pulses book carries
    // over the prior emission. A second delivery of the same synthetic
    // event must still be suppressed.
    const writ = await fix.clerk.post({ title: 'restart mandate', body: 'b' });
    const entry: WritDoc = {
      ...writ,
      phase: 'stuck',
      updatedAt: '2026-04-23T13:00:00.000Z',
      status: { spider: { retryable: false } },
    };
    const event = makeUpdateEvent({ entry, prevPhase: 'open' });

    await handleWritChange(fix.deps, event);

    // Rebuild the deps — same pulses book, fresh deps object. Because
    // the dedupe check hits the persisted book, the second invocation
    // is suppressed exactly as it would be after a process restart.
    const restartedDeps: ReckonerObserverDeps = {
      lattice: fix.deps.lattice,
      clerk: fix.deps.clerk,
      rigsBook: fix.deps.rigsBook,
      pulsesBook: fix.deps.pulsesBook,
      resolveMaxAttempts: () => 2,
    };
    await handleWritChange(restartedDeps, event);

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1, 'persisted pulses-book row must suppress replay across restart');
  });
});
