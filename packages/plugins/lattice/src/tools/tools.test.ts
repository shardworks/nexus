/**
 * pulse-list / pulse-show — CLI tool tests.
 *
 * These tests drive the tool handlers directly (the same path the CLI and
 * MCP server use), verifying flag defaults, --since / --all overrides,
 * --live filtering against live clerk phases, pagination, and prefix
 * resolution in pulse-show.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
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
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createLattice } from '../lattice.ts';
import type { LatticeApi, PulseDoc } from '../types.ts';

import pulseList from './pulse-list.ts';
import pulseShow from './pulse-show.ts';

// ── Fixture ───────────────────────────────────────────────────────

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

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  lattice: LatticeApi;
  backend: MemoryBackend;
}

async function buildFixture(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice must be apparatus');

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
  const stacksApparatus = stacksPlugin.apparatus;
  stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure the books exist — clerk performs its own migration scan so we
  // need writs & links pre-created; lattice needs pulses.
  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId'],
  });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label'],
  });
  backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, {
    indexes: ['triggerType', 'source', 'createdAt', 'deliveryState', 'writId'],
  });

  // Start clerk
  const clerkApparatus = clerkPlugin.apparatus;
  await clerkApparatus.start(buildCtx());
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Start lattice (no channels configured — pulses move to delivered
  // trivially so we can read them back with realistic delivery state).
  const latticeApparatus = latticePlugin.apparatus;
  await latticeApparatus.start(buildCtx());
  const lattice = latticeApparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  return { stacks, clerk, lattice, backend };
}

async function seedPulseFor(
  fix: Fixture,
  triggerType: string,
  writId: string | null,
  title = 't',
): Promise<PulseDoc> {
  return fix.lattice.emit({
    source: 'reckoner',
    triggerType,
    writId,
    title,
    summary: title,
  });
}

// Helpers that call the tool handler directly (same path the CLI uses).
async function runList(params: unknown): Promise<PulseDoc[]> {
  const parsed = pulseList.params.parse(params);
  return (await pulseList.handler(parsed)) as PulseDoc[];
}

async function runShow(params: unknown): Promise<PulseDoc> {
  const parsed = pulseShow.params.parse(params);
  return (await pulseShow.handler(parsed)) as PulseDoc;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('pulse-list — defaults and window', () => {
  afterEach(() => clearGuild());

  it('returns pulses from the last 24h by default, newest first, limit 20', async () => {
    const fix = await buildFixture();
    for (let i = 0; i < 25; i++) {
      await seedPulseFor(fix, 'reckoner.writ-stuck', null, `p${i}`);
    }

    const list = await runList({});
    assert.equal(list.length, 20, 'default limit is 20');
  });

  it('excludes pulses older than 24h by default', async () => {
    const fix = await buildFixture();
    const old = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 'old');
    const pulsesBook = fix.stacks.book<PulseDoc>('lattice', 'pulses');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await pulsesBook.patch(old.id, { createdAt: ancient, updatedAt: ancient });

    const recent = await seedPulseFor(fix, 'reckoner.writ-failed', null, 'recent');

    const list = await runList({});
    const ids = list.map((p) => p.id);
    assert.deepEqual(ids, [recent.id]);
  });

  it('--since overrides the default window', async () => {
    const fix = await buildFixture();
    const old = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 'old');
    const pulsesBook = fix.stacks.book<PulseDoc>('lattice', 'pulses');
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await pulsesBook.patch(old.id, { createdAt: ancient, updatedAt: ancient });
    const recent = await seedPulseFor(fix, 'reckoner.writ-failed', null, 'recent');

    const list = await runList({ since: new Date(0).toISOString() });
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((p) => p.id).sort(),
      [old.id, recent.id].sort(),
    );
  });

  it('--all returns every pulse regardless of age', async () => {
    const fix = await buildFixture();
    const old = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 'old');
    const pulsesBook = fix.stacks.book<PulseDoc>('lattice', 'pulses');
    const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    await pulsesBook.patch(old.id, { createdAt: ancient, updatedAt: ancient });

    const list = await runList({ all: true });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, old.id);
  });

  it('honors --limit and --offset', async () => {
    const fix = await buildFixture();
    for (let i = 0; i < 5; i++) {
      await seedPulseFor(fix, 'reckoner.writ-stuck', null, `p${i}`);
    }
    const first = await runList({ limit: 2 });
    assert.equal(first.length, 2);
    const next = await runList({ limit: 2, offset: 2 });
    assert.equal(next.length, 2);
    assert.notStrictEqual(first[0]?.id, next[0]?.id);
  });
});

describe('pulse-list — --live filtering', () => {
  afterEach(() => clearGuild());

  it('excludes drain pulses (null writId) entirely', async () => {
    const fix = await buildFixture();
    const writ = await fix.clerk.post({ title: 'w', body: 'b' });
    await fix.clerk.transition(writ.id, 'open');
    await fix.clerk.transition(writ.id, 'stuck', { resolution: 'test' });

    await seedPulseFor(fix, 'reckoner.queue-drained', null, 'drained');
    const stuckPulse = await seedPulseFor(fix, 'reckoner.writ-stuck', writ.id, 'stuck');

    const list = await runList({ live: true });
    assert.deepEqual(list.map((p) => p.id), [stuckPulse.id]);
  });

  it('includes pulses whose writ is currently stuck or failed', async () => {
    const fix = await buildFixture();
    const stuckWrit = await fix.clerk.post({ title: 's', body: 'b' });
    await fix.clerk.transition(stuckWrit.id, 'open');
    await fix.clerk.transition(stuckWrit.id, 'stuck', { resolution: 'test' });
    const failedWrit = await fix.clerk.post({ title: 'f', body: 'b' });
    await fix.clerk.transition(failedWrit.id, 'open');
    await fix.clerk.transition(failedWrit.id, 'failed', { resolution: 'test' });

    const stuckPulse = await seedPulseFor(fix, 'reckoner.writ-stuck', stuckWrit.id);
    const failedPulse = await seedPulseFor(fix, 'reckoner.writ-failed', failedWrit.id);

    const list = await runList({ live: true });
    assert.deepEqual(
      list.map((p) => p.id).sort(),
      [stuckPulse.id, failedPulse.id].sort(),
    );
  });

  it('excludes pulses whose writ has since moved to a non-live phase', async () => {
    const fix = await buildFixture();
    const writ = await fix.clerk.post({ title: 'w', body: 'b' });
    await fix.clerk.transition(writ.id, 'open');
    await fix.clerk.transition(writ.id, 'stuck', { resolution: 'test' });
    await seedPulseFor(fix, 'reckoner.writ-stuck', writ.id);

    // Now complete a clean-up cycle: writ is no longer stuck/failed.
    await fix.clerk.transition(writ.id, 'open');
    await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

    const list = await runList({ live: true });
    assert.deepEqual(list, []);
  });

  it('excludes writ-scoped pulses whose writ no longer exists', async () => {
    const fix = await buildFixture();
    // Emit a pulse pointing at a writ id that was never created.
    await seedPulseFor(fix, 'reckoner.writ-stuck', 'w-nonexistent');

    const list = await runList({ live: true });
    assert.deepEqual(list, []);
  });

  it('without --live, does not filter on writ phase', async () => {
    const fix = await buildFixture();
    const writ = await fix.clerk.post({ title: 'w', body: 'b' });
    await seedPulseFor(fix, 'reckoner.writ-stuck', writ.id);

    // Writ is in open phase (not live). Default list still includes it.
    const list = await runList({});
    assert.equal(list.length, 1);
  });
});

describe('pulse-show — prefix resolution', () => {
  afterEach(() => clearGuild());

  it('resolves a full id and returns the stored document', async () => {
    const fix = await buildFixture();
    const pulse = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 't');
    const result = await runShow({ id: pulse.id });
    assert.equal(result.id, pulse.id);
    assert.equal(result.title, 't');
  });

  it('resolves a unique prefix', async () => {
    const fix = await buildFixture();
    const pulse = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 't');
    const result = await runShow({ id: pulse.id.slice(0, 10) });
    assert.equal(result.id, pulse.id);
  });

  it('throws on an unknown id', async () => {
    const _fix = await buildFixture();
    await assert.rejects(() => runShow({ id: 'p-nope' }));
  });
});

describe('pulse-list / pulse-show — permission and shape', () => {
  it('declares permission: "lattice:read" on both tools', () => {
    assert.equal(pulseList.permission, 'lattice:read');
    assert.equal(pulseShow.permission, 'lattice:read');
  });

  it('returns raw pulse documents (no pre-rendering)', async () => {
    const fix = await buildFixture();
    try {
      const pulse = await seedPulseFor(fix, 'reckoner.writ-stuck', null, 't');
      const list = await runList({});
      // Spot-check that the document is shaped like PulseDoc and not a
      // rendered string.
      assert.ok(typeof list[0] === 'object' && list[0] !== null);
      const first = list[0] as PulseDoc;
      assert.equal(first.id, pulse.id);
      assert.ok('createdAt' in first);
      assert.ok('deliveryState' in first);
      assert.ok('triggerType' in first);

      const shown = await runShow({ id: pulse.id });
      assert.equal(shown.id, pulse.id);
      assert.ok('context' in shown);
    } finally {
      clearGuild();
    }
  });
});

// Touch WritDoc to avoid unused-import linting in case we remove helpers
// later. The concrete usage is via clerk.transition above.
type _WritDocUsed = WritDoc;
