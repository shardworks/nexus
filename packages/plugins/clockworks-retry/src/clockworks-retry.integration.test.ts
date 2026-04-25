/**
 * Clockworks-Retry — cross-plugin integration test.
 *
 * Co-boots Spider and the retry clockwork against a shared
 * MemoryBackend/Stacks/Clerk/Fabricator fixture and drives writs
 * through Spider's real `failEngine` path, asserting the full round
 * trip:
 *
 *   1. An engine-failure `retryable: true` stuck is observed by the
 *      retry clockwork → the writ transitions stuck → open → Spider
 *      spawns a second rig.
 *   2. An engine-failure `retryable: false` stuck is ignored.
 *   3. A `failed-blocker` stuck (dependency cause, no `retryable`) is
 *      ignored.
 *   4. When `rigs.length === MAX_RETRY_ATTEMPTS`, a `retryable: true`
 *      stuck is observed but *not* requeued.
 *
 * The status slot is accessed via `SpiderWritStatus`, never via a
 * duplicated path string. This test is the insurance that the producer
 * side (Spider's `failEngine`) and the reader side (the retry
 * clockwork's Phase 2 handler) agree on a single canonical shape — if
 * the two ever drift again, this test breaks.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
  KitEntry,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';

import {
  createSpider,
  type SpiderApi,
  type RigDoc,
  type RigTemplate,
  type SpiderEngineRunResult,
  type SpiderWritStatus,
} from '@shardworks/spider-apparatus';

import { createClockworksRetry } from './clockworks-retry.ts';
import { MAX_RETRY_ATTEMPTS } from './types.ts';

// ── Fixture helpers ───────────────────────────────────────────────────

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
    on() {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

/**
 * Minimal mock animator. The integration test never summons a session —
 * every engine we install is a pure clockwork design whose run() either
 * throws or returns a completed result. summon() is wired to throw so
 * any regression that starts invoking it surfaces loudly.
 */
const mockAnimator = {
  summon(): never {
    throw new Error('mock animator: summon() is not expected in this integration test');
  },
  animate(): never {
    throw new Error('mock animator: animate() is not expected in this integration test');
  },
  subscribeToSession(): null {
    return null;
  },
  async cancel(): Promise<never> {
    throw new Error('mock animator: cancel() is not expected in this integration test');
  },
};

/**
 * A fabricator engine design that throws from `run()` every time.
 * Spider's `tryRun` wraps `run()` in a try/catch that calls
 * `failEngine(..., { retryable: true, detail: ... })` on throw — the
 * production path for "engine throws during execution", the same path
 * the retry clockwork is built to observe.
 */
const alwaysThrowsEngine = {
  id: 'always-throws',
  async run(): Promise<SpiderEngineRunResult> {
    throw new Error('engine crashed deterministically');
  },
};

/**
 * A fabricator engine design that returns a duplicate-id graft. The
 * Spider's graft-validation path classifies this as retryable:false
 * and sends the rig to stuck via `failEngine`. The retry clockwork
 * must *not* requeue on this — definitional failures require human
 * attention.
 */
const badGrafterEngine = {
  id: 'bad-grafter',
  async run(): Promise<SpiderEngineRunResult> {
    return {
      status: 'completed',
      yields: { ok: true },
      // Duplicate id — the grafter's own id. Graft validation rejects
      // it and the rig lands stuck with retryable:false.
      graft: [{ id: 'bad-grafter', designId: 'bad-grafter', upstream: [] }],
    };
  },
};

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  spider: SpiderApi;
  /**
   * Drive the spider until `crawl()` returns null (no work remaining).
   * This is the only reliable stopping condition: the retry clockwork's
   * Phase 2 handler fires inline within the triggering transaction, so
   * by the time a failing `crawl()` resolves, any stuck → open transition
   * the clockwork chose to issue has already completed. Polling
   * `writ.phase === 'stuck'` between crawls therefore races — the writ
   * may already have been requeued before the poll fires. Drain to idle
   * and assert on the terminal state instead.
   */
  crawlToIdle: (maxTicks?: number) => Promise<void>;
  /** Run N crawl ticks back-to-back regardless of result. */
  crawlN: (n: number) => Promise<void>;
  /** Count rigs associated with the writ. */
  rigCount: (writId: string) => Promise<number>;
  /** Read the spider status slot with the shared canonical type. */
  readSpiderStatus: (writId: string) => Promise<SpiderWritStatus | undefined>;
}

function buildFixture(template: RigTemplate): Fixture {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();
  const retryPlugin = createClockworksRetry();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator must be apparatus');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider must be apparatus');
  if (!('apparatus' in retryPlugin)) throw new Error('retry must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    spider: {
      rigTemplates: { default: template },
      rigTemplateMappings: { mandate: 'default' },
    },
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild-integration',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() {},
    guildConfig() {
      return fakeGuildConfig;
    },
    kits(): LoadedKit[] {
      return [];
    },
    apparatuses(): LoadedApparatus[] {
      return [];
    },
    startupWarnings() {
      return [];
    },
  };
  setGuild(fakeGuild);

  // ── Stacks ─────────────────────────────────────────────────────
  const stacksApparatus = stacksPlugin.apparatus;
  stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the books the boot sequence expects.
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['status', 'rigId', 'engineId', 'createdAt', ['rigId', 'engineId', 'status']],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });

  // ── Mock animator (required by spider.start but not used here) ──
  apparatusMap.set('animator', mockAnimator);

  // ── Kit entries that need to flow to Clerk (linkKinds), Fabricator
  //     (engines), and Spider itself (blockTypes, rigTemplates, etc).
  const spiderAsLoaded: LoadedApparatus = {
    packageName: '@shardworks/spider-apparatus',
    id: 'spider',
    version: '0.0.0',
    apparatus: spiderPlugin.apparatus,
  };

  const customEnginesApparatus: LoadedApparatus = {
    packageName: '@test/clockworks-retry-integration-engines',
    id: 'test-custom-engines',
    version: '0.0.0',
    apparatus: {
      requires: [],
      supportKit: {
        engines: {
          'always-throws': alwaysThrowsEngine,
          'bad-grafter': badGrafterEngine,
        },
      },
      provides: {},
      start() {},
    },
  };

  const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded, customEnginesApparatus]);
  const clerkAndSpiderKitEntries = buildKitEntries([], [spiderAsLoaded]);

  // ── Clerk ──────────────────────────────────────────────────────
  // Clerk needs the spider.follows linkKind from Spider's supportKit so
  // `clerk.link(_, _, _, 'spider.follows')` is accepted in tests.
  const clerkApparatus = clerkPlugin.apparatus;
  clerkApparatus.start(buildCtx(clerkAndSpiderKitEntries));
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Fabricator ─────────────────────────────────────────────────
  const fabricatorApparatus = fabricatorPlugin.apparatus;
  fabricatorApparatus.start(buildCtx(fabricatorKitEntries));
  const fabricator = fabricatorApparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  // ── Spider ─────────────────────────────────────────────────────
  const spiderApparatus = spiderPlugin.apparatus;
  spiderApparatus.start(buildCtx(clerkAndSpiderKitEntries));
  const spider = spiderApparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  // ── Retry clockwork ────────────────────────────────────────────
  const retryApparatus = retryPlugin.apparatus;
  // The retry apparatus starts synchronously — it just registers a CDC
  // watcher. Await in case a future version adds async setup.
  void retryApparatus.start(buildCtx());
  apparatusMap.set('clockworks-retry', retryApparatus.provides);

  // ── Helpers ────────────────────────────────────────────────────
  async function crawlN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const r = await spider.crawl();
      if (r === null) return;
    }
  }

  /**
   * Drive Spider until `crawl()` returns null. The cap is defensive —
   * a genuine bug that loops forever should fail fast, not hang the
   * test runner. For these fixtures the expected tick budget is small
   * (~4 ticks for the happy-path retry loop).
   */
  async function crawlToIdle(maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      const r = await spider.crawl();
      if (r === null) return;
    }
    throw new Error(`crawlToIdle: spider still active after ${maxTicks} ticks`);
  }

  async function rigCount(writId: string): Promise<number> {
    return stacks.book<RigDoc>('spider', 'rigs').count([['writId', '=', writId]]);
  }

  async function readSpiderStatus(writId: string): Promise<SpiderWritStatus | undefined> {
    const writ = await clerk.show(writId);
    return writ.status?.spider as SpiderWritStatus | undefined;
  }

  return { stacks, clerk, spider, crawlToIdle, crawlN, rigCount, readSpiderStatus };
}

async function postMandate(clerk: ClerkApi, title = 'integration writ'): Promise<WritDoc> {
  // Mandate writs land in `new` from `post()`; spider's crawl picks up
  // open writs, so we publish the writ to `open` here.
  const writ = await clerk.post({ title, body: 'body', type: 'mandate' });
  return clerk.transition(writ.id, 'open');
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Clockworks-Retry × Spider — cross-plugin round trip', () => {
  let fix: Fixture;

  afterEach(() => {
    clearGuild();
  });

  describe('engine-failure no longer writes stuck+retryable (post engine-level retry reshape)', () => {
    // After the engine-level retry and rig-status rollup commission, the
    // Spider's engine-failure path no longer writes status.spider.retryable
    // (D19) and no longer transitions rigs through `'stuck'`. Retryable
    // failures retry in-place inside the rig up to the engine design's
    // `retry.maxAttempts` budget; terminal exhaustion sets rig.status =
    // 'failed' which cascades the writ directly to phase='failed'.
    //
    // These two tests exercise the new contract — clockworks-retry's
    // trigger condition is never met on the engine-failure path, so the
    // writ does not come back to 'open' and no second rig spawns.
    const template: RigTemplate = {
      engines: [{ id: 'thrower', designId: 'always-throws', givens: {} }],
    };

    beforeEach(() => {
      fix = buildFixture(template);
    });

    it('engine-failure drives the writ directly to phase=failed — clockworks-retry does not fire', async () => {
      const writ = await postMandate(fix.clerk);

      // Spin the crawl to idle. With the always-throws engine and no
      // retry config on it, the first attempt immediately fails
      // terminally, the rig rollup projects rig.status='failed', and
      // the rigs→writs CDC transitions the writ directly to
      // phase='failed'. Clockworks-retry only fires on stuck entry, so
      // its trigger condition is never met.
      await fix.crawlToIdle();

      assert.equal(await fix.rigCount(writ.id), 1,
        'exactly one rig — no second attempt because clockworks-retry never fires on the new engine-failure path');

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'failed',
        'writ transitions directly to failed — no intermediate stuck in the new model');
    });

    it('the writ.status.spider slot is NOT populated on the engine-failure path', async () => {
      const writ = await postMandate(fix.clerk);

      await fix.crawlToIdle();

      const status = await fix.readSpiderStatus(writ.id);
      // The engine-failure path no longer writes status.spider (D19) —
      // the slot may be absent entirely, or present-but-empty. Either
      // way, `stuckCause='engine-failure'` and `retryable` are gone.
      if (status !== undefined && status !== null) {
        assert.notEqual(status.stuckCause, 'engine-failure',
          'engine-failure cause must not be written on the new engine-failure path');
      }
    });
  });

  describe('retryable: false graft failure → writ direct-to-failed (post reshape)', () => {
    // Definitional failures (invalid graft, unknown design, etc.) now
    // fail the rig terminally on first observation, regardless of
    // retry config. The writ goes straight to failed; clockworks-retry
    // never fires.
    const template: RigTemplate = {
      engines: [{ id: 'grafter', designId: 'bad-grafter', givens: {} }],
    };

    beforeEach(() => {
      fix = buildFixture(template);
    });

    it('writ goes directly to phase=failed; clockworks-retry stays silent', async () => {
      const writ = await postMandate(fix.clerk);

      await fix.crawlToIdle();

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'failed',
        'definitional failure goes straight to failed — no stuck, no retry');
      assert.equal(await fix.rigCount(writ.id), 1,
        'exactly one rig — no retry path active');
    });
  });

  describe('failed-blocker dependency stuck → ignored', () => {
    const template: RigTemplate = {
      engines: [{ id: 'thrower', designId: 'always-throws', givens: {} }],
    };

    beforeEach(() => {
      fix = buildFixture(template);
    });

    it('dependent stuck via stuckFromGate carries no retryable and is left alone', async () => {
      const blocker = await postMandate(fix.clerk, 'blocker');
      const dependent = await postMandate(fix.clerk, 'dependent');
      await fix.clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');
      await fix.clerk.transition(blocker.id, 'failed', { resolution: 'boom' });

      // Spider's gate evaluation sticks the dependent with
      // stuckCause='failed-blocker' and does NOT set `retryable` — it
      // only writes stuckCause / blockerIds / observedAt. The retry
      // clockwork's trigger condition must key on `retryable`, not on
      // `stuckCause`, so this stuck must not be requeued.
      await fix.crawlToIdle();

      const status = await fix.readSpiderStatus(dependent.id);
      assert.ok(status, 'failed-blocker stucks write status.spider');
      assert.equal(status!.stuckCause, 'failed-blocker');
      assert.equal(status!.retryable, undefined,
        'gating-path stucks must not carry the retryable flag');

      await fix.crawlN(5);

      const after = await fix.clerk.show(dependent.id);
      assert.equal(after.phase, 'stuck',
        'dependency-blocked writ must stay stuck — not a retry candidate');
    });
  });
});
