/**
 * Reckoner — unit tests.
 *
 * Covers the predicate matrix from the commission brief:
 *
 *   - Root mandate stuck → one pulse (regardless of `status.spider`).
 *   - Child-writ transitions → no pulse (roots-only).
 *   - Cascaded root transition → one pulse with leaf cause parsed into
 *     the summary / childFailures context.
 *   - No startup backfill of pre-existing stuck / failed writs.
 *   - `failed` transitions always emit.
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

import { makeWritTypeApparatus } from '@shardworks/clerk-apparatus/testing';
import type { WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, BookEntry } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createLattice } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createReckoner } from './reckoner.ts';
import {
  TRIGGER_QUEUE_DRAINED,
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
} from './types.ts';

// ── Hand-rolled non-mandate writ type ─────────────────────────────
//
// Used by the multi-type test scenarios below. State names are
// deliberately non-overlapping with mandate (`pending` initial,
// `running` active, `done` terminal-success) so the tests prove the
// observer keys on classification — not on the literal `open`/
// `stuck`/`completed` strings.
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

// ── Test bootstrap ──────────────────────────────────────────────

interface EngineAttemptRow {
  startedAt?: string;
  endedAt?: string;
  status?: 'completed' | 'failed';
  error?: string;
  sessionId?: string;
}

interface EngineInstanceRow {
  id: string;
  designId: string;
  status: string;
  attemptCount?: number;
  attempts?: EngineAttemptRow[];
}

interface RigRow extends BookEntry {
  id: string;
  writId: string;
  status: 'running' | 'blocked' | 'stuck' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  engines?: EngineInstanceRow[];
}

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(
  kits: LoadedKit[],
  apparatuses: LoadedApparatus[] = [],
): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
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
   * Post a mandate writ and immediately publish it to `open` — mirrors
   * the auto-publish behavior the `commission-post` tool's UX layer
   * provides on top of the type-agnostic `clerk.post()` API. Tests use
   * this for the "writ that is queue-runnable" shorthand.
   */
  postOpen: (
    request: { title: string; body: string; type?: string; parentId?: string },
  ) => Promise<WritDoc>;
  seedRig: (writId: string, status?: RigRow['status']) => Promise<string>;
  /**
   * Insert a rig with the given engines. The rig is keyed to `writId`
   * with the requested status and an explicit `createdAt` (defaults to
   * "now" — newer than any earlier seed in the test). Useful for the
   * engine-failure context branches where the resolver picks the
   * most-recent failed rig.
   */
  seedRigWithEngines: (params: {
    writId: string;
    status?: RigRow['status'];
    engines: EngineInstanceRow[];
    createdAt?: string;
  }) => Promise<string>;
  rigCount: (writId: string) => Promise<number>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
}

async function buildFixture(
  options: {
    /**
     * Extra apparatuses to start *after* the Clerk but *before* the
     * Reckoner — used by multi-type tests to register a second writ
     * type via `makeWritTypeApparatus`. The apparatus's `start()`
     * runs while the Clerk's writ-type registration window is still
     * open, mirroring the production framework ordering.
     */
    extraApparatuses?: LoadedApparatus[];
  } = {},
): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice must be apparatus');
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner must be apparatus');

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
    config<T>(_pluginId: string): T {
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

  // Start stacks
  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure the three books exist so count / find calls succeed.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, { indexes: ['phase', 'type', 'createdAt', 'parentId'] });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, { indexes: ['sourceId', 'targetId'] });
  backend.ensureBook({ ownerId: 'spider', book: 'rigs' }, { indexes: ['status', 'writId', ['status', 'writId']] });
  backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, { indexes: ['triggerType', 'source', 'createdAt', 'deliveryState'] });

  // Start clerk
  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Start lattice (no channels — pulses trivially move to delivered).
  await latticePlugin.apparatus.start(buildCtx());
  const lattice = latticePlugin.apparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  // Start any extra apparatuses (e.g. test-only writ-type registrars)
  // before the Reckoner so the Clerk's registration window is still
  // open and the Reckoner sees the full registry on first read.
  for (const app of options.extraApparatuses ?? []) {
    const apparatus = app.apparatus as {
      start?: (ctx: StartupContext) => void | Promise<void>;
    };
    if (typeof apparatus.start === 'function') {
      await apparatus.start(buildCtx());
    }
  }

  // Start reckoner
  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');
  const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');

  async function postOpen(
    request: { title: string; body: string; type?: string; parentId?: string },
  ): Promise<WritDoc> {
    const writ = await clerk.post(request);
    // Mandate's only legal transition out of `new` is `open`. Non-
    // mandate writs are returned as-is in their declared initial
    // state — callers drive them forward explicitly.
    if (writ.type === 'mandate') {
      return clerk.transition(writ.id, 'open');
    }
    return writ;
  }

  async function seedRig(writId: string, status: RigRow['status'] = 'stuck'): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({ id, writId, status, createdAt: new Date().toISOString() });
    return id;
  }

  async function seedRigWithEngines(params: {
    writId: string;
    status?: RigRow['status'];
    engines: EngineInstanceRow[];
    createdAt?: string;
  }): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({
      id,
      writId: params.writId,
      status: params.status ?? 'failed',
      createdAt: params.createdAt ?? new Date().toISOString(),
      engines: params.engines,
    });
    return id;
  }

  async function rigCount(writId: string): Promise<number> {
    return rigsBook.count([['writId', '=', writId]]);
  }

  async function pulsesOf(triggerType?: string): Promise<PulseDoc[]> {
    const where = triggerType !== undefined ? [['triggerType', '=', triggerType] as const] : [];
    return pulsesBook.find({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: ['createdAt', 'asc'],
    });
  }

  return {
    stacks,
    clerk,
    lattice,
    postOpen,
    seedRig,
    seedRigWithEngines,
    rigCount,
    pulsesOf,
  };
}

async function stuckWith(
  fix: Fixture,
  writId: string,
  spiderStatus: { stuckCause?: string } | undefined,
): Promise<void> {
  await fix.stacks.transaction(async () => {
    await fix.clerk.transition(writId, 'stuck', { resolution: 'test stuck' });
    if (spiderStatus !== undefined) {
      await fix.clerk.setWritStatus(writId, 'spider', spiderStatus);
    }
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('Reckoner — writ-stuck emission', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  it('emits one pulse when a root mandate enters stuck (regardless of status.spider)', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await stuckWith(fix, writ.id, { stuckCause: 'failed-blocker' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
    assert.equal(pulses[0]?.writId, writ.id);
    assert.equal(pulses[0]?.source, 'reckoner');
  });

  it('emits for a stuck with no spider slot at all', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await fix.clerk.transition(writ.id, 'stuck', { resolution: 'raw' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
  });

  it('does not emit for a child writ transition (roots-only)', async () => {
    const parent = await fix.postOpen({ title: 'parent', body: 'p' });
    const child = await fix.postOpen({ title: 'child', body: 'c', parentId: parent.id });
    await stuckWith(fix, child.id, undefined);
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 0, 'children must not emit their own stuck pulse');
  });
});

describe('Reckoner — writ-failed emission', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  it('always emits when a root writ enters failed', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await fix.clerk.transition(writ.id, 'failed', { resolution: 'abandoned' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1);
    assert.equal(pulses[0]?.writId, writ.id);
    const context = pulses[0]?.context as { resolution?: string } | undefined;
    assert.equal(context?.resolution, 'abandoned');
  });

  it('surfaces cascaded leaf causes in the summary and context', async () => {
    // Drive only the child's failure — the Clerk's children-behavior
    // cascade engine (mandate's `anyFailure → failed` trigger with
    // `copyResolution: true`) carries the parent's terminal transition
    // end-to-end. The engine writes the triggering child id under the
    // parent's `status['clerk']` sub-slot before the cascaded transition,
    // and the Reckoner's emit path walks that chain at pulse time to
    // populate `context.childFailures` and the "Originated from child …"
    // summary fragment.
    const parent = await fix.postOpen({ title: 'parent', body: 'p' });
    const child = await fix.postOpen({ title: 'child', body: 'c', parentId: parent.id });
    await fix.clerk.transition(child.id, 'failed', { resolution: 'engine crashed' });

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1, 'root failed emits one pulse; child emits none');
    const pulse = pulses[0]!;
    assert.equal(pulse.writId, parent.id, 'pulse is keyed to the root, not the child');

    const ctx = pulse.context as { childFailures?: string[]; resolution?: string };
    assert.ok(ctx.resolution === 'engine crashed', 'resolution copies through the cascade');
    assert.ok(ctx.childFailures && ctx.childFailures.length > 0, 'leaf-cause chain is non-empty');
    // Each chain element is a short id (`w-…`). The chain length matches
    // the depth of the cascade — one for a single-level cascade.
    assert.ok(ctx.childFailures!.every((id) => id.startsWith('w-')));
    assert.ok(
      pulse.summary.includes('Originated from child'),
      'summary fragment names the leaf cause',
    );
  });

  it('multi-level cascade: chain reflects every triggering child id (root → mid → leaf)', async () => {
    // Three-level mandate cascade: a leaf grandchild fails, the
    // children-behavior engine cascades the failure up through the mid-
    // tier and root mandates. The root pulse's `childFailures` must list
    // the immediate child first and walk down through the chain.
    const root = await fix.postOpen({ title: 'root', body: 'r' });
    const mid = await fix.postOpen({ title: 'mid', body: 'm', parentId: root.id });
    const leaf = await fix.postOpen({ title: 'leaf', body: 'l', parentId: mid.id });

    await fix.clerk.transition(leaf.id, 'failed', { resolution: 'kaboom' });

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1, 'only the root mandate emits a writ-failed pulse');
    const pulse = pulses[0]!;
    assert.equal(pulse.writId, root.id);

    const ctx = pulse.context as { childFailures?: string[] };
    assert.ok(ctx.childFailures && ctx.childFailures.length === 2, 'chain holds two ids');

    // The chain walks outer→inner: root.status.clerk.triggeringChildId
    // is the mid mandate's short id; mid.status.clerk.triggeringChildId
    // is the leaf grandchild's short id.
    const [outer, inner] = ctx.childFailures!;
    assert.ok(mid.id.startsWith(outer!), 'outer chain id is the mid mandate');
    assert.ok(leaf.id.startsWith(inner!), 'inner chain id is the leaf');
  });

  it('does not emit for a child writ transitioning to failed (roots-only)', async () => {
    // Drive only the child's failure. The cascade engine drives the
    // parent to `failed`; that transition emits exactly one pulse — for
    // the parent (which is a root). The child itself emits no pulse, and
    // the pulse's writId is the parent's, not the child's.
    const parent = await fix.postOpen({ title: 'parent', body: 'p' });
    const child = await fix.postOpen({ title: 'child', body: 'c', parentId: parent.id });
    await fix.clerk.transition(child.id, 'failed', { resolution: 'engine crashed' });

    const failedPulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(
      failedPulses.length,
      1,
      'cascade lifts the parent and the parent emits — child itself does not',
    );
    assert.equal(
      failedPulses[0]?.writId,
      parent.id,
      'the only pulse is keyed to the root parent — child is not its own emit source',
    );
  });

  // ── Engine-failure context enrichment (D1, D3, D5, D6) ──────────

  it('attaches an engineFailure block when a failed rig has a failed engine', async () => {
    const writ = await fix.postOpen({ title: 'engine-fail mandate', body: 'b' });
    await fix.seedRigWithEngines({
      writId: writ.id,
      status: 'failed',
      engines: [
        { id: 'draft', designId: 'draft', status: 'completed' },
        {
          id: 'implement',
          designId: 'claude-code',
          status: 'failed',
          attemptCount: 3,
          attempts: [
            {
              startedAt: '2026-04-25T00:00:00.000Z',
              endedAt: '2026-04-25T00:01:00.000Z',
              status: 'failed',
              error: 'transient 1',
              sessionId: 's-1',
            },
            {
              startedAt: '2026-04-25T00:02:00.000Z',
              endedAt: '2026-04-25T00:03:00.000Z',
              status: 'failed',
              error: 'transient 2',
              sessionId: 's-2',
            },
            {
              startedAt: '2026-04-25T00:04:00.000Z',
              endedAt: '2026-04-25T00:05:00.000Z',
              status: 'failed',
              error: 'final boom',
              sessionId: 's-3',
            },
          ],
        },
      ],
    });
    await fix.clerk.transition(writ.id, 'failed', { resolution: 'engine exhausted' });

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as {
      engineFailure?: {
        rigId: string;
        engineId: string;
        engineDesignId: string;
        attemptCount?: number;
        lastError?: string;
        attemptsSummary: Array<{
          startedAt?: string;
          endedAt?: string;
          status?: string;
          error?: string;
          sessionId?: string;
        }>;
      };
    };
    assert.ok(ctx.engineFailure, 'engineFailure must be present');
    const ef = ctx.engineFailure!;
    assert.equal(ef.engineId, 'implement');
    assert.equal(ef.engineDesignId, 'claude-code');
    assert.equal(ef.attemptCount, 3);
    assert.equal(ef.lastError, 'final boom');
    assert.ok(typeof ef.rigId === 'string' && ef.rigId.length > 0);
    assert.equal(ef.attemptsSummary.length, 3);
    const tail = ef.attemptsSummary[2]!;
    assert.equal(tail.error, 'final boom');
    assert.equal(tail.sessionId, 's-3');
    assert.equal(tail.status, 'failed');
  });

  it('omits engineFailure when no rig exists for the failed writ', async () => {
    const writ = await fix.postOpen({ title: 'patron-fail', body: 'b' });
    await fix.clerk.transition(writ.id, 'failed', { resolution: 'patron abandoned' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { engineFailure?: unknown };
    assert.equal(ctx.engineFailure, undefined);
  });

  it('omits engineFailure when the rig is failed but no engine is failed', async () => {
    const writ = await fix.postOpen({ title: 'no-failed-engine', body: 'b' });
    await fix.seedRigWithEngines({
      writId: writ.id,
      status: 'failed',
      engines: [
        { id: 'a', designId: 'da', status: 'completed' },
        { id: 'b', designId: 'db', status: 'cancelled' },
      ],
    });
    await fix.clerk.transition(writ.id, 'failed', { resolution: 'rig wedged' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { engineFailure?: unknown };
    assert.equal(ctx.engineFailure, undefined);
  });

  it('picks the first failed engine when multiple are failed (D6)', async () => {
    const writ = await fix.postOpen({ title: 'multi-failed', body: 'b' });
    await fix.seedRigWithEngines({
      writId: writ.id,
      status: 'failed',
      engines: [
        { id: 'first', designId: 'd1', status: 'failed', attemptCount: 1 },
        { id: 'second', designId: 'd2', status: 'failed', attemptCount: 2 },
      ],
    });
    await fix.clerk.transition(writ.id, 'failed', { resolution: 'engine exhausted' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    const ctx = pulses[0]?.context as {
      engineFailure?: { engineId: string; attemptCount?: number };
    };
    assert.ok(ctx.engineFailure);
    assert.equal(ctx.engineFailure!.engineId, 'first');
    assert.equal(ctx.engineFailure!.attemptCount, 1);
  });
});

describe('Reckoner — no startup backfill', () => {
  afterEach(() => clearGuild());

  it('does not scan pre-existing stuck / failed writs on start', async () => {
    // Pre-seed a backend with a stuck and a failed writ before the
    // Reckoner ever starts, then start everything. No pulse should
    // appear — emission is transition-only.
    const backend = new MemoryBackend();
    const stacksPlugin = createStacksApparatus(backend);
    if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
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
    backend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {});
    backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, { indexes: ['triggerType'] });

    // Seed pre-existing stuck and failed writs directly in the book —
    // bypassing the clerk CDC path entirely.
    const writsBook = stacks.book<WritDoc>('clerk', 'writs');
    const now = new Date().toISOString();
    await writsBook.put({
      id: 'w-seed-stuck',
      type: 'mandate',
      phase: 'stuck',
      title: 'preseed stuck',
      body: '',
      createdAt: now,
      updatedAt: now,
    });
    await writsBook.put({
      id: 'w-seed-failed',
      type: 'mandate',
      phase: 'failed',
      title: 'preseed failed',
      body: '',
      resolvedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Start clerk, lattice, reckoner.
    const clerkPlugin = createClerk();
    if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
    await clerkPlugin.apparatus.start(buildCtx());
    apparatusMap.set('clerk', clerkPlugin.apparatus.provides);

    const latticePlugin = createLattice();
    if (!('apparatus' in latticePlugin)) throw new Error('lattice');
    await latticePlugin.apparatus.start(buildCtx());
    apparatusMap.set('lattice', latticePlugin.apparatus.provides);

    const reckonerPlugin = createReckoner();
    if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner');
    await reckonerPlugin.apparatus.start(buildCtx());

    const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');
    const count = await pulsesBook.count();
    assert.equal(count, 0, 'Reckoner must not backfill pulses from pre-existing writs');

    clearGuild();
  });
});

describe('Reckoner — multi-type guild', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture({
      extraApparatuses: [
        makeWritTypeApparatus([TASK_TYPE_CONFIG], { id: 'task-plugin' }),
      ],
    });
  });

  afterEach(() => clearGuild());

  it('drain stays false while a non-mandate writ is active-classified, then fires when it goes terminal', async () => {
    // A mandate plus a task; mandate goes terminal first. The task
    // is in `running` (active) — drain must not fire yet. Drive the
    // task to `done` (terminal-success) and drain fires, with
    // `lastTerminalWritId` naming the non-mandate writ.
    const mandate = await fix.postOpen({ title: 'mandate', body: '' });
    const task = await fix.clerk.post({ title: 'task', body: '', type: 'task' });
    await fix.clerk.transition(task.id, 'running');

    await fix.clerk.transition(mandate.id, 'completed', { resolution: 'done' });
    let pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'task is still active — drain must not fire');

    await fix.clerk.transition(task.id, 'done');
    pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1, 'drain fires when the last active writ goes terminal');
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, task.id, 'lastTerminalWritId names the non-mandate writ');
  });

  it('drain fires correctly on a non-mandate terminal transition (writ-failed cascade-shape)', async () => {
    // A task that fails — `failed` is a terminal-classified state on
    // the task type. countActive() drops to 0 → drain fires.
    const task = await fix.clerk.post({ title: 'orphan task', body: '', type: 'task' });
    await fix.clerk.transition(task.id, 'running');

    await fix.clerk.transition(task.id, 'failed', { resolution: 'task abandoned' });
    const drainPulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(drainPulses.length, 1);
    const ctx = drainPulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, task.id);
  });

  it('non-mandate writs do not emit writ-stuck or writ-failed pulses', async () => {
    // A task type does not even declare a state named `stuck`, but
    // it does declare `failed`. The brief mandates the stuck/failed
    // pulses stay mandate-only for v0 — verify the gate by driving a
    // task through its `failed` terminal.
    const task = await fix.clerk.post({ title: 'failing task', body: '', type: 'task' });
    await fix.clerk.transition(task.id, 'running');
    await fix.clerk.transition(task.id, 'failed', { resolution: 'engine crashed' });

    const failedPulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(failedPulses.length, 0, 'non-mandate failed must not emit writ-failed');

    const stuckPulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(stuckPulses.length, 0, 'non-mandate has no stuck phase to emit on');
  });

  it('pure-mandate parity: drain still fires when only mandates exist', async () => {
    // No task writs exist; a single mandate completes → drain fires
    // exactly as on a pure-mandate guild pre-T4.
    const mandate = await fix.postOpen({ title: 'lone mandate', body: '' });
    await fix.clerk.transition(mandate.id, 'completed', { resolution: 'done' });

    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, mandate.id);
  });

  it('orphan child blocks drain past parent cancellation, then drains on its own terminal', async () => {
    // Per the primer's obs-8 / brief: a cancelled mandate parent
    // with a non-mandate child whose type does not declare a
    // cascade-cancel transition leaves the child active. Drain must
    // remain false while the orphan is active and fire when the
    // orphan reaches its own terminal.
    const parent = await fix.postOpen({ title: 'parent mandate', body: '' });
    const child = await fix.clerk.post({
      title: 'orphan task',
      body: '',
      type: 'task',
      parentId: parent.id,
    });
    await fix.clerk.transition(child.id, 'running');

    // Cancel the parent. The task type has no cascade-cancel
    // transition, so the child stays in `running` (active).
    await fix.clerk.transition(parent.id, 'cancelled', { resolution: 'withdrawn' });
    let pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'orphan child holds drain back past parent cancellation');

    // Drive the child to its own terminal. Drain should fire.
    await fix.clerk.transition(child.id, 'done');
    pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, child.id);
  });
});
