/**
 * End-to-end integration — Lattice + Reckoner + Discord kit.
 *
 * Spins a guild with stacks, clerk, lattice, reckoner, clockworks-retry and
 * the Discord channel kit, configures a `discord-webhook` channel pointed at
 * a mocked webhook URL, and drives a root mandate through stuck and failed
 * transitions plus a drain. Asserts that the correct pulses fire, the
 * dispatcher delivers them, and the CLI tools see them as expected.
 *
 * The assertions line up with the commission brief's Acceptance Signal:
 *
 *   - A root commission entering `failed` produces exactly one pulse,
 *     delivered to Discord, visible in `pulse list`.
 *   - A retry-cap-exhausted stuck produces one `reckoner.writ-stuck`.
 *   - A single transient stuck (retryable, under cap) produces zero pulses.
 *   - `pulse list --live` excludes drain pulses and drops writ-scoped
 *     pulses whose referent is no longer stuck/failed.
 *   - `pulse show <id-prefix>` resolves a prefix.
 */

import { describe, it, afterEach } from 'node:test';
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

import { createClockworksRetry } from '@shardworks/clockworks-retry-apparatus';
import type { ClockworksRetryApi } from '@shardworks/clockworks-retry-apparatus';

import discordKit from '@shardworks/lattice-discord-kit';

import { createLattice, pulseList, pulseShow } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createReckoner } from './reckoner.ts';

// ── Fixture ───────────────────────────────────────────────────────

interface RigRow extends BookEntry {
  id: string;
  writId: string;
  status: 'running' | 'blocked' | 'stuck' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[] = []): KitEntry[] {
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

const ENV_VAR = 'LATTICE_INTEGRATION_WEBHOOK_URL';

function mockFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  lattice: LatticeApi;
  /** Every Discord webhook POST that was made during the test. */
  discordCalls: Array<{ url: string; payload: unknown }>;
  /** Insert a rig — useful for driving the retry-cap path. */
  seedRig: (writId: string, status?: RigRow['status']) => Promise<string>;
  /** Unhook the mocked fetch. */
  restoreFetch: () => void;
}

async function buildGuild(): Promise<Fixture> {
  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();
  const retryPlugin = createClockworksRetry();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice');
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner');
  if (!('apparatus' in retryPlugin)) throw new Error('retry');

  const apparatusMap = new Map<string, unknown>();

  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    lattice: {
      channels: [
        { type: 'discord-webhook', webhookUrlEnvVar: ENV_VAR },
      ],
    },
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

  // Set up webhook URL and fetch mock BEFORE starting the lattice — the
  // Discord channel reads the URL from process.env at send time.
  process.env[ENV_VAR] = 'https://discord.invalid/webhook';
  const discordCalls: Array<{ url: string; payload: unknown }> = [];
  const restoreFetch = mockFetch(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const bodyStr = init?.body as string | undefined;
    let payload: unknown = null;
    if (typeof bodyStr === 'string') {
      try {
        payload = JSON.parse(bodyStr);
      } catch {
        payload = bodyStr;
      }
    }
    discordCalls.push({ url, payload });
    return new Response(null, { status: 204 });
  });

  // Start stacks
  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  backend.ensureBook({ ownerId: 'clerk', book: 'writs' }, { indexes: ['phase', 'type', 'createdAt', 'parentId'] });
  backend.ensureBook({ ownerId: 'clerk', book: 'links' }, {});
  backend.ensureBook({ ownerId: 'spider', book: 'rigs' }, { indexes: ['status', 'writId'] });
  backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, {
    indexes: ['triggerType', 'source', 'createdAt', 'deliveryState', 'writId'],
  });

  // Start clerk
  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Start lattice with the Discord kit's contribution wired as a KitEntry.
  const kitEntries: KitEntry[] = [];
  const discordKitDescriptor = (discordKit as { kit: Record<string, unknown> }).kit;
  for (const [type, value] of Object.entries(discordKitDescriptor)) {
    if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
    kitEntries.push({
      pluginId: 'lattice-discord',
      packageName: '@shardworks/lattice-discord-kit',
      type,
      value,
    });
  }
  await latticePlugin.apparatus.start(buildCtx(kitEntries));
  const lattice = latticePlugin.apparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  // Start clockworks-retry so maxAttempts = 2 drives the retry-cap path.
  await retryPlugin.apparatus.start(buildCtx());
  apparatusMap.set('clockworks-retry', retryPlugin.apparatus.provides as ClockworksRetryApi);

  // Start reckoner — observers fire from here forward.
  await reckonerPlugin.apparatus.start(buildCtx());

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');

  async function seedRig(writId: string, status: RigRow['status'] = 'stuck'): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({ id, writId, status, createdAt: new Date().toISOString() });
    return id;
  }

  return { stacks, clerk, lattice, discordCalls, seedRig, restoreFetch };
}

async function teardown(fix: Fixture): Promise<void> {
  fix.restoreFetch();
  delete process.env[ENV_VAR];
  clearGuild();
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

// Helpers that call the tool handlers directly (same path the CLI uses).
async function runList(params: unknown): Promise<PulseDoc[]> {
  const parsed = pulseList.params.parse(params);
  return (await pulseList.handler(parsed)) as PulseDoc[];
}

async function runShow(params: unknown): Promise<PulseDoc> {
  const parsed = pulseShow.params.parse(params);
  return (await pulseShow.handler(parsed)) as PulseDoc;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Lattice + Reckoner + Discord — end-to-end', () => {
  afterEach(() => clearGuild());

  it('emits, dispatches, and surfaces a writ-failed pulse for a root mandate', async () => {
    const fix = await buildGuild();
    try {
      const writ = await fix.clerk.post({ title: 'root mandate', body: 'b' });
      await fix.clerk.transition(writ.id, 'open');
      await fix.clerk.transition(writ.id, 'failed', { resolution: 'abandoned' });

      // Exactly one pulse (failed). Drain may or may not have fired; assert
      // explicitly on the writ-failed count.
      const failed = await fix.lattice.list({ triggerType: 'reckoner.writ-failed' });
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.deliveryState, 'delivered');

      // Discord received at least one POST (failed + possibly drain).
      assert.ok(fix.discordCalls.length >= 1);
      const failedCall = fix.discordCalls.find((call) => {
        const p = call.payload as { embeds?: Array<{ title?: string }> };
        return p.embeds?.[0]?.title?.includes('failed');
      });
      assert.ok(failedCall, 'discord received a failed-shaped embed');
      const embed = (failedCall.payload as { embeds: Array<Record<string, unknown>> }).embeds[0]!;
      assert.ok(typeof embed.color === 'number');
      assert.ok(Array.isArray(embed.fields));

      // pulse-list defaults should show the failed row.
      const listed = await runList({});
      assert.ok(listed.some((p) => p.id === failed[0]?.id));
    } finally {
      await teardown(fix);
    }
  });

  it('produces no pulse for a transient retryable stuck under cap', async () => {
    const fix = await buildGuild();
    try {
      const writ = await fix.clerk.post({ title: 'stuck mandate', body: 'b' });
      await fix.clerk.transition(writ.id, 'open');
      await fix.seedRig(writ.id, 'stuck');
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      const stuckPulses = await fix.lattice.list({ triggerType: 'reckoner.writ-stuck' });
      assert.equal(stuckPulses.length, 0);
      const discordStuckCalls = fix.discordCalls.filter((c) => {
        const p = c.payload as { embeds?: Array<{ title?: string }> };
        return p.embeds?.[0]?.title?.includes('stuck');
      });
      assert.equal(discordStuckCalls.length, 0);
    } finally {
      await teardown(fix);
    }
  });

  it('produces one writ-stuck pulse when the retry cap is exhausted', async () => {
    const fix = await buildGuild();
    try {
      const writ = await fix.clerk.post({ title: 'capped mandate', body: 'b' });
      await fix.clerk.transition(writ.id, 'open');
      // Two prior rigs → cap hit → clockworks-retry will not requeue.
      await fix.seedRig(writ.id, 'stuck');
      await fix.seedRig(writ.id, 'stuck');
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed again',
      });

      const stuckPulses = await fix.lattice.list({ triggerType: 'reckoner.writ-stuck' });
      assert.equal(stuckPulses.length, 1);
      assert.equal(stuckPulses[0]?.deliveryState, 'delivered');
    } finally {
      await teardown(fix);
    }
  });

  it('surfaces pulses through pulse-show and --live filter', async () => {
    const fix = await buildGuild();
    try {
      // Create a root writ and transition it to stuck (non-retryable → terminal).
      const writ = await fix.clerk.post({ title: 'live test', body: 'b' });
      await fix.clerk.transition(writ.id, 'open');
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: false,
        detail: 'bad input',
      });

      const pulses = await fix.lattice.list({ triggerType: 'reckoner.writ-stuck' });
      assert.equal(pulses.length, 1);
      const pulse = pulses[0]!;

      // pulse-show resolves a prefix.
      const shown = await runShow({ id: pulse.id.slice(0, 10) });
      assert.equal(shown.id, pulse.id);

      // pulse-list --live includes the stuck row.
      const live = await runList({ live: true });
      assert.ok(live.some((p) => p.id === pulse.id));

      // Recover the writ (stuck → open → completed). --live should no
      // longer include the writ-stuck pulse.
      await fix.clerk.transition(writ.id, 'open');
      await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

      const liveAfter = await runList({ live: true });
      assert.ok(!liveAfter.some((p) => p.id === pulse.id));

      // --live never returns drain pulses, even after the completion fired one.
      const drainPulses = await fix.lattice.list({ triggerType: 'reckoner.queue-drained' });
      if (drainPulses.length > 0) {
        assert.ok(!liveAfter.some((p) => p.id === drainPulses[0]?.id));
      }
    } finally {
      await teardown(fix);
    }
  });

  it('dispatches pending pulses on startup even when a prior process crashed mid-dispatch', async () => {
    // Simulate the restart story: emit a pulse, restart the whole guild
    // with the same backend, and assert the startup scan dispatched the
    // previously-pending row.

    // Phase 1: build a guild, emit a pulse, but hijack the Discord channel
    // so the dispatch leaves the row as `failed` (so we can tell the
    // startup scan did something).
    const backend = new MemoryBackend();
    const apparatusMap1 = new Map<string, unknown>();
    const fakeGuildConfig: GuildConfig = {
      name: 'test', nexus: '0', plugins: [],
      lattice: { channels: [{ type: 'discord-webhook', webhookUrlEnvVar: ENV_VAR }] },
    };
    setGuild({
      home: '/tmp/test',
      apparatus<T>(name: string): T {
        const api = apparatusMap1.get(name);
        if (!api) throw new Error(`Apparatus "${name}" not installed`);
        return api as T;
      },
      config<T>(_id: string): T {
        return {} as T;
      },
      writeConfig(): void {},
      guildConfig(): GuildConfig {
        return fakeGuildConfig;
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
    });

    // Don't set ENV_VAR — the Discord channel will return ok:false and the
    // pulse will be marked `failed` on dispatch. Then for the second
    // process we set ENV_VAR and re-emit a pending pulse directly in the
    // book to simulate a pre-existing pending row across restart.
    delete process.env[ENV_VAR];

    const stacksPlugin1 = createStacksApparatus(backend);
    if (!('apparatus' in stacksPlugin1)) throw new Error('stacks');
    stacksPlugin1.apparatus.start(buildCtx());
    const stacks1 = stacksPlugin1.apparatus.provides as StacksApi;
    apparatusMap1.set('stacks', stacks1);

    backend.ensureBook({ ownerId: 'lattice', book: 'pulses' }, {
      indexes: ['triggerType', 'source', 'createdAt', 'deliveryState'],
    });

    // Seed a pending pulse directly, as if an older process wrote it and
    // crashed before the dispatcher ran.
    const pulsesBook1 = stacks1.book<PulseDoc>('lattice', 'pulses');
    const preexistingId = 'p-crash-survivor';
    const now = new Date().toISOString();
    await pulsesBook1.put({
      id: preexistingId,
      source: 'reckoner',
      triggerType: 'reckoner.writ-stuck',
      writId: null,
      title: 'carryover',
      summary: 'carryover summary',
      linkUrl: null,
      context: {},
      deliveryState: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    clearGuild();

    // Phase 2: fresh guild over the same backend. Start the lattice with
    // the Discord channel correctly configured.
    process.env[ENV_VAR] = 'https://discord.invalid/webhook';
    const receivedCalls: Array<{ url: string }> = [];
    const restoreFetch = mockFetch(async (input) => {
      receivedCalls.push({ url: typeof input === 'string' ? input : String(input) });
      return new Response(null, { status: 204 });
    });
    try {
      const apparatusMap2 = new Map<string, unknown>();
      setGuild({
        home: '/tmp/test',
        apparatus<T>(name: string): T {
          const api = apparatusMap2.get(name);
          if (!api) throw new Error(`Apparatus "${name}" not installed`);
          return api as T;
        },
        config<T>(_id: string): T {
          return {} as T;
        },
        writeConfig(): void {},
        guildConfig(): GuildConfig {
          return fakeGuildConfig;
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
      });

      const stacksPlugin2 = createStacksApparatus(backend);
      if (!('apparatus' in stacksPlugin2)) throw new Error('stacks');
      stacksPlugin2.apparatus.start(buildCtx());
      const stacks2 = stacksPlugin2.apparatus.provides as StacksApi;
      apparatusMap2.set('stacks', stacks2);

      const latticePlugin2 = createLattice();
      if (!('apparatus' in latticePlugin2)) throw new Error('lattice');
      const kitEntries: KitEntry[] = [];
      const discordKitDescriptor = (discordKit as { kit: Record<string, unknown> }).kit;
      for (const [type, value] of Object.entries(discordKitDescriptor)) {
        if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
        kitEntries.push({
          pluginId: 'lattice-discord',
          packageName: '@shardworks/lattice-discord-kit',
          type,
          value,
        });
      }
      await latticePlugin2.apparatus.start(buildCtx(kitEntries));
      const lattice2 = latticePlugin2.apparatus.provides as LatticeApi;

      // The startup scan should have dispatched the preexisting pending pulse.
      const pulsesBook2 = stacks2.book<PulseDoc>('lattice', 'pulses');
      const after = await pulsesBook2.get(preexistingId);
      assert.ok(after, 'pulse must still exist');
      assert.equal(after.deliveryState, 'delivered');
      assert.equal(receivedCalls.length, 1);

      // And the API still shows it.
      const resolved = await lattice2.show(preexistingId);
      assert.equal(resolved.id, preexistingId);
    } finally {
      restoreFetch();
      delete process.env[ENV_VAR];
      clearGuild();
    }
  });
});
