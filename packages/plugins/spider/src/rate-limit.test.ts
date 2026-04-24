/**
 * Spider — rate-limit integration tests.
 *
 * Exercises:
 *  - tryCollect branching on `rate-limited` session status → transitions
 *    the engine to `blocked` with block type `animator-paused`.
 *  - The crawl gate (D14 / D15) — when the Animator reports paused AND
 *    `pausedUntil` is in the future, `crawl()` returns null rather than
 *    calling tryRun / trySpawn.
 *  - `tryCheckBlocked` invoking the `animator-paused` block checker,
 *    which clears the block when the Animator returns to `running` or
 *    the pause window has elapsed.
 *
 * Uses a controllable AnimatorApi mock so tests can flip between paused
 * and running state without invoking the real back-off machine.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, KitEntry, StartupContext } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';

import type {
  AnimatorApi,
  AnimatorStatusDoc,
  SessionDoc,
} from '@shardworks/animator-apparatus';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, RigTemplate } from './types.ts';

// Use a single-engine template so rig completion tracks the engine
// directly — easier assertions.
const TEMPLATE: RigTemplate = {
  engines: [
    { id: 'impl', designId: 'anima-session', givens: { writ: '${writ}' } },
  ],
  resolutionEngine: 'impl',
};

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  spider: SpiderApi;
  setStatus(doc: AnimatorStatusDoc): void;
}

function buildFixture(): Fixture {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'rate-limit-test',
    nexus: '0.0.0',
    plugins: [],
    spider: {
      rigTemplates: { default: TEMPLATE },
    } as never,
  };

  const fakeGuild: Guild = {
    home: '/tmp/rate-limit-test',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
    },
    config<T>(): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits() { return []; },
    apparatuses() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  const noopCtx: StartupContext = { on: () => {}, kits: () => [] as KitEntry[] };

  // Stacks
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  stacksPlugin.apparatus.start(noopCtx);
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Seed books
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['status', 'rigId', 'engineId'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });

  // Controllable animator status
  let status: AnimatorStatusDoc = { id: 'current', state: 'running', backoffLevel: 0 };

  // Mock AnimatorApi — just enough for spider tests. Tests excluded
  // from typecheck so missing members are fine at compile time.
  const mockAnimator = {
    async getStatus(): Promise<AnimatorStatusDoc> { return status; },
    summon() { throw new Error('summon not used in this test'); },
    animate() { throw new Error('animate not used in this test'); },
    subscribeToSession() { return null; },
    async cancel() { throw new Error('cancel not used in this test'); },
    async getSessionCosts() { return new Map(); },
  } as unknown as AnimatorApi;
  apparatusMap.set('animator', mockAnimator);

  // Clerk
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  clerkPlugin.apparatus.start(noopCtx);
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Fabricator — seed the `anima-session` engine from Spider's support kit.
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator must be apparatus');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider must be apparatus');
  const spiderKit = (spiderPlugin.apparatus as { supportKit?: { engines?: Record<string, unknown> } }).supportKit ?? {};
  const kitEntries: KitEntry[] = [];
  for (const [type, value] of Object.entries(spiderKit)) {
    kitEntries.push({ pluginId: 'spider', packageName: '@shardworks/spider-apparatus', type, value });
  }
  const fabCtx: StartupContext = {
    on: () => {},
    kits(type: string): KitEntry[] {
      return kitEntries.filter((e) => e.type === type);
    },
  };
  fabricatorPlugin.apparatus.start(fabCtx);
  apparatusMap.set('fabricator', fabricatorPlugin.apparatus.provides);

  // Spider
  spiderPlugin.apparatus.start(fabCtx);
  const spider = spiderPlugin.apparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  return {
    stacks,
    clerk,
    spider,
    setStatus(next: AnimatorStatusDoc) { status = next; },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Spider — rate-limit integration', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('tryCollect transitions the engine to blocked(animator-paused) when the session is rate-limited', async () => {
    const writ = await fix.clerk.post({ title: 'rate-limit collect test' });
    // Spawn the rig.
    await fix.spider.crawl();

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });

    const fakeSessionId = generateId('ses', 4);
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'impl'
        ? { ...e, status: 'running' as const, sessionId: fakeSessionId }
        : e,
    );
    await rigsBook.patch(rig.id, { engines: updatedEngines });

    const sessions = fix.stacks.book<SessionDoc>('animator', 'sessions');
    await sessions.put({
      id: fakeSessionId,
      status: 'rate-limited',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      provider: 'mock',
      exitCode: 0,
      error: 'Rate limited by provider',
      terminationTag: { kind: 'rate-limit', source: 'ndjson-result' },
    });

    const result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'engine-blocked');
    assert.equal((result as { blockType: string }).blockType, 'animator-paused');

    const [updatedRig] = await rigsBook.find({ where: [['id', '=', rig.id]] });
    const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'impl')!;
    assert.equal(impl.status, 'blocked');
    assert.equal(impl.block?.type, 'animator-paused');
    assert.equal(impl.sessionId, undefined, 'sessionId must be cleared so next tryRun picks up a fresh session');
  });

  it('crawl() returns null when the Animator is paused (gate short-circuits tryRun and trySpawn)', async () => {
    fix.setStatus({
      id: 'current',
      state: 'paused',
      pausedSince: new Date().toISOString(),
      pausedUntil: new Date(Date.now() + 60_000).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 0,
    });

    // Post a writ — trySpawn would normally pick this up.
    await fix.clerk.post({ title: 'paused gate test' });

    const result = await fix.spider.crawl();
    // No rig spawned while paused — crawl returns null.
    assert.equal(result, null);

    // Rig count: zero.
    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const rigs = await rigsBook.list();
    assert.equal(rigs.length, 0);
  });

  it('crawl() dispatches normally once the pause window elapses', async () => {
    fix.setStatus({
      id: 'current',
      state: 'paused',
      pausedSince: new Date(Date.now() - 120_000).toISOString(),
      pausedUntil: new Date(Date.now() - 60_000).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 0,
    });

    await fix.clerk.post({ title: 'pause elapsed test' });
    const result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'rig-spawned');
  });

  it('tryCheckBlocked clears an animator-paused block when the Animator returns to running', async () => {
    // Seed a rig whose sole engine is blocked with animator-paused.
    const writ = await fix.clerk.post({ title: 'unblock test' });
    await fix.spider.crawl(); // spawn

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    const blockedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'impl'
        ? {
            ...e,
            status: 'blocked' as const,
            block: {
              type: 'animator-paused',
              condition: { sessionId: 'ses-old' },
              blockedAt: new Date().toISOString(),
              lastCheckedAt: new Date(0).toISOString(),
            },
          }
        : e,
    );
    await rigsBook.patch(rig.id, { engines: blockedEngines, status: 'blocked' });

    // With the Animator reporting running, the check should clear.
    fix.setStatus({ id: 'current', state: 'running', backoffLevel: 0 });

    const result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'engine-unblocked');

    const [updatedRig] = await rigsBook.find({ where: [['id', '=', rig.id]] });
    const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'impl')!;
    assert.equal(impl.status, 'pending');
    assert.equal(impl.block, undefined);
    assert.equal(updatedRig.status, 'running');
  });
});
