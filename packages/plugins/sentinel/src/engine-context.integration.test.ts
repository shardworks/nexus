/**
 * End-to-end integration — Reckoner + Spider engine retry exhaustion.
 *
 * Spins a guild with stacks, clerk, fabricator, spider, lattice, and
 * reckoner. Registers a deterministic test engine that always fails
 * (retryable) with a small retry budget. Drives `spider.crawl()` until
 * the rig terminally fails, the Spider's CDC handler transitions the writ
 * to `phase='failed'`, the Reckoner's Phase 2 observer fires, and the
 * resulting `reckoner.writ-failed` pulse arrives carrying the full
 * engine-context payload (rig id, engine id, engine design id, attempt
 * count, last error, attempts summary).
 *
 * Asserts D12 from the commission spec: a real engine-retry exhaustion
 * end-to-end, with deterministic timing (fast-forwarding the back-off
 * window via direct rigs-book patches between crawl ticks). The pulse
 * must fire exactly once.
 *
 * Retry behavior here is intrinsic to the engine design (the `retry:
 * { maxAttempts }` block on the test engine), not driven by the retired
 * clockworks-retry handshake — Spider's engine-level retry path covers
 * what that plugin used to do.
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
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createLattice } from '@shardworks/lattice-apparatus';
import type { LatticeApi, PulseDoc } from '@shardworks/lattice-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { EngineDesign, FabricatorApi } from '@shardworks/fabricator-apparatus';

import type {
  AnimatorApi,
  AnimatorStatusDoc,
} from '@shardworks/animator-apparatus';

import { createSpider } from '@shardworks/spider-apparatus';
import type {
  RigDoc,
  RigTemplate,
  SpiderApi,
} from '@shardworks/spider-apparatus';

import { createReckoner } from './reckoner.ts';

// ── Fixture ────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  lattice: LatticeApi;
  spider: SpiderApi;
  attemptsByEngine: Map<string, number>;
  pulsesOf: (triggerType?: string) => Promise<PulseDoc[]>;
}

function buildCtx(kitEntries: KitEntry[] = []): StartupContext {
  return {
    on(): void {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

async function buildFixture(
  options: { retryMaxAttempts?: number } = {},
): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const latticePlugin = createLattice();
  const reckonerPlugin = createReckoner();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk');
  if (!('apparatus' in latticePlugin)) throw new Error('lattice');
  if (!('apparatus' in reckonerPlugin)) throw new Error('reckoner');
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider');

  const apparatusMap = new Map<string, unknown>();

  // Counts run() dispatches per engineId — diagnostic only.
  const attemptsByEngine = new Map<string, number>();

  // The doomed test engine. Always throws — `tryRun` classifies thrown
  // errors as retryable. The retry-budget cap is provided via the
  // `retry.maxAttempts` block on the engine design.
  const doomedEngine: EngineDesign = {
    id: 'doomed-quick',
    retry: { maxAttempts: options.retryMaxAttempts ?? 1 },
    async run(_givens, context) {
      const n = (attemptsByEngine.get(context.engineId) ?? 0) + 1;
      attemptsByEngine.set(context.engineId, n);
      throw new Error(`doomed attempt ${n}`);
    },
  };

  const template: RigTemplate = {
    engines: [{ id: 'doomed', designId: 'doomed-quick', givens: {} }],
    resolutionEngine: 'doomed',
  };

  const fakeGuildConfig: GuildConfig = {
    name: 'engine-context-integration',
    nexus: '0.0.0',
    plugins: [],
    spider: {
      rigTemplates: { default: template },
    } as never,
  };

  const fakeGuild: Guild = {
    home: '/tmp/engine-context',
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
  };

  setGuild(fakeGuild);

  // ── Start stacks ──
  stacksPlugin.apparatus.start(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure all the books the apparatuses need.
  memBackend.ensureBook(
    { ownerId: 'clerk', book: 'writs' },
    {
      indexes: [
        'phase',
        'type',
        'createdAt',
        'parentId',
        ['phase', 'type'],
        ['phase', 'createdAt'],
        ['parentId', 'phase'],
      ],
    },
  );
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId'],
  });
  memBackend.ensureBook(
    { ownerId: 'spider', book: 'rigs' },
    {
      indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
    },
  );
  memBackend.ensureBook(
    { ownerId: 'spider', book: 'input-requests' },
    { indexes: ['status', 'rigId', 'engineId'] },
  );
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });
  memBackend.ensureBook(
    { ownerId: 'lattice', book: 'pulses' },
    {
      indexes: ['triggerType', 'source', 'createdAt', 'deliveryState', 'writId'],
    },
  );

  // ── Mock animator (no engine in this test summons; this is just so
  //    the `animator` apparatus lookup does not throw at Spider startup).
  const animatorStatus: AnimatorStatusDoc = {
    id: 'current',
    state: 'running',
    backoffLevel: 0,
  };
  const mockAnimator = {
    async getStatus(): Promise<AnimatorStatusDoc> {
      return animatorStatus;
    },
    summon() {
      throw new Error('summon not used in this integration test');
    },
    animate() {
      throw new Error('animate not used');
    },
    subscribeToSession() {
      return null;
    },
    async cancel() {
      throw new Error('cancel not used');
    },
    async getSessionCosts() {
      return new Map();
    },
  } as unknown as AnimatorApi;
  apparatusMap.set('animator', mockAnimator);

  // ── Start clerk ──
  await clerkPlugin.apparatus.start(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Start lattice ──
  await latticePlugin.apparatus.start(buildCtx());
  const lattice = latticePlugin.apparatus.provides as LatticeApi;
  apparatusMap.set('lattice', lattice);

  // ── Start fabricator with our test engine ──
  const spiderKit = (spiderPlugin.apparatus as {
    supportKit?: { engines?: Record<string, unknown> };
  }).supportKit ?? {};
  const combinedEngines: Record<string, unknown> = {
    ...(spiderKit.engines ?? {}),
    'doomed-quick': doomedEngine,
  };
  const kitEntries: KitEntry[] = [
    {
      pluginId: 'spider',
      packageName: '@shardworks/spider-apparatus',
      type: 'engines',
      value: combinedEngines,
    },
  ];
  for (const [type, value] of Object.entries(spiderKit)) {
    if (type === 'engines') continue;
    kitEntries.push({
      pluginId: 'spider',
      packageName: '@shardworks/spider-apparatus',
      type,
      value,
    });
  }
  const spiderCtx = buildCtx(kitEntries);
  fabricatorPlugin.apparatus.start(spiderCtx);
  const fabricator = fabricatorPlugin.apparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  // ── Start spider ──
  spiderPlugin.apparatus.start(spiderCtx);
  const spider = spiderPlugin.apparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  // ── Start reckoner LAST so its observer is ready before any failure CDC. ──
  await reckonerPlugin.apparatus.start(buildCtx());

  const pulsesBook = stacks.book<PulseDoc>('lattice', 'pulses');
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
    spider,
    attemptsByEngine,
    pulsesOf,
  };
}

async function fastForwardHold(
  fix: Fixture,
  rigId: string,
  engineId: string,
): Promise<void> {
  const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
  const rig = await rigsBook.get(rigId);
  if (!rig) throw new Error(`rig ${rigId} not found`);
  const updated = rig.engines.map((e) =>
    e.id === engineId
      ? { ...e, holdUntil: new Date(Date.now() - 1000).toISOString() }
      : e,
  );
  await rigsBook.patch(rigId, { engines: updated });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Reckoner integration — engine retry exhaustion → enriched writ-failed pulse', () => {
  afterEach(() => clearGuild());

  it('drives a real engine retry exhaustion through Spider and emits one engine-enriched writ-failed pulse', async () => {
    // retryMaxAttempts: 1 → up to two attempts total. We crawl through
    // the spawn → first attempt → back-off → fast-forward → second
    // attempt → exhaustion → writ-failed sequence.
    const fix = await buildFixture({ retryMaxAttempts: 1 });

    // Post a mandate writ and publish it.
    const writ = await fix.clerk.post({ title: 'doomed mandate', body: 'b' });
    await fix.clerk.transition(writ.id, 'open');

    // Spawn the rig.
    let result = await fix.spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    // First attempt — retryable-within-budget.
    result = await fix.spider.crawl();
    assert.equal(result?.action, 'engine-retrying');

    // Fast-forward the back-off so the next crawl re-dispatches.
    const rig = await fix.spider.forWrit(writ.id);
    assert.ok(rig, 'rig should exist after first attempt');
    await fastForwardHold(fix, rig!.id, 'doomed');

    // Second attempt — budget exhausted → terminal-failed → rig-completed
    // with outcome='failed'.
    result = await fix.spider.crawl();
    assert.equal(result?.action, 'rig-completed');
    assert.equal((result as { outcome: string }).outcome, 'failed');

    // The Spider's CDC handler transitions the writ to `phase='failed'`.
    const finalWrit = await fix.clerk.show(writ.id);
    assert.equal(finalWrit.phase, 'failed');

    // The Reckoner's writ-failed observer should have fired exactly once.
    const pulses = await fix.pulsesOf('reckoner.writ-failed');
    assert.equal(pulses.length, 1, 'exactly one writ-failed pulse');
    const pulse = pulses[0]!;
    assert.equal(pulse.writId, writ.id);

    // ── The engine-context payload — the load-bearing assertion. ──
    const ctx = pulse.context as {
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
    assert.ok(ctx.engineFailure, 'engineFailure context block must be present');
    const ef = ctx.engineFailure!;
    assert.equal(ef.rigId, rig!.id);
    assert.equal(ef.engineId, 'doomed');
    assert.equal(ef.engineDesignId, 'doomed-quick');
    assert.ok(
      typeof ef.attemptCount === 'number' && ef.attemptCount >= 1,
      'attemptCount must reflect retries consumed',
    );
    assert.ok(
      ef.lastError && /doomed attempt/.test(ef.lastError),
      'lastError must surface the engine error from the final attempt',
    );
    assert.ok(
      ef.attemptsSummary.length >= 1,
      'attemptsSummary must include at least one attempt',
    );
    // Every summary entry must NOT carry yields (D7).
    for (const entry of ef.attemptsSummary) {
      assert.ok(!('yields' in entry), 'yields must be dropped from attempts summary');
    }
    // Tail entry should be the final failed attempt with the matching error.
    const tail = ef.attemptsSummary[ef.attemptsSummary.length - 1]!;
    assert.equal(tail.status, 'failed');
    assert.ok(tail.error && /doomed attempt/.test(tail.error));
  });
});
