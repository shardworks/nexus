/**
 * Reckoner — drain emission tests.
 *
 * The drain predicate is documented in D7:
 *
 *     `open` writ count === 0  AND  rig count (running | blocked) === 0.
 *
 * Stuck writs are excluded. No dedupe across bursts in MVP.
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
import type { ClerkApi } from '@shardworks/clerk-apparatus';

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
  seedRig: (writId: string, status: RigRow['status']) => Promise<string>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
}

async function buildFixture(): Promise<Fixture> {
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

  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');
  const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');

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

  return { stacks, clerk, lattice, seedRig, pulsesOf };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Reckoner — queue-drained emission', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  it('fires on the terminal transition that takes open to zero', async () => {
    const writ = await fix.clerk.post({ title: 'w', body: 'b' });
    // Starts in `open`. Complete it → open count becomes 0.
    await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
    const ctx = pulses[0]?.context as { lastTerminalWritId?: string };
    assert.equal(ctx.lastTerminalWritId, writ.id);
  });

  it('does not fire while open > 0 (another writ is still runnable)', async () => {
    const writA = await fix.clerk.post({ title: 'A', body: '' });
    const _writB = await fix.clerk.post({ title: 'B', body: '' });
    await fix.clerk.transition(writA.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0);
  });

  it('does not fire while active rigs remain (running or blocked)', async () => {
    const writA = await fix.clerk.post({ title: 'A', body: '' });
    const writB = await fix.clerk.post({ title: 'B', body: '' });
    await fix.seedRig(writB.id, 'running');
    // Finish A; B is in `open` phase with a running rig → not drained.
    await fix.clerk.transition(writA.id, 'completed', { resolution: 'done' });

    // Now close B — but pretend the running rig lingers. open becomes 0
    // but a running rig is still around, so we are still not drained.
    await fix.clerk.transition(writB.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 0, 'running rig holds the drain back');
  });

  it('fires even when stuck writs are present (stuck is not runnable)', async () => {
    const stuck = await fix.clerk.post({ title: 'stuck', body: '' });
    await fix.clerk.transition(stuck.id, 'stuck', { resolution: 'no progress' });
    const good = await fix.clerk.post({ title: 'good', body: '' });
    await fix.clerk.transition(good.id, 'completed', { resolution: 'done' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1, 'stuck writs do not count as runnable');
  });

  it('also fires on a cancel transition that drains the queue', async () => {
    const writ = await fix.clerk.post({ title: 'w', body: '' });
    await fix.clerk.transition(writ.id, 'cancelled', { resolution: 'withdrawn' });
    const pulses = await fix.pulsesOf(TRIGGER_QUEUE_DRAINED);
    assert.equal(pulses.length, 1);
  });
});
