/**
 * Reckoner — unit tests.
 *
 * Covers the predicate matrix from the commission brief:
 *
 *   - Retryable-under-cap stuck → no pulse.
 *   - Retryable-at-cap stuck → one pulse.
 *   - Non-retryable stuck → one pulse.
 *   - Missing retryable flag → one pulse (fail-safe terminal).
 *   - Child-writ transitions → no pulse (roots-only).
 *   - Cascaded root transition → one pulse with leaf cause parsed into
 *     the summary / childFailures context.
 *   - clockworks-retry absent → every stuck is terminal.
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

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, BookEntry } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createLattice } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createClockworksRetry } from '@shardworks/clockworks-retry-apparatus';
import type { ClockworksRetryApi } from '@shardworks/clockworks-retry-apparatus';

import { createReckoner } from './reckoner.ts';
import {
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
} from './types.ts';

// ── Test bootstrap ──────────────────────────────────────────────

interface RigRow extends BookEntry {
  id: string;
  writId: string;
  status: 'running' | 'blocked' | 'stuck' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
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
  rigCount: (writId: string) => Promise<number>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
}

async function buildFixture(options: { withRetry?: boolean } = {}): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();
  const retryPlugin = options.withRetry !== false ? createClockworksRetry() : null;

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

  // Optionally start clockworks-retry so the Reckoner can resolve
  // maxAttempts. When absent, every stuck is terminal from the
  // Reckoner's viewpoint (D16).
  if (retryPlugin !== null) {
    if (!('apparatus' in retryPlugin)) throw new Error('retry must be apparatus');
    await retryPlugin.apparatus.start(buildCtx());
    const retry = retryPlugin.apparatus.provides as ClockworksRetryApi;
    apparatusMap.set('clockworks-retry', retry);
  }

  // Start reckoner
  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');
  const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');

  async function postOpen(
    request: { title: string; body: string; type?: string; parentId?: string },
  ): Promise<WritDoc> {
    const writ = await clerk.post(request);
    return clerk.transition(writ.id, 'open');
  }

  async function seedRig(writId: string, status: RigRow['status'] = 'stuck'): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({ id, writId, status, createdAt: new Date().toISOString() });
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

  return { stacks, clerk, lattice, postOpen, seedRig, rigCount, pulsesOf };
}

async function stuckWith(
  fix: Fixture,
  writId: string,
  spiderStatus: { retryable?: boolean; stuckCause?: string; detail?: string } | undefined,
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

  it('emits nothing when a retryable stuck is under the cap', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await fix.seedRig(writ.id, 'stuck');
    await stuckWith(fix, writ.id, {
      stuckCause: 'engine-failure',
      retryable: true,
      detail: 'session crashed',
    });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 0, 'retryable-under-cap stuck must not emit');
  });

  it('emits exactly one pulse when a retryable stuck is at cap', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    // Pre-load cap-many rigs.
    await fix.seedRig(writ.id, 'stuck');
    await fix.seedRig(writ.id, 'stuck');
    assert.equal(await fix.rigCount(writ.id), 2);
    await stuckWith(fix, writ.id, {
      stuckCause: 'engine-failure',
      retryable: true,
      detail: 'session crashed',
    });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
    assert.equal(pulses[0]?.writId, writ.id);
    assert.equal(pulses[0]?.source, 'reckoner');
  });

  it('emits for non-retryable stuck regardless of rig count', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await fix.seedRig(writ.id, 'stuck');
    await stuckWith(fix, writ.id, {
      stuckCause: 'engine-failure',
      retryable: false,
      detail: 'bad input',
    });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
  });

  it('emits for a stuck with no retryable flag (fail-safe terminal)', async () => {
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    await fix.seedRig(writ.id, 'stuck');
    // Stuck with a spider slot that lacks `retryable`.
    await stuckWith(fix, writ.id, { stuckCause: 'cycle' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
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
    await stuckWith(fix, child.id, { retryable: false });
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
    // Auto-cascade was retired with the Clerk's children-behavior
    // refactor; tests now drive both legs of the cascade explicitly
    // (child fails first, then the caller fails the parent with a
    // cascade-shaped resolution string). The Reckoner's emit path —
    // including `parseChildFailures` extracting the leaf id from the
    // resolution — is what's under test.
    const parent = await fix.postOpen({ title: 'parent', body: 'p' });
    const child = await fix.postOpen({ title: 'child', body: 'c', parentId: parent.id });
    await fix.clerk.transition(child.id, 'failed', { resolution: 'engine crashed' });
    await fix.clerk.transition(parent.id, 'failed', {
      resolution: `Child "${child.id}" failed: engine crashed`,
    });

    const pulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(pulses.length, 1, 'root failed emits one pulse; child emits none');
    const pulse = pulses[0]!;
    assert.equal(pulse.writId, parent.id);
    const ctx = pulse.context as { childFailures?: string[]; resolution?: string };
    assert.ok(ctx.resolution?.includes(child.id));
    assert.ok(ctx.childFailures && ctx.childFailures.length > 0);
    assert.ok(ctx.childFailures?.some((id) => id.startsWith('w-')));
    assert.ok(pulse.summary.includes('Resolution'));
  });

  it('does not emit for a child writ transitioning to failed (roots-only)', async () => {
    const parent = await fix.postOpen({ title: 'parent', body: 'p' });
    const child = await fix.postOpen({ title: 'child', body: 'c', parentId: parent.id });
    // Drive only the child's failure — the parent is left in `open`.
    // No `writ-failed` pulse should fire for the child (roots-only).
    await fix.clerk.transition(child.id, 'failed', { resolution: 'engine crashed' });

    const failedPulses = await fix.pulsesOf(TRIGGER_WRIT_FAILED);
    assert.equal(failedPulses.length, 0, 'child must not emit its own failed pulse');
  });
});

describe('Reckoner — clockworks-retry optional', () => {
  afterEach(() => clearGuild());

  it('treats every stuck as terminal when clockworks-retry is not installed', async () => {
    const fix = await buildFixture({ withRetry: false });
    const writ = await fix.postOpen({ title: 'w', body: 'b' });
    // retryable: true should STILL emit — no retry runs, so every stuck
    // is terminal from the Reckoner's viewpoint.
    await stuckWith(fix, writ.id, { retryable: true, stuckCause: 'engine-failure' });
    const pulses = await fix.pulsesOf(TRIGGER_WRIT_STUCK);
    assert.equal(pulses.length, 1);
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
