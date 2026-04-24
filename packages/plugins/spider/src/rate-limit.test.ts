/**
 * Spider — rate-limit integration tests.
 *
 * After the engine-level retry + rig-status rollup reshape:
 *
 *  - tryCollect on `rate-limited` session status now routes the engine
 *    through the unified failure handler's rate-limit branch: the
 *    engine returns to `pending` with `holdReason='rate-limit'` +
 *    `holdCondition={ sessionId }` and does NOT consume a retry
 *    attempt. The rig stays `running` (status is a pure projection).
 *  - The dispatch predicate's external-gate check delegates to the
 *    `animator-paused` BlockType's `check()`. When the Animator is
 *    running again, the predicate clears the hold and dispatches.
 *  - `isAnimatorPaused` continues to guard `trySpawn` only, so the
 *    pause short-circuit still prevents new rigs from spawning while
 *    Animator is paused.
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
  let status: AnimatorStatusDoc = { id: 'dispatch-status', state: 'running', backoffLevel: 0 };
  // (was `id: 'current'` before the dispatch-status relocation)

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

  it('tryCollect on rate-limited session transitions the engine to pending + holdReason="rate-limit"', async () => {
    const writ = await fix.clerk.post({ title: 'rate-limit collect test' });
    // Spawn the rig.
    await fix.spider.crawl();

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });

    const fakeSessionId = generateId('ses', 4);
    // Simulate a dispatched engine: status=running with an attempt carrying sessionId.
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'impl'
        ? {
            ...e,
            status: 'running' as const,
            attempts: [{ startedAt: new Date().toISOString(), sessionId: fakeSessionId }],
            attemptCount: 0,
          }
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
    assert.equal(result!.action, 'engine-held');
    assert.equal((result as { holdReason: string }).holdReason, 'rate-limit');

    const [updatedRig] = await rigsBook.find({ where: [['id', '=', rig.id]] });
    const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'impl')!;
    assert.equal(impl.status, 'pending');
    assert.equal(impl.holdReason, 'rate-limit');
    assert.deepEqual(impl.holdCondition, { sessionId: fakeSessionId });
    assert.equal(impl.attemptCount, 0, 'rate-limit must not consume retry budget');
    // Rig status is a projection — with the only engine pending, rig stays 'running'.
    assert.equal(updatedRig.status, 'running');
  });

  it('crawl() does not spawn a new rig when the Animator is paused (trySpawn gate)', async () => {
    fix.setStatus({
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date().toISOString(),
      pausedUntil: new Date(Date.now() + 60_000).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 0,
    });

    // Post a writ — trySpawn would normally pick this up.
    await fix.clerk.post({ title: 'paused gate test' });

    const result = await fix.spider.crawl();
    assert.equal(result, null);

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const rigs = await rigsBook.list();
    assert.equal(rigs.length, 0);
  });

  it('crawl() spawns normally once the pause window elapses', async () => {
    fix.setStatus({
      id: 'dispatch-status',
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

  it('dispatch predicate clears an animator-paused hold when the Animator returns to running', async () => {
    const writ = await fix.clerk.post({ title: 'unblock test' });
    await fix.spider.crawl(); // spawn

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    // Seed an engine in the new pending+hold shape.
    const heldEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'impl'
        ? {
            ...e,
            status: 'pending' as const,
            holdReason: 'animator-paused',
            holdCondition: { sessionId: 'ses-old' },
            lastCheckedAt: new Date(0).toISOString(),
          }
        : e,
    );
    await rigsBook.patch(rig.id, { engines: heldEngines });

    // With the Animator reporting running, the dispatch predicate
    // should clear the hold and dispatch. The mocked animator's
    // summon throws when called, so this will fail fast once
    // tryRun reaches it — but the important assertion is that the
    // engine left the held state.
    fix.setStatus({ id: 'dispatch-status', state: 'running', backoffLevel: 0 });

    // Crawl once — the dispatch predicate clears the hold, tryRun
    // calls summon() which throws (mock), and the failure handler
    // retries or fails. We don't assert the outcome; we assert the
    // hold fields were cleared / dispatched-past.
    await fix.spider.crawl();

    const [after] = await rigsBook.find({ where: [['id', '=', rig.id]] });
    const impl = after.engines.find((e: EngineInstance) => e.id === 'impl')!;
    // Either the engine is now running, or has been retried
    // (pending+holdReason=retry-backoff), or has been terminally failed.
    // What it must NOT be: pending with holdReason='animator-paused'.
    assert.notEqual(impl.holdReason, 'animator-paused',
      'animator-paused hold must be cleared when the predicate sees cleared state');
  });
});
