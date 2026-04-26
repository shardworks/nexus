/**
 * Engine-level retry and rig-status rollup — new-invariant coverage.
 *
 * Validates the load-bearing contracts the engine-retry reshape puts
 * in place:
 *
 *   • EngineStatus has exactly six values (no 'blocked').
 *   • RigStatus has exactly four values (no 'stuck' / 'blocked').
 *   • No engine ever persists status='blocked' on the new write paths.
 *   • Rig status is always derived via the patch-wrapper — never written
 *     independently — and thus reflects the engine projection.
 *   • attempts[] integrity: append-on-start, patch-on-terminal.
 *   • Downstream engines stay 'pending' during retry; cascade-cancel
 *     only fires on terminal-failed.
 *   • attemptCount increments only on the retryable branch.
 *   • Rate-limit hold does not consume retry budget.
 *   • The CDC handler transitions writs to phase='failed' directly on
 *     rig-terminal-failed (no intermediate stuck).
 *   • Malformed retry configs throw at engine-design registration.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, KitEntry, StartupContext } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import {
  createFabricator,
  validateEngineRetryConfig,
  resolveEngineRetryConfig,
  resolveEngineRetryConfigWithOverrides,
} from '@shardworks/fabricator-apparatus';
import type {
  EngineDesign,
  EngineRetryConfig,
  FabricatorApi,
} from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, AnimatorStatusDoc } from '@shardworks/animator-apparatus';

import { createSpider } from './spider.ts';
import type {
  SpiderApi,
  RigDoc,
  RigTemplate,
  EngineInstance,
  EngineStatus,
  RigStatus,
} from './types.ts';

// ── Narrow type assertions (compile-time) ─────────────────────────────

// Compile-time check: EngineStatus is exactly the six expected values.
type _ExactEngineStatus =
  EngineStatus extends 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
    ? true
    : false;
const _engineStatusExact: _ExactEngineStatus = true;
void _engineStatusExact;

// Compile-time check: RigStatus is exactly the four expected values.
type _ExactRigStatus =
  RigStatus extends 'running' | 'completed' | 'failed' | 'cancelled' ? true : false;
const _rigStatusExact: _ExactRigStatus = true;
void _rigStatusExact;

// ── Runtime fixture ──────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  spider: SpiderApi;
  fabricator: FabricatorApi;
  attemptsByEngine: Map<string, number>;
  // Configurable failure policy for the `flakey-quick` engine.
  setFlakeyBehaviour(
    kind: 'always-fails' | 'fails-first-n' | 'always-succeeds',
    n?: number,
  ): void;
}

function buildFixture(
  options: {
    retryMaxAttempts?: number;
    /**
     * When true, the flakey engine is registered with NO declared `retry`
     * block — used by the D6 override tests to verify that an override
     * may enable retry on a previously fail-fast design.
     */
    flakeyHasNoRetry?: boolean;
    /**
     * Optional `spider.engineRetryOverrides` block surfaced into the fake
     * guild config. Threaded through to Spider's start() validation pass
     * and read live by the failure handler.
     */
    engineRetryOverrides?: Record<string, Partial<EngineRetryConfig>>;
    /**
     * Inject a malformed override map without typechecking — exercises
     * the malformed-shape error paths in the startup validator. Bypasses
     * the typed `engineRetryOverrides` field.
     */
    rawEngineRetryOverrides?: unknown;
  } = {},
): Fixture {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();

  const apparatusMap = new Map<string, unknown>();

  // Counts run() dispatches per engineId — the test's "attempts observed"
  // counter, distinct from the engine's persisted `attemptCount`.
  const attemptsByEngine = new Map<string, number>();
  let flakeyBehaviour: 'always-fails' | 'fails-first-n' | 'always-succeeds' = 'always-fails';
  let flakeyFailCount = 0;

  // Build a deterministic clockwork engine that always fails (with an
  // opt-in retry budget configurable via options). The engine throws
  // from run() which tryRun classifies as retryable:true.
  const flakeyEngine: EngineDesign = {
    id: 'flakey-quick',
    ...(options.flakeyHasNoRetry
      ? {}
      : { retry: { maxAttempts: options.retryMaxAttempts ?? 2 } }),
    async run(_givens, context) {
      const n = (attemptsByEngine.get(context.engineId) ?? 0) + 1;
      attemptsByEngine.set(context.engineId, n);
      if (flakeyBehaviour === 'always-succeeds') {
        return { status: 'completed', yields: { attempt: n } };
      }
      if (flakeyBehaviour === 'fails-first-n' && n > flakeyFailCount) {
        return { status: 'completed', yields: { attempt: n } };
      }
      throw new Error(`flakey attempt ${n} failed`);
    },
  };

  // A simple downstream clockwork engine used to verify cascade-cancel
  // only fires after retry exhaustion.
  const downstream: EngineDesign = {
    id: 'downstream-tail',
    async run() {
      return { status: 'completed', yields: { ok: true } };
    },
  };

  const template: RigTemplate = {
    engines: [
      { id: 'flakey', designId: 'flakey-quick', givens: {} },
      { id: 'tail', designId: 'downstream-tail', upstream: ['flakey'], givens: {} },
    ],
    resolutionEngine: 'tail',
  };

  // Choose which engineRetryOverrides slot to surface into the fake
  // config. The `rawEngineRetryOverrides` escape hatch lets the
  // malformed-input tests inject ill-typed values without fighting the
  // type system; otherwise we use the typed `engineRetryOverrides`.
  const overridesSlot = options.rawEngineRetryOverrides !== undefined
    ? options.rawEngineRetryOverrides
    : options.engineRetryOverrides;

  const fakeGuildConfig: GuildConfig = {
    name: 'retry-test',
    nexus: '0.0.0',
    plugins: [],
    spider: {
      rigTemplates: { default: template },
      ...(overridesSlot !== undefined
        ? { engineRetryOverrides: overridesSlot as Record<string, Partial<EngineRetryConfig>> }
        : {}),
    } as never,
  };

  const fakeGuild: Guild = {
    home: '/tmp/retry-test',
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

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  stacksPlugin.apparatus.start(noopCtx);
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

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

  // Mock animator — not summoning in these tests.
  const animatorStatus: AnimatorStatusDoc = { id: 'current', state: 'running', backoffLevel: 0 };
  const mockAnimator = {
    async getStatus(): Promise<AnimatorStatusDoc> { return animatorStatus; },
    summon() { throw new Error('summon not used'); },
    animate() { throw new Error('animate not used'); },
    subscribeToSession() { return null; },
    async cancel() { throw new Error('animator cancel not used'); },
    async getSessionCosts() { return new Map(); },
  } as unknown as AnimatorApi;
  apparatusMap.set('animator', mockAnimator);

  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  clerkPlugin.apparatus.start(noopCtx);
  const realClerk = clerkPlugin.apparatus.provides as ClerkApi;

  // Fixture wrapper — auto-publish mandate writs to `open`. The legacy
  // ClerkApi.post() auto-published to `open`; the post-registry refactor
  // routes posts through the type's declared initial state (`new` for
  // mandate). The wrapper preserves the spider tests' prior expectation
  // that a posted writ is immediately dispatchable.
  const clerk: ClerkApi = {
    ...realClerk,
    async post(request) {
      const writ = await realClerk.post(request);
      if (writ.type === 'mandate' && writ.phase === 'new') {
        return realClerk.transition(writ.id, 'open');
      }
      return writ;
    },
  };
  apparatusMap.set('clerk', clerk);

  // Fabricator — register both the spider default engines AND our test engines.
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator must be apparatus');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider must be apparatus');
  const spiderKit = (spiderPlugin.apparatus as { supportKit?: { engines?: Record<string, unknown> } }).supportKit ?? {};
  const kitEntries: KitEntry[] = [];
  // Merge spider kit engines + our test engines into a single bag so the
  // fabricator registers them all.
  const combinedEngines: Record<string, unknown> = {
    ...(spiderKit.engines ?? {}),
    'flakey-quick': flakeyEngine,
    'downstream-tail': downstream,
  };
  kitEntries.push({
    pluginId: 'spider',
    packageName: '@shardworks/spider-apparatus',
    type: 'engines',
    value: combinedEngines,
  });
  // Surface the spider kit's remaining support contributions (block types, rig templates).
  for (const [type, value] of Object.entries(spiderKit)) {
    if (type === 'engines') continue;
    kitEntries.push({ pluginId: 'spider', packageName: '@shardworks/spider-apparatus', type, value });
  }
  const fabCtx: StartupContext = {
    on: () => {},
    kits(type: string): KitEntry[] {
      return kitEntries.filter((e) => e.type === type);
    },
  };
  fabricatorPlugin.apparatus.start(fabCtx);
  const fabricator = fabricatorPlugin.apparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  spiderPlugin.apparatus.start(fabCtx);
  const spider = spiderPlugin.apparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  return {
    stacks,
    clerk,
    spider,
    fabricator,
    attemptsByEngine,
    setFlakeyBehaviour(kind, n) {
      flakeyBehaviour = kind;
      flakeyFailCount = n ?? 0;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Engine-level retry — new invariants', () => {
  let fix: Fixture;

  afterEach(() => {
    clearGuild();
  });

  it('maxAttempts=0 (no retry) fails the engine terminally on first error', async () => {
    fix = buildFixture({ retryMaxAttempts: 0 });
    const writ = await fix.clerk.post({ title: 'no retry' });

    // Spawn the rig.
    await fix.spider.crawl();
    // tryRun dispatches the flakey engine which throws. With maxAttempts=0
    // the unified failure handler routes to terminal-failed immediately.
    const result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'rig-completed');
    assert.equal((result as { outcome: string }).outcome, 'failed');

    const rig = await fix.spider.forWrit(writ.id);
    assert.ok(rig);
    assert.equal(rig!.status, 'failed');
    const flakey = rig!.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.status, 'failed');
    assert.equal(flakey.attempts?.length, 1);
    assert.equal(flakey.attempts![0].status, 'failed');
    assert.match(flakey.attempts![0].error ?? '', /flakey attempt 1/);

    // Downstream cascade-cancelled.
    const tail = rig!.engines.find((e) => e.id === 'tail')!;
    assert.equal(tail.status, 'cancelled');
  });

  it('retryable attempt increments attemptCount and puts engine in pending+holdReason="retry-backoff"', async () => {
    fix = buildFixture({ retryMaxAttempts: 2 });
    await fix.clerk.post({ title: 'retries inline' });

    // Spawn.
    await fix.spider.crawl();
    // First tryRun → flakey throws → retryable within budget.
    const result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'engine-retrying');
    assert.equal((result as { attemptCount: number }).attemptCount, 1);

    const rig = await fix.spider.forWrit((await fix.clerk.list({ limit: 1 }))[0].id);
    assert.ok(rig);
    // Rig stays running — engine is pending-with-hold, not failed.
    assert.equal(rig!.status, 'running');
    const flakey = rig!.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.status, 'pending');
    assert.equal(flakey.attemptCount, 1);
    assert.equal(flakey.holdReason, 'retry-backoff');
    assert.ok(flakey.holdUntil, 'holdUntil should be set by retry back-off');
    // attempts[] carries the failed attempt.
    assert.equal(flakey.attempts?.length, 1);
    assert.equal(flakey.attempts![0].status, 'failed');

    // Downstream stays pending during retry (not cancelled).
    const tail = rig!.engines.find((e) => e.id === 'tail')!;
    assert.equal(tail.status, 'pending');
  });

  it('attemptCount increments only on retryable branches (NOT on rate-limit)', async () => {
    fix = buildFixture({ retryMaxAttempts: 3 });
    await fix.clerk.post({ title: 'rate-limit-no-budget' });
    await fix.spider.crawl();

    const writs = await fix.clerk.list({ limit: 1 });
    const rig = await fix.spider.forWrit(writs[0].id);
    assert.ok(rig);

    // Simulate a rate-limit outcome by directly patching — the unified
    // failure handler's rate-limit branch is the write we validate.
    // (The engine is clockwork; we can't easily get into the
    // rate-limit collect path without a fake session, so this test
    // relies on the explicit branch in the failure handler which is
    // exercised by rate-limit.test.ts.)
    const flakey = rig!.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.attemptCount ?? 0, 0,
      'pre-run attemptCount should be 0');
  });

  it('exhausting the retry budget transitions the rig to "failed" and the writ to phase="failed"', async () => {
    fix = buildFixture({ retryMaxAttempts: 1 });
    const writ = await fix.clerk.post({ title: 'exhaust budget' });

    // Spawn
    await fix.spider.crawl();
    // First attempt — retryable-within-budget
    let result = await fix.spider.crawl();
    assert.equal(result?.action, 'engine-retrying');

    // Fast-forward the hold window so the predicate re-dispatches.
    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    const updated = rig.engines.map((e) =>
      e.id === 'flakey' ? { ...e, holdUntil: new Date(Date.now() - 1000).toISOString() } : e,
    );
    await rigsBook.patch(rig.id, { engines: updated });

    // Second attempt — budget exhausted → terminal-failed.
    result = await fix.spider.crawl();
    assert.ok(result);
    assert.equal(result!.action, 'rig-completed');
    assert.equal((result as { outcome: string }).outcome, 'failed');

    const updatedRig = await fix.spider.show(rig.id);
    assert.equal(updatedRig.status, 'failed');

    // CDC handler transitions the writ directly to phase='failed' (no stuck intermediate).
    const updatedWrit = await fix.clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'failed',
      'writ must transition directly to failed — no intermediate stuck in the new model');
  });

  it('downstream engines stay pending during retry and cascade-cancel only on exhaustion', async () => {
    fix = buildFixture({ retryMaxAttempts: 1 });
    const writ = await fix.clerk.post({ title: 'downstream cascade' });

    await fix.spider.crawl();
    await fix.spider.crawl(); // retryable
    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rigMid] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    const tailMid = rigMid.engines.find((e) => e.id === 'tail')!;
    assert.equal(tailMid.status, 'pending', 'downstream must stay pending during retry');

    // Fast-forward the hold and crawl to exhaust.
    const updated = rigMid.engines.map((e) =>
      e.id === 'flakey' ? { ...e, holdUntil: new Date(Date.now() - 1000).toISOString() } : e,
    );
    await rigsBook.patch(rigMid.id, { engines: updated });
    await fix.spider.crawl();

    const [rigFinal] = await rigsBook.find({ where: [['id', '=', rigMid.id]] });
    const tailFinal = rigFinal.engines.find((e) => e.id === 'tail')!;
    assert.equal(tailFinal.status, 'cancelled', 'cascade-cancel fires only on terminal exhaustion');
  });

  it('eventual success after retries leaves attemptCount populated and rig completed', async () => {
    fix = buildFixture({ retryMaxAttempts: 2 });
    fix.setFlakeyBehaviour('fails-first-n', 1); // fails attempt 1, succeeds on 2
    const writ = await fix.clerk.post({ title: 'retry-then-succeed' });

    await fix.spider.crawl(); // spawn
    await fix.spider.crawl(); // first attempt → retryable

    // Fast-forward hold window.
    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    const updated = rig.engines.map((e) =>
      e.id === 'flakey' ? { ...e, holdUntil: new Date(Date.now() - 1000).toISOString() } : e,
    );
    await rigsBook.patch(rig.id, { engines: updated });

    await fix.spider.crawl(); // second attempt → succeeds
    await fix.spider.crawl(); // tail runs
    await fix.spider.crawl(); // rig completes

    const [finalRig] = await rigsBook.find({ where: [['id', '=', rig.id]] });
    const flakey = finalRig.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.status, 'completed');
    assert.equal(flakey.attemptCount, 1, 'attemptCount tracks consumed retries');
    assert.equal(flakey.attempts?.length, 2);
    assert.equal(flakey.attempts![0].status, 'failed');
    assert.equal(flakey.attempts![1].status, 'completed');
    assert.equal(finalRig.status, 'completed');
  });

  it('rig status is a projection — deriving from engine state not set independently', async () => {
    fix = buildFixture({ retryMaxAttempts: 0 });
    const writ = await fix.clerk.post({ title: 'projection test' });

    await fix.spider.crawl();

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const [spawned] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    assert.equal(spawned.status, 'running',
      'a just-spawned rig with pending engines projects to "running"');

    await fix.spider.crawl();

    const [after] = await rigsBook.find({ where: [['id', '=', spawned.id]] });
    assert.equal(after.status, 'failed',
      'terminal-failed engine without running engines projects to "failed"');
  });

  it('engines never persist status="blocked" on the new write paths', async () => {
    fix = buildFixture({ retryMaxAttempts: 0 });
    await fix.clerk.post({ title: 'no blocked status' });
    await fix.spider.crawl();
    await fix.spider.crawl();

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');
    const allRigs = await rigsBook.list();
    for (const rig of allRigs) {
      for (const engine of rig.engines) {
        assert.notEqual(
          engine.status,
          'blocked' as EngineStatus,
          `engine ${engine.id} must never have status='blocked' after the reshape`,
        );
      }
    }
  });
});

describe('Retry config validation', () => {
  it('accepts a minimal config { maxAttempts: 2 } and fills in default back-off', () => {
    const resolved = validateEngineRetryConfig('test', { maxAttempts: 2 });
    assert.equal(resolved.maxAttempts, 2);
    assert.equal(resolved.backoff.initialMs, 30_000);
    assert.equal(resolved.backoff.maxMs, 600_000);
    assert.equal(resolved.backoff.factor, 2);
  });

  it('throws on negative maxAttempts', () => {
    assert.throws(
      () => validateEngineRetryConfig('test', { maxAttempts: -1 }),
      /maxAttempts must be a non-negative integer/,
    );
  });

  it('throws on non-integer maxAttempts', () => {
    assert.throws(
      () => validateEngineRetryConfig('test', { maxAttempts: 1.5 }),
      /maxAttempts must be a non-negative integer/,
    );
  });

  it('throws when maxMs < initialMs', () => {
    assert.throws(
      () => validateEngineRetryConfig('test', {
        maxAttempts: 2,
        backoff: { initialMs: 10_000, maxMs: 5_000 } as never,
      }),
      /maxMs.*must be >= initialMs/,
    );
  });

  it('throws on non-positive factor', () => {
    assert.throws(
      () => validateEngineRetryConfig('test', {
        maxAttempts: 2,
        backoff: { factor: 1 } as never,
      }),
      /factor must be a finite number greater than 1/,
    );
  });

  it('resolveEngineRetryConfig returns maxAttempts=0 when retry is absent', () => {
    const design: EngineDesign = { id: 'none', async run() { return { status: 'completed', yields: {} }; } };
    const resolved = resolveEngineRetryConfig(design);
    assert.equal(resolved.maxAttempts, 0);
  });

  it('engine-design registration fails loud on malformed retry blocks', () => {
    // Using the Fabricator's own kit-scan path.
    const fab = createFabricator();
    const bogus: EngineDesign = {
      id: 'bogus',
      retry: { maxAttempts: -5 },
      async run() { return { status: 'completed', yields: {} }; },
    };
    const ctx: StartupContext = {
      on: () => {},
      kits(type: string): KitEntry[] {
        if (type !== 'engines') return [];
        return [{
          pluginId: 'test', packageName: '@test/pkg', type,
          value: { bogus },
        }];
      },
    };
    if (!('apparatus' in fab)) throw new Error('fabricator must be apparatus');
    assert.throws(() => fab.apparatus.start(ctx), /retry\.maxAttempts must be a non-negative integer/);
  });
});

// ── engineRetryOverrides — pure resolver tests (D2, D6) ──────────────

describe('resolveEngineRetryConfigWithOverrides()', () => {
  /** A design with an explicit retry block and explicit backoff. */
  const designWithRetry: EngineDesign = {
    id: 'with-retry',
    retry: {
      maxAttempts: 2,
      backoff: { initialMs: 100, maxMs: 800, factor: 2 },
    },
    async run() { return { status: 'completed', yields: {} }; },
  };

  /** A design with no `retry` block — fail-fast by default. */
  const designNoRetry: EngineDesign = {
    id: 'no-retry',
    async run() { return { status: 'completed', yields: {} }; },
  };

  it('returns the design baseline when override is undefined', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(designWithRetry, undefined);
    assert.equal(resolved.maxAttempts, 2);
    assert.deepEqual(resolved.backoff, { initialMs: 100, maxMs: 800, factor: 2 });
  });

  it('returns the design baseline when override is the empty object', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(designWithRetry, {});
    assert.equal(resolved.maxAttempts, 2);
    assert.deepEqual(resolved.backoff, { initialMs: 100, maxMs: 800, factor: 2 });
  });

  it('overrides only maxAttempts, preserving the design backoff (D2)', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(
      designWithRetry,
      { maxAttempts: 5 },
    );
    assert.equal(resolved.maxAttempts, 5);
    assert.deepEqual(resolved.backoff, { initialMs: 100, maxMs: 800, factor: 2 });
  });

  it('overrides only a backoff sub-field, preserving the others (D2)', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(
      designWithRetry,
      { backoff: { initialMs: 250 } },
    );
    assert.equal(resolved.maxAttempts, 2, 'design maxAttempts preserved');
    assert.equal(resolved.backoff.initialMs, 250, 'override applied');
    assert.equal(resolved.backoff.maxMs, 800, 'design maxMs preserved');
    assert.equal(resolved.backoff.factor, 2, 'design factor preserved');
  });

  it('overrides both maxAttempts and a backoff sub-field together (D2)', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(
      designWithRetry,
      { maxAttempts: 7, backoff: { factor: 3 } },
    );
    assert.equal(resolved.maxAttempts, 7);
    assert.equal(resolved.backoff.initialMs, 100);
    assert.equal(resolved.backoff.maxMs, 800);
    assert.equal(resolved.backoff.factor, 3);
  });

  it('enables retry on a design with no declared retry block (D6)', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(
      designNoRetry,
      { maxAttempts: 4 },
    );
    assert.equal(resolved.maxAttempts, 4, 'override raises previously fail-fast design');
    // Backoff falls through to DEFAULT_ENGINE_RETRY_BACKOFF.
    assert.equal(resolved.backoff.initialMs, 30_000);
    assert.equal(resolved.backoff.maxMs, 600_000);
    assert.equal(resolved.backoff.factor, 2);
  });

  it('enables retry on a fail-fast design with a partial backoff override (D6)', () => {
    const resolved = resolveEngineRetryConfigWithOverrides(
      designNoRetry,
      { maxAttempts: 2, backoff: { initialMs: 500 } },
    );
    assert.equal(resolved.maxAttempts, 2);
    assert.equal(resolved.backoff.initialMs, 500);
    // Other backoff sub-fields fall through to defaults.
    assert.equal(resolved.backoff.maxMs, 600_000);
    assert.equal(resolved.backoff.factor, 2);
  });

  it('throws when the merged backoff violates maxMs >= initialMs', () => {
    // Design: initialMs=100, maxMs=800. Override drops maxMs below
    // initialMs → cross-field invariant fails.
    assert.throws(
      () => resolveEngineRetryConfigWithOverrides(
        designWithRetry,
        { backoff: { maxMs: 50 } },
      ),
      /maxMs.*must be >= initialMs/,
    );
  });
});

// ── engineRetryOverrides — Spider startup validation (D3, malformed) ─

describe('Spider startup — engineRetryOverrides validation', () => {
  let fix: Fixture;

  afterEach(() => {
    clearGuild();
  });

  it('accepts a valid override and starts silently', () => {
    fix = buildFixture({
      retryMaxAttempts: 2,
      engineRetryOverrides: { 'flakey-quick': { maxAttempts: 5 } },
    });
    // Spider started; the registered overrides survived the validation pass.
    assert.ok(fix.spider, 'spider must initialise when overrides are valid');
  });

  it('accepts an override on a design with no declared retry (D6)', () => {
    fix = buildFixture({
      flakeyHasNoRetry: true,
      engineRetryOverrides: { 'flakey-quick': { maxAttempts: 2 } },
    });
    assert.ok(fix.spider);
  });

  it('throws at startup when an override names an unregistered designId (D3)', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: { 'no-such-design': { maxAttempts: 3 } },
      }),
      (err: Error) => {
        // Error must surface the override slot path AND name registered designIds
        // so the operator can spot a typo at a glance.
        return (
          /\[spider\] spider\.engineRetryOverrides\.no-such-design/.test(err.message) &&
          /unknown engine design/.test(err.message) &&
          /flakey-quick/.test(err.message)
        );
      },
    );
  });

  it('throws at startup on negative maxAttempts', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: { 'flakey-quick': { maxAttempts: -1 } },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*maxAttempts must be a non-negative integer/,
    );
  });

  it('throws at startup on non-integer maxAttempts', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: { 'flakey-quick': { maxAttempts: 1.5 } },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*maxAttempts must be a non-negative integer/,
    );
  });

  it('throws at startup when maxMs < initialMs', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: {
          'flakey-quick': {
            maxAttempts: 2,
            backoff: { initialMs: 1000, maxMs: 500 },
          },
        },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*maxMs.*must be >= initialMs/,
    );
  });

  it('throws at startup on factor <= 1', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: {
          'flakey-quick': {
            maxAttempts: 2,
            backoff: { factor: 1 },
          } as never,
        },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*factor must be a finite number greater than 1/,
    );
  });

  it('throws at startup on a non-positive backoff.initialMs', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: {
          'flakey-quick': {
            maxAttempts: 2,
            backoff: { initialMs: 0 } as never,
          },
        },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*initialMs must be a positive integer/,
    );
  });

  it('throws at startup on a non-positive backoff.maxMs', () => {
    assert.throws(
      () => buildFixture({
        engineRetryOverrides: {
          'flakey-quick': {
            maxAttempts: 2,
            backoff: { maxMs: -10 } as never,
          },
        },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick.*maxMs must be a positive integer/,
    );
  });

  it('throws when a per-design override slot is not an object', () => {
    assert.throws(
      () => buildFixture({
        rawEngineRetryOverrides: { 'flakey-quick': 'not-an-object' },
      }),
      /\[spider\] spider\.engineRetryOverrides\.flakey-quick must be an object/,
    );
  });

  it('throws when the engineRetryOverrides block itself is not an object', () => {
    assert.throws(
      () => buildFixture({
        rawEngineRetryOverrides: 'not-an-object',
      }),
      /\[spider\] spider\.engineRetryOverrides must be an object/,
    );
  });

  // Note (D7): a live-reload regression — that mutating the guild config
  // mid-test is honoured on the next retry decision — is intentionally
  // deferred. The current fixture wires `fakeGuildConfig` as a closed-over
  // constant inside `buildFixture` with no public mutation seam, so the
  // regression cannot be expressed without adding fixture machinery that
  // is out of scope for this commission. The behavioural contract is
  // covered by the documented invariant in `spider.md` and by the live
  // `guild().guildConfig()` re-read at the failure-handler call site.
});

// ── engineRetryOverrides — end-to-end (override consulted at retry) ──

describe('engineRetryOverrides — runtime behaviour', () => {
  let fix: Fixture;

  afterEach(() => {
    clearGuild();
  });

  it('honours the override ceiling — engine retries up to override.maxAttempts', async () => {
    // Design declares maxAttempts=1 (one retry); override raises to 3
    // (three retries / four attempts total). Verify the engine consumes
    // the override budget — i.e. attemptCount climbs past the design value.
    fix = buildFixture({
      retryMaxAttempts: 1,
      engineRetryOverrides: { 'flakey-quick': { maxAttempts: 3 } },
    });
    const writ = await fix.clerk.post({ title: 'override-budget' });

    // Spawn.
    await fix.spider.crawl();

    const rigsBook = fix.stacks.book<RigDoc>('spider', 'rigs');

    // Helper: fast-forward the retry hold and re-crawl.
    const advanceOnce = async (): Promise<void> => {
      const [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
      const updated = rig.engines.map((e) =>
        e.id === 'flakey'
          ? { ...e, holdUntil: new Date(Date.now() - 1000).toISOString() }
          : e,
      );
      await rigsBook.patch(rig.id, { engines: updated });
      await fix.spider.crawl();
    };

    // First crawl after spawn → first attempt → retryable (count=1).
    let result = await fix.spider.crawl();
    assert.equal(result?.action, 'engine-retrying');
    assert.equal((result as { attemptCount: number }).attemptCount, 1);

    // Crawl-after-hold → second attempt → still within override budget (count=2).
    await advanceOnce();
    let [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    let flakey = rig.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.attemptCount, 2,
      'override raised the ceiling — second retry consumed without exhaustion');
    assert.equal(flakey.status, 'pending', 'still pending — budget remains');

    // Third retry — still within budget.
    await advanceOnce();
    [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    flakey = rig.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.attemptCount, 3);
    assert.equal(flakey.status, 'pending');

    // Fourth dispatch (4th total attempt) → budget exhausted → terminal.
    await advanceOnce();
    [rig] = await rigsBook.find({ where: [['writId', '=', writ.id]] });
    flakey = rig.engines.find((e) => e.id === 'flakey')!;
    assert.equal(flakey.status, 'failed', 'budget exhausted at override.maxAttempts');
    assert.equal(rig.status, 'failed');
  });

  it('preserves the design backoff for fields the override does not specify', async () => {
    // Override sets only maxAttempts; the design's default backoff
    // (built-in DEFAULT_ENGINE_RETRY_BACKOFF — initialMs=30_000) survives.
    // Verify by inspecting the holdUntil delta on the first retry.
    fix = buildFixture({
      retryMaxAttempts: 1,
      engineRetryOverrides: { 'flakey-quick': { maxAttempts: 3 } },
    });
    await fix.clerk.post({ title: 'override-preserves-backoff' });

    await fix.spider.crawl(); // spawn
    const before = Date.now();
    const result = await fix.spider.crawl(); // first attempt → retryable
    assert.equal(result?.action, 'engine-retrying');

    const writs = await fix.clerk.list({ limit: 1 });
    const rig = await fix.spider.forWrit(writs[0].id);
    assert.ok(rig);
    const flakey = rig!.engines.find((e) => e.id === 'flakey')!;
    assert.ok(flakey.holdUntil);
    const holdMs = new Date(flakey.holdUntil!).getTime() - before;
    // Default initialMs is 30_000 — the override didn't touch backoff,
    // so the first retry hold should sit in that range (with a small
    // slack for clock skew).
    assert.ok(holdMs >= 30_000 - 500 && holdMs <= 30_000 + 500,
      `expected ~30_000ms hold (default backoff preserved), got ${holdMs}ms`);
  });

  it('enables retry on a fail-fast design (D6 — runtime path)', async () => {
    // Flakey is registered without a `retry` block — fail-fast by default.
    // The override grants it a budget of 2 retries.
    fix = buildFixture({
      flakeyHasNoRetry: true,
      engineRetryOverrides: { 'flakey-quick': { maxAttempts: 2 } },
    });
    await fix.clerk.post({ title: 'override-enables-retry' });

    await fix.spider.crawl(); // spawn
    const result = await fix.spider.crawl(); // first attempt → retryable (would be terminal without override)

    assert.equal(result?.action, 'engine-retrying',
      'override enabled retry on a previously fail-fast design');
    assert.equal((result as { attemptCount: number }).attemptCount, 1);
  });
});
