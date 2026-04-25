/**
 * Reckoner — drain emission tests.
 *
 * Post-T4 the drain predicate is classification-driven:
 *
 *     countActive() === 0  AND  rig count (running | blocked) === 0.
 *
 * `countActive()` walks the writ-type registry and returns the number
 * of writs in any `active`-classified state across every registered
 * type. Mandate's `stuck` is classified `active`, so a stuck mandate
 * holds drain back. There is no dedupe across bursts in MVP.
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
import type { StacksApi, BookEntry } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';
import { makeWritTypeApparatus } from '@shardworks/clerk-apparatus/testing';

import { createLattice } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createReckoner } from './reckoner.ts';
import { TRIGGER_QUEUE_DRAINED } from './types.ts';

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
  /**
   * Post a mandate writ and immediately publish it to `open` — the
   * "writ that is queue-runnable" shorthand used across the suite.
   */
  postOpen: (
    request: { title: string; body: string; type?: string; parentId?: string },
  ) => Promise<WritDoc>;
  seedRig: (writId: string, status: RigRow['status']) => Promise<string>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
}

async function buildFixture(
  options: {
    /**
     * Extra apparatuses to start *after* the Clerk but *before* the
     * Reckoner — the multi-type test path uses
     * `makeWritTypeApparatus` here to register a second writ type.
     */
    extraApparatuses?: LoadedApparatus[];
  } = {},
): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice');
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner');

  const apparatusMap = new Map<string, unknown>();
  const fakeGuild: Guild = {
    home: '/tmp/test',
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
      return { name: 't', nexus: '0', plugins: [] };
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

  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, { indexes: ['phase'] });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {});
  backend.ensureBook({ ownerId: 'spider', book: 'rigs' }, { indexes: ['status', 'writId'] });
  backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, { indexes: ['triggerType'] });

  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  await latticePlugin.apparatus.start(buildCtx());
  const lattice = latticePlugin.apparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  for (const app of options.extraApparatuses ?? []) {
    const apparatus = app.apparatus as {
      start?: (ctx: StartupContext) => void | Promise<void>;
    };
    if (typeof apparatus.start === 'function') {
      await apparatus.start(buildCtx());
    }
  }

  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');
  const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');

  async function postOpen(
    request: { title: string; body: string; type?: string; parentId?: string },
  ): Promise<WritDoc> {
    const writ = await clerk.post(request);
    if (writ.type === 'mandate') {
      return clerk.transition(writ.id, 'open');
    }
    return writ;
  }

  async function seedRig(writId: string, status: RigRow['status']): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({ id, writId, status, createdAt: new Date().toISOString() });
    return id;
  }
  async function pulsesOf(triggerType?: string): Promise<PulseDoc[]> {
    const where = triggerType !== undefined ? [['triggerType', '=', triggerType] as const] : [];
    return pulsesBook.find({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: ['createdAt', 'asc'],
    });
  }

  return { stacks, clerk, lattice, postOpen, seedRig, pulsesOf };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Reckoner — queue-drained emission', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  it('fires on the terminal transition that takes open to zero', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    // Starts in `open`. Complete it → open count becomes 0.
    await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, writ.id);
  });

  it('does not fire while open > 0 (another writ is still runnable)', async () => {
    const writA = await fix.postOpen({ title: 'A', body: '' });
    const _writB = await fix.postOpen({ title: 'B', body: '' });
    await fix.clerk.transition(writA.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0);
  });

  it('does not fire while active rigs remain (running or blocked)', async () => {
    const writA = await fix.postOpen({ title: 'A', body: '' });
    const writB = await fix.postOpen({ title: 'B', body: '' });
    await fix.seedRig(writB.id, 'running');
    // Finish A; B is in `open` phase with a running rig → not drained.
    await fix.clerk.transition(writA.id, 'completed', { resolution: 'done' });

    // Now close B — but pretend the running rig lingers. open becomes 0
    // but a running rig is still around, so we are still not drained.
    await fix.clerk.transition(writB.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'running rig holds the drain back');
  });

  it('does not fire while a mandate is parked in stuck (stuck is active-classified)', async () => {
    // Post-T4, drain reads the Clerk's classification-aware
    // countActive(). Mandate's `stuck` is classified `active`, so a
    // stuck mandate holds drain back even when no rigs are running.
    // (Pre-T4 the predicate keyed on the literal `phase = 'open'`
    // count and did not block on stuck — that was the mismeasure
    // T4 closes.)
    const stuck = await fix.postOpen({ title: 'stuck', body: '' });
    await fix.clerk.transition(stuck.id, 'stuck', { resolution: 'no progress' });
    const good = await fix.postOpen({ title: 'good', body: '' });
    await fix.clerk.transition(good.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'stuck mandate is active and blocks drain');

    // Drive the stuck writ to a terminal state — drain should fire.
    await fix.clerk.transition(stuck.id, 'failed', { resolution: 'abandoned' });
    const after = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(after.length, 1, 'drain fires once the stuck mandate goes terminal');
    const ctx = after[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, stuck.id);
  });

  it('also fires on a cancel transition that drains the queue', async () => {
    const writ = await fix.postOpen({ title: 'w', body: '' });
    await fix.clerk.transition(writ.id, 'cancelled', { resolution: 'withdrawn' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
  });
});

describe('Reckoner — drain on a multi-type guild', () => {
  // A second writ type whose state names are deliberately
  // non-overlapping with mandate (`pending` initial, `running`
  // active, `done` terminal-success) so the test proves the drain
  // predicate keys on classification — not on the literal `open`.
  const TASK_TYPE_CONFIG: WritTypeConfig = {
    name: 'task',
    states: [
      { name: 'pending', classification: 'initial', allowedTransitions: ['running', 'cancelled'] },
      { name: 'running', classification: 'active', allowedTransitions: ['done', 'failed', 'cancelled'] },
      { name: 'done', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
      { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
      { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
    ],
  };

  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture({
      extraApparatuses: [
        makeWritTypeApparatus([TASK_TYPE_CONFIG], { id: 'task-plugin' }),
      ],
    });
  });

  afterEach(() => clearGuild());

  it('does not fire while a structurally-different type has any active-classified writ', async () => {
    // Mandate is in `open` (active). Task is in `running` (active
    // on the task type). Drive the mandate terminal — drain must
    // not fire because the task is still active-classified, even
    // though no mandate writ is in `open` anymore.
    const mandate = await fix.postOpen({ title: 'mandate', body: '' });
    const task = await fix.clerk.post({ title: 'task', body: '', type: 'task' });
    await fix.clerk.transition(task.id, 'running');

    await fix.clerk.transition(mandate.id, 'completed', { resolution: 'done' });
    let pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'task `running` is active-classified and blocks drain');

    // Now drive the task to its terminal. countActive() drops to 0
    // → drain fires, with the non-mandate writ as the trigger.
    await fix.clerk.transition(task.id, 'done');
    pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, task.id);
  });
});
