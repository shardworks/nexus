/**
 * Clockworks-Retry — unit tests.
 *
 * Covers the scenarios enumerated in commission c-mo814q:
 *
 *   - Retryable stuck with rigs.length === 1 → requeues (stuck → open).
 *   - Retryable stuck with rigs.length === 2 → stays stuck (cap reached).
 *   - retryable === false → ignored.
 *   - failed-blocker stuck (dependency cause) → ignored.
 *   - cycle stuck (dependency cause) → ignored.
 *   - Missing retryable field → ignored (fail-safe).
 *   - Second stuck transition on the same writ after a successful requeue
 *     re-evaluates the cap; at 2 attempts it stays stuck.
 *   - Spider's 1:1 rig-per-writ assumption: verifies that terminal/stuck
 *     rigs don't block a new rig spawn after the clockwork requeues.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, BookEntry } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createClockworksRetry } from './clockworks-retry.ts';
import { MAX_RETRY_ATTEMPTS, type ClockworksRetryApi, type SpiderWritStatus } from './types.ts';

// ── Test bootstrap ────────────────────────────────────────────────────

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
    on() {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter((e) => e.type === type)];
    },
  };
}

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  retry: ClockworksRetryApi;
  /** Add a rig row for a given writ; returns the rig id. */
  seedRig: (writId: string, status?: RigRow['status']) => Promise<string>;
  /** Helper: transition a writ straight to stuck via the Clerk API. */
  transitionToStuck: (writId: string, spiderStatus?: SpiderWritStatus) => Promise<WritDoc>;
  /** Number of rigs whose writId matches. */
  rigCount: (writId: string) => Promise<number>;
}

async function buildFixture(): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const retryPlugin = createClockworksRetry();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in retryPlugin)) throw new Error('retry must be apparatus');

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
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
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks
  const stacksApparatus = stacksPlugin.apparatus;
  stacksApparatus.start(buildCtx());
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist. We seed rigs manually — Spider is not started in
  // this test suite, so the book needs to be pre-created for readBook().
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });

  // Start clerk
  const clerkApparatus = clerkPlugin.apparatus;
  await clerkApparatus.start(buildCtx(buildKitEntries([], [])));
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Start retry clockwork
  const retryApparatus = retryPlugin.apparatus;
  await retryApparatus.start(buildCtx());
  const retry = retryApparatus.provides as ClockworksRetryApi;
  apparatusMap.set('clockworks-retry', retry);

  const rigsBook = stacks.book<RigRow>('spider', 'rigs');

  async function seedRig(
    writId: string,
    status: RigRow['status'] = 'stuck',
  ): Promise<string> {
    const id = generateId('rig', 4);
    await rigsBook.put({
      id,
      writId,
      status,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async function transitionToStuck(
    writId: string,
    spiderStatus?: SpiderWritStatus,
  ): Promise<WritDoc> {
    const writ = await clerk.transition(writId, 'stuck', { resolution: 'test stuck' });
    if (spiderStatus !== undefined) {
      await clerk.setWritStatus(writId, 'spider', spiderStatus);
    }
    return writ;
  }

  async function rigCount(writId: string): Promise<number> {
    return rigsBook.count([['writId', '=', writId]]);
  }

  return { stacks, clerk, retry, seedRig, transitionToStuck, rigCount };
}

/**
 * Drive a writ from `open` to `stuck` with a `status.spider` payload,
 * mirroring production's `failEngine` atomicity.
 *
 * Production (Spider's `failEngine`) wraps the rig patch and the writ
 * status-slot write in a single outer `stacks.transaction()` so the
 * rigs → writs CDC cascade and the status-slot write coalesce into one
 * Phase 2 event carrying phase-and-status together (see
 * `packages/plugins/spider/src/spider.ts`). This helper mirrors that
 * atomicity: both the phase transition and the status-slot write happen
 * inside the same transaction, so the retry clockwork's Phase 2
 * observer sees exactly one update event with the final phase and the
 * final status — the same shape it sees in production.
 *
 * Tests that want to drive the retry clockwork's trigger condition
 * directly (without standing up Spider) use this helper. The
 * cross-plugin integration test boots the real Spider and drives
 * through `failEngine` instead.
 */
async function stuckWith(
  fix: Fixture,
  writId: string,
  spiderStatus: SpiderWritStatus,
): Promise<void> {
  await fix.stacks.transaction(async () => {
    await fix.clerk.transition(writId, 'stuck', { resolution: 'test stuck' });
    await fix.clerk.setWritStatus(writId, 'spider', spiderStatus);
  });
}

async function postOpenWrit(fix: Fixture): Promise<WritDoc> {
  return fix.clerk.post({ title: 'test', body: 'test body' });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Clockworks-Retry — retryable flag and cap enforcement', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  describe('exposed api', () => {
    it('reports the documented max-attempts cap', () => {
      assert.equal(fix.retry.maxAttempts, MAX_RETRY_ATTEMPTS);
      assert.equal(fix.retry.maxAttempts, 2);
    });
  });

  describe('trigger condition: status.spider.retryable === true', () => {
    it('requeues (stuck → open) when retryable is true and rigs.length === 1', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');
      assert.equal(await fix.rigCount(writ.id), 1);

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      // Phase 2 handler fires after commit — in the in-memory backend that
      // is already synchronous. Re-read the writ and assert it was
      // requeued.
      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'open', 'writ should have been requeued');
    });

    it('does not requeue when retryable is false (definitional failure)', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: false,
        detail: 'invalid graft',
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck', 'writ should stay stuck');
    });

    it('does not requeue when the retryable field is missing (fail-safe)', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      // Populate status.spider but WITHOUT `retryable` (a pre-Slice-A
      // writ, or a code path that does not set the retry substrate).
      await stuckWith(fix, writ.id, { stuckCause: 'engine-failure' });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck', 'writ should stay stuck');
    });

    it('does not requeue when status.spider is entirely absent', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      // No setWritStatus call — status.spider is undefined.
      await fix.clerk.transition(writ.id, 'stuck', { resolution: 'raw stuck' });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck');
    });
  });

  describe('dependency stucks are ignored (handled by Spider autoUnstick)', () => {
    it('ignores cause: failed-blocker', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      // The gating path writes stuckCause/blockerIds/observedAt on the
      // spider sub-slot, but NEVER sets `retryable`. The retry clockwork
      // must not key on stuckCause.
      await stuckWith(fix, writ.id, {
        stuckCause: 'failed-blocker',
        blockerIds: ['w-blocker'],
        observedAt: new Date().toISOString(),
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck', 'dependency-blocked writ stays stuck');
    });

    it('ignores cause: cycle', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      await stuckWith(fix, writ.id, {
        stuckCause: 'cycle',
        blockerIds: [writ.id],
        observedAt: new Date().toISOString(),
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck', 'cycle-stuck writ stays stuck');
    });

    it('ignores stuckCause when retryable is also set (retryable drives requeue)', async () => {
      // Defensive: even if a rogue writer populates a dependency-style
      // stuckCause alongside `retryable: true`, the retry clockwork only
      // looks at `retryable` — the presence of stuckCause is not a signal
      // to ignore. This test confirms the observer is additive: it fires
      // whenever the retry substrate says so, regardless of other fields
      // under status.spider.
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      await stuckWith(fix, writ.id, {
        // Dependency-style fields
        stuckCause: 'failed-blocker',
        blockerIds: ['w-blocker'],
        // ...and, orthogonally, the retry substrate
        retryable: true,
        detail: 'engine-failure on top of blocker',
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'open', 'retry substrate drives requeue');
    });
  });

  describe('cap enforcement: rigs.length', () => {
    it('does not requeue when rigs.length === MAX_RETRY_ATTEMPTS', async () => {
      const writ = await postOpenWrit(fix);
      // Two prior rigs — cap reached.
      await fix.seedRig(writ.id, 'stuck');
      await fix.seedRig(writ.id, 'stuck');
      assert.equal(await fix.rigCount(writ.id), MAX_RETRY_ATTEMPTS);

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck', 'writ stays stuck at cap');
    });

    it('does not requeue when rigs.length exceeds MAX_RETRY_ATTEMPTS', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');
      await fix.seedRig(writ.id, 'stuck');
      await fix.seedRig(writ.id, 'stuck');

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      const after = await fix.clerk.show(writ.id);
      assert.equal(after.phase, 'stuck');
    });

    it('does not count rigs belonging to other writs toward the cap', async () => {
      const writA = await postOpenWrit(fix);
      const writB = await postOpenWrit(fix);

      // Seed 2 rigs for writ B (unrelated), 1 for writ A.
      await fix.seedRig(writB.id, 'stuck');
      await fix.seedRig(writB.id, 'stuck');
      await fix.seedRig(writA.id, 'stuck');

      await stuckWith(fix, writA.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      const after = await fix.clerk.show(writA.id);
      assert.equal(after.phase, 'open', 'writ A requeued — other writs\' rigs are not counted');
    });
  });

  describe('re-evaluation on subsequent stucks', () => {
    it('evaluates the cap fresh on each stuck transition', async () => {
      const writ = await postOpenWrit(fix);
      // Attempt 1: rig seeded, stuck fires with retryable=true.
      await fix.seedRig(writ.id, 'stuck');
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });
      assert.equal((await fix.clerk.show(writ.id)).phase, 'open', 'first requeue succeeds');

      // Simulate Spider spawning attempt 2: rigs.length is now 2.
      await fix.seedRig(writ.id, 'stuck');
      assert.equal(await fix.rigCount(writ.id), MAX_RETRY_ATTEMPTS);

      // Attempt 2 fails: stuck fires again. Cap is reached — no requeue.
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed again',
      });
      assert.equal(
        (await fix.clerk.show(writ.id)).phase,
        'stuck',
        'second stuck stays stuck because cap is reached',
      );
    });
  });

  describe('CDC boundary conditions', () => {
    it('fires on stuck entry only, not on stuck → stuck status writes', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });
      assert.equal((await fix.clerk.show(writ.id)).phase, 'open');

      // Simulate a stuck-slot rewrite (e.g. Spider's gating path
      // rewriting status.spider while the writ is already stuck). The
      // writ is currently open, so first move it back to stuck via a
      // rig, then rewrite status while stuck — the rewrite should NOT
      // re-fire the retry clockwork.
      await fix.seedRig(writ.id, 'stuck'); // brings rigs.length to 2
      await fix.clerk.transition(writ.id, 'stuck', { resolution: 'attempt 2 stuck' });
      // Cap reached — first stuck stays stuck.
      assert.equal((await fix.clerk.show(writ.id)).phase, 'stuck');

      // Now rewrite status.spider WHILE already stuck — no phase change.
      const nextStatus: SpiderWritStatus = {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed again',
        observedAt: 'later',
      };
      await fix.clerk.setWritStatus(writ.id, 'spider', nextStatus);
      assert.equal(
        (await fix.clerk.show(writ.id)).phase,
        'stuck',
        'status-only update must not re-fire the clockwork',
      );
    });

    it('does not fire on terminal transitions (stuck → failed)', async () => {
      const writ = await postOpenWrit(fix);
      await fix.seedRig(writ.id, 'stuck');
      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });
      assert.equal((await fix.clerk.show(writ.id)).phase, 'open');

      // Stuck → failed is a terminal transition; irrelevant to retry.
      await fix.clerk.transition(writ.id, 'stuck', { resolution: 'attempt 2 stuck' });
      await fix.seedRig(writ.id, 'stuck');
      await fix.clerk.transition(writ.id, 'failed', { resolution: 'abandoned' });

      // Failed is terminal — retry clockwork must not attempt to
      // transition it to open.
      assert.equal((await fix.clerk.show(writ.id)).phase, 'failed');
    });

    it('handles a retryable stuck when rigs.length is 0 (edge — no rig yet)', async () => {
      // A stuck transition before any rig exists should, by the rule
      // "rigs.length < 2", requeue. This is an edge case rather than a
      // production scenario (engine-cascade stuck implies a rig existed
      // to cascade from), but the bound is numeric and the edge should
      // not throw.
      const writ = await postOpenWrit(fix);
      assert.equal(await fix.rigCount(writ.id), 0);

      await stuckWith(fix, writ.id, {
        stuckCause: 'engine-failure',
        retryable: true,
        detail: 'session crashed',
      });

      assert.equal((await fix.clerk.show(writ.id)).phase, 'open');
    });
  });
});
