/**
 * Spider — `spider.follows` gate.
 *
 * Covers the `spider.follows` link kind: how it gates rig spawning when
 * a writ is linked to an in-flight predecessor, and the drain semantics
 * once the predecessor terminates. The inline `drainCrawls` helper for
 * this suite stays co-located with its sole consumer.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId, shortId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider, countRunningEngines, countRunningEnginesInRig } from './spider.ts';
import type { SpiderApi, RigDoc, RigView, EngineInstance, EngineAttempt, ReviewYields, MechanicalCheck, RigTemplate, BlockType, CheckResult, SpiderEngineRunResult, SpiderCollectResult, InputRequestDoc } from './types.ts';

import animaSessionEngine from './engines/anima-session.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

import {
  latestAttempt,
  STANDARD_TEMPLATE,
  FRAMEWORK_KIT_FIELDS,
  buildKitEntries,
  buildCtx,
  mergeCustomEnginesIntoSpider,
  buildFixture,
  rigsBook,
  mandateLikeWritType,
  postWrit,
  assertTerminalAt,
} from './spider-test-fixture.ts';

// ── spider.follows gate behavior ─────────────────────────────────────────

describe('Spider — spider.follows gate', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // Small helper: run crawl() repeatedly and collect actions until a
  // terminal-ish pause (null or a gated/unstuck outcome). Used to drive
  // the gate machinery without coupling tests to the exact number of
  // ticks a given flow takes.
  async function drainCrawls(spider: SpiderApi, maxTicks = 10): Promise<Array<{ action: string; [k: string]: unknown }>> {
    const actions: Array<{ action: string; [k: string]: unknown }> = [];
    for (let i = 0; i < maxTicks; i++) {
      const result = await spider.crawl();
      if (result === null) break;
      actions.push(result as { action: string });
      // Stop on actions that signal end-of-tick for spawning work.
      if (result.action === 'writ-unstuck' || result.action === 'rig-spawned') break;
    }
    return actions;
  }

  describe('link-kind registration', () => {
    it('spider.follows appears in listKinds() with the prescribed description', async () => {
      const kinds = await fix.clerk.listKinds();
      const entry = kinds.find((k) => k.id === 'spider.follows');
      assert.ok(entry, 'spider.follows should be registered');
      assert.equal(entry!.ownerPlugin, 'spider');
      assert.equal(
        entry!.description,
        'The source writ is a precedence-successor of the target: source cannot be dispatched until the target reaches a terminal state. Consumers define their own policy for what happens on each terminal state.',
      );
    });

    it('clerk.link() accepts kind="spider.follows" and rejects the colon form', async () => {
      const { clerk } = fix;
      const a = await postWrit(clerk, 'A');
      const b = await postWrit(clerk, 'B');
      const linkDoc = await clerk.link(a.id, b.id, 'depends on', 'spider.follows');
      assert.equal(linkDoc.kind, 'spider.follows');
      await assert.rejects(
        () => clerk.link(a.id, b.id, 'fixes', 'spider:follows'),
        /Unknown link kind/,
      );
    });
  });

  describe('single-blocker hold and release', () => {
    it('does not dispatch while a non-terminal blocker exists', async () => {
      const { clerk, spider, stacks } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');

      // Dependent is younger than blocker, so blocker dispatches first.
      // Prevent blocker from spawning by completing it out-of-band via
      // transition (no rig needed). Do this *after* we verify the gate.
      //
      // First crawl: blocker is oldest, no gate → spawns rig for blocker.
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');
      assert.equal((r1 as { writId: string }).writId, blocker.id);

      // Force-fail the blocker's rig into stuck via out-of-band phase change
      // — we're isolating the gate. Since blocker is still `open`, the
      // dependent remains gated.
      //
      // Drive another crawl: dependent should emit `gated`, not `rig-spawned`.
      // The blocker's rig is running its draft engine; skip that via
      // completing the rig's engines to keep focus on gating. Simpler: just
      // cancel the blocker's rig so no engine work happens.
      const rig = await fix.spider.forWrit(blocker.id);
      if (rig) await fix.spider.cancel(rig.id);

      // Blocker writ should now be cancelled — released per D17.
      const blockerAfter = await clerk.show(blocker.id);
      assert.ok(
        blockerAfter.phase === 'cancelled' || blockerAfter.phase === 'open',
        `blocker phase is ${blockerAfter.phase}`,
      );

      // Re-block the blocker by posting a fresh pair — that's the cleaner
      // setup. (The above was just to confirm nothing crashed mid-flow.)
      //
      // Exercise actual gating against an explicitly-open blocker:
      const blocker2 = await postWrit(clerk, 'Blocker 2');
      const dependent2 = await postWrit(clerk, 'Dependent 2');
      await clerk.link(dependent2.id, blocker2.id, 'depends on', 'spider.follows');

      // Evaluate the gate on dependent2 without letting blocker2's own
      // rig progress to terminal (which would change dependent2's gate
      // classification). Two ticks is enough: tick 1 dispatches blocker2;
      // tick 2 evaluates dependent2 (gate hits non-terminal blocker2 →
      // continue). The load-bearing assertion is that dependent2 got no
      // rig while its blocker is non-terminal.
      await spider.crawl();
      await spider.crawl();

      const depRig = await rigsBook(stacks).find({ where: [['writId', '=', dependent2.id]] });
      assert.equal(depRig.length, 0, 'dependent should not have spawned a rig while blocker is non-terminal');
    });

    it('gated candidate does not short-circuit the scan — later unblocked candidates still dispatch', async () => {
      // Regression for a trySpawn bug where the loop returned on the
      // first gated candidate instead of continuing. That caused newer
      // dispatchable writs to starve behind any older gated one until
      // external state changed. Candidate-order in the scan is
      // createdAt-asc, so we post the gated pair first and the
      // unblocked writ last.
      const { clerk, spider, stacks } = fix;
      const blocker = await postWrit(clerk, 'Blocker first');
      const gated = await postWrit(clerk, 'Gated second');
      await clerk.link(gated.id, blocker.id, 'depends on', 'spider.follows');
      const independent = await postWrit(clerk, 'Independent third');

      // Drive crawls until independent has spawned or we give up. Before
      // the fix, independent would never spawn because trySpawn returned
      // on the first gated candidate (`gated`) instead of continuing.
      // The earlier crawl cycles are consumed by blocker's rig running
      // through tryRun/tryCollect phases — only when trySpawn is reached
      // and the scan continues past `gated` does independent get a rig.
      let indepSpawned = false;
      for (let i = 0; i < 12; i++) {
        await spider.crawl();
        const rigs = await rigsBook(stacks).find({ where: [['writId', '=', independent.id]] });
        if (rigs.length > 0) { indepSpawned = true; break; }
      }
      assert.ok(indepSpawned, 'independent writ should have spawned a rig even though an older candidate was gated');

      const gatedRig = await rigsBook(stacks).find({ where: [['writId', '=', gated.id]] });
      assert.equal(gatedRig.length, 0, 'gated writ must not have spawned a rig while its blocker is non-terminal');
    });

    it('releases the gate once the blocker reaches completed (dispatches dependent on next poll)', async () => {
      const { clerk, spider } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');

      // Complete blocker out-of-band (transition handles 'open' → 'completed').
      await clerk.transition(blocker.id, 'completed', { resolution: 'Done.' });

      // Drain crawls: there is no rig for blocker (we skipped dispatch),
      // and dependent should spawn cleanly.
      let depSpawned = false;
      for (let i = 0; i < 5; i++) {
        const r = await spider.crawl();
        if (r?.action === 'rig-spawned' && (r as { writId: string }).writId === dependent.id) {
          depSpawned = true;
          break;
        }
      }
      assert.ok(depSpawned, 'dependent should dispatch after blocker completes');
    });

    it('releases the gate when the blocker reaches cancelled', async () => {
      const { clerk, spider } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');

      await clerk.transition(blocker.id, 'cancelled', { resolution: 'Moot.' });

      let depSpawned = false;
      for (let i = 0; i < 5; i++) {
        const r = await spider.crawl();
        if (r?.action === 'rig-spawned' && (r as { writId: string }).writId === dependent.id) {
          depSpawned = true;
          break;
        }
      }
      assert.ok(depSpawned, 'dependent should dispatch after blocker is cancelled');
    });
  });

  describe('conjunctive multi-blocker composition', () => {
    it('holds when any of N blockers is non-terminal; dispatches only when all reach terminal-success', async () => {
      const { clerk, spider, stacks } = fix;
      const b1 = await postWrit(clerk, 'B1');
      const b2 = await postWrit(clerk, 'B2');
      const b3 = await postWrit(clerk, 'B3');
      const dep = await postWrit(clerk, 'Dependent');
      await clerk.link(dep.id, b1.id, 'depends on', 'spider.follows');
      await clerk.link(dep.id, b2.id, 'depends on', 'spider.follows');
      await clerk.link(dep.id, b3.id, 'depends on', 'spider.follows');

      // Complete two of three out-of-band via direct stacks patch. Using the
      // direct book here (rather than clerk.transition()) sidesteps the rig
      // machinery — we do not want b3 to also race through trySpawn and
      // engine failure during this test; the gate's conjunctive rule is the
      // only behavior under test.
      const writsStacksBook = stacks.book<WritDoc>('clerk', 'writs');
      await writsStacksBook.patch(b1.id, { phase: 'completed' });
      await writsStacksBook.patch(b2.id, { phase: 'cancelled' });

      // Drive a single crawl so dep's gate is evaluated. b3 is older than
      // dep in createdAt-asc order but has no outbound follows — it may
      // spawn a rig. The behavioral check we want is "dep did not spawn
      // a rig because its gate classified it gated." Using exactly one
      // crawl keeps b3's rig from progressing to terminal and changing
      // dep's gate classification.
      await spider.crawl();
      await spider.crawl();
      const depRigBefore = await rigsBook(stacks).find({ where: [['writId', '=', dep.id]] });
      assert.equal(depRigBefore.length, 0, 'dependent should not have spawned a rig while b3 is non-terminal');

      // Release the last blocker (patch direct to avoid transition phase rules).
      await writsStacksBook.patch(b3.id, { phase: 'completed' });

      let dispatched = false;
      for (let i = 0; i < 8; i++) {
        const r = await spider.crawl();
        if (r?.action === 'rig-spawned' && (r as { writId: string }).writId === dep.id) {
          dispatched = true;
          break;
        }
        if (!r) break;
      }
      assert.ok(dispatched, 'dependent should dispatch after all blockers release');
    });
  });

  describe('failed-blocker stuck cascade', () => {
    it('singular resolution text and shape for one failed blocker', async () => {
      const { clerk, spider } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');

      await clerk.transition(blocker.id, 'failed', { resolution: 'boom' });

      // Drain crawls; dependent should be cascaded to `stuck` via
      // failed-blocker on its first evaluation. The phase transition is
      // the behavioral signal.
      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      const writAfter = await clerk.show(dependent.id);
      assert.equal(writAfter.phase, 'stuck');
      const expectedShort = shortId(blocker.id);
      assert.equal(writAfter.resolution, `Blocked by failed dependency: ${expectedShort}`);
      const spiderStatus = writAfter.status?.spider as Record<string, unknown> | undefined;
      assert.ok(spiderStatus, 'status.spider should be populated');
      assert.equal(spiderStatus!.stuckCause, 'failed-blocker');
      assert.deepEqual(spiderStatus!.blockerIds, [blocker.id]);
      assert.ok(typeof spiderStatus!.observedAt === 'string', 'observedAt should be an ISO timestamp string');
      assert.ok(!Number.isNaN(Date.parse(spiderStatus!.observedAt as string)), 'observedAt should parse as a date');
    });

    it('plural resolution text for multiple failed blockers', async () => {
      const { clerk, spider } = fix;
      const b1 = await postWrit(clerk, 'B1');
      const b2 = await postWrit(clerk, 'B2');
      const dep = await postWrit(clerk, 'Dependent');
      await clerk.link(dep.id, b1.id, 'depends on', 'spider.follows');
      await clerk.link(dep.id, b2.id, 'depends on', 'spider.follows');

      await clerk.transition(b1.id, 'failed', { resolution: 'one' });
      await clerk.transition(b2.id, 'failed', { resolution: 'two' });

      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      const writAfter = await clerk.show(dep.id);
      assert.equal(writAfter.phase, 'stuck');
      const short1 = shortId(b1.id);
      const short2 = shortId(b2.id);
      assert.equal(
        writAfter.resolution,
        `Blocked by failed dependencies: ${short1}, ${short2}`,
      );
      const spiderStatus = writAfter.status?.spider as Record<string, unknown> | undefined;
      assert.deepEqual(spiderStatus!.blockerIds, [b1.id, b2.id]);
      assert.equal(spiderStatus!.stuckCause, 'failed-blocker');
    });
  });

  describe('cycle detection', () => {
    it('sticks every cycle member with stuckCause="cycle"', async () => {
      const { clerk, spider } = fix;
      const a = await postWrit(clerk, 'A');
      const b = await postWrit(clerk, 'B');
      const c = await postWrit(clerk, 'C');
      // A → B → C → A (cycle)
      await clerk.link(a.id, b.id, 'depends on', 'spider.follows');
      await clerk.link(b.id, c.id, 'depends on', 'spider.follows');
      await clerk.link(c.id, a.id, 'depends on', 'spider.follows');

      // Drain crawls; the first evaluation of any cycle member should
      // cascade all members to `stuck`. The per-writ stuck-state check
      // below is the behavioral signal.
      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      for (const writId of [a.id, b.id, c.id]) {
        const w = await clerk.show(writId);
        assert.equal(w.phase, 'stuck', `${writId} should be stuck`);
        assert.equal(w.resolution, 'Cycle detected in spider.follows graph');
        const status = w.status?.spider as Record<string, unknown> | undefined;
        assert.ok(status, `status.spider should be set on ${writId}`);
        assert.equal(status!.stuckCause, 'cycle');
        const members = status!.blockerIds as string[];
        assert.ok(members.includes(a.id) && members.includes(b.id) && members.includes(c.id), 'every cycle member should be recorded');
      }
    });

    it('diamond (no back-edge) does not trigger cycle detection', async () => {
      const { clerk, spider } = fix;
      const target = await postWrit(clerk, 'Target');
      const left = await postWrit(clerk, 'Left');
      const right = await postWrit(clerk, 'Right');
      const top = await postWrit(clerk, 'Top');
      // top → left → target;  top → right → target  (diamond, two paths)
      await clerk.link(top.id, left.id, 'depends on', 'spider.follows');
      await clerk.link(top.id, right.id, 'depends on', 'spider.follows');
      await clerk.link(left.id, target.id, 'depends on', 'spider.follows');
      await clerk.link(right.id, target.id, 'depends on', 'spider.follows');

      // Complete target so the dependents can eventually dispatch.
      await clerk.transition(target.id, 'completed', { resolution: 'ok' });

      // Drain a few crawls — nothing should be stuck with cause='cycle'.
      for (let i = 0; i < 8; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      for (const id of [top.id, left.id, right.id]) {
        const w = await clerk.show(id);
        const status = w.status?.spider as Record<string, unknown> | undefined;
        if (w.phase === 'stuck') {
          assert.notEqual(status?.stuckCause, 'cycle', `${id} must not be stuck with cause=cycle`);
        }
      }
    });
  });

  describe('auto-unstick on recovery', () => {
    it('clears the cause and returns stuck writ to open when failed blockers resolve', async () => {
      const { clerk, spider } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');

      await clerk.transition(blocker.id, 'failed', { resolution: 'boom' });

      // Drive crawls until dependent is cascaded to `stuck`.
      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }
      const stuck = await clerk.show(dependent.id);
      assert.equal(stuck.phase, 'stuck');

      // Remediate the blocker: post a retry writ and link it, then complete
      // the retry. But the simpler/more literal test is: flip the blocker
      // out-of-band into a terminal-success state. `failed → stuck → cancelled`
      // is a legal path for the failed writ's blocker; we use a direct
      // transition-to-open-then-cancelled workaround via the Stacks directly.
      //
      // The acceptance test actually says "failed blockers reach success" —
      // we'll model that by force-overwriting the blocker's phase.
      const writsStacksBook = fix.stacks.book<WritDoc>('clerk', 'writs');
      await writsStacksBook.patch(blocker.id, { phase: 'completed', resolution: 'fixed out-of-band' });

      // Next crawl: autoUnstick should fire.
      let unstuckFired = false;
      for (let i = 0; i < 4; i++) {
        const r = await spider.crawl();
        if (r?.action === 'writ-unstuck' && (r as { writId: string }).writId === dependent.id) {
          unstuckFired = true;
          break;
        }
      }
      assert.ok(unstuckFired, 'autoUnstick should fire once blocker is terminal-success');

      const w = await clerk.show(dependent.id);
      assert.equal(w.phase, 'open');
      const status = w.status?.spider as Record<string, unknown> | undefined;
      assert.ok(!status || !status.stuckCause, 'stuckCause should be cleared');
    });

    it('does not touch writs stuck without a status.spider slot', async () => {
      const { clerk, spider } = fix;
      // Simulate an operator-style stuck: transition a writ directly to
      // `stuck` without going through Spider. autoUnstick must ignore
      // writs whose `status.spider` slot is absent (not Spider's to manage).
      const writ = await postWrit(clerk, 'OrdinaryWrit');
      await clerk.transition(writ.id, 'stuck', { resolution: 'operator flagged' });

      const stuckWrit = await clerk.show(writ.id);
      assert.equal(stuckWrit.phase, 'stuck', 'writ should be stuck');
      assert.equal(stuckWrit.status?.spider, undefined, 'operator stuck must not publish status.spider');

      // Run a bunch of crawls — autoUnstick must NEVER flip this writ.
      for (let i = 0; i < 5; i++) {
        const r = await spider.crawl();
        if (!r) break;
        if (r.action === 'writ-unstuck') {
          assert.notEqual((r as { writId: string }).writId, stuckWrit.id, 'slot-less stuck must not be auto-unstuck');
        }
      }

      const finalWrit = await clerk.show(stuckWrit.id);
      assert.equal(finalWrit.phase, 'stuck', 'slot-less stuck writ should remain stuck');
      assert.equal(finalWrit.status?.spider, undefined, 'status.spider should still be absent');
    });
  });

  describe('transitive cascade across polls', () => {
    it('only the direct dependent stucks on the failed-blocker tick; a two-hop writ cascades on a later poll after the intermediate fails', async () => {
      const { clerk, spider, stacks } = fix;
      // A depends on B, B depends on C. C fails.
      const c = await postWrit(clerk, 'C');
      const b = await postWrit(clerk, 'B');
      const a = await postWrit(clerk, 'A');
      await clerk.link(b.id, c.id, 'depends on', 'spider.follows');
      await clerk.link(a.id, b.id, 'depends on', 'spider.follows');

      // Move C to failed directly via Stacks (bypass the phase state machine:
      // we don't need to go through `open → failed`, we just want C in
      // failed state for the gate test).
      const writsStacksBook = stacks.book<WritDoc>('clerk', 'writs');
      await writsStacksBook.patch(c.id, { phase: 'failed', resolution: 'boom' });

      // Tick 1: Spider sees B (oldest open candidate). Evaluates gate —
      // C is failed → B becomes stuck with cause='failed-blocker'. A's
      // direct blocker (B) is now non-terminal (stuck), so A is
      // gate-held but NOT transitively cascaded in the same tick (D14).
      // A single crawl is sufficient to check this — the gate sticks
      // on the direct cascade and moves on. We run enough ticks to be
      // sure B's state transition settled; the phase check is the
      // load-bearing assertion.
      for (let i = 0; i < 4; i++) {
        const r = await spider.crawl();
        const bw = await clerk.show(b.id);
        if (bw.phase === 'stuck') break;
        if (!r) break;
      }
      const bAfter = await clerk.show(b.id);
      assert.equal(bAfter.phase, 'stuck', 'B should be stuck after the failed-blocker cascade');
      const aAfterB = await clerk.show(a.id);
      assert.equal(aAfterB.phase, 'open', 'A must remain open immediately after B is stucked — no transitive single-poll cascade');

      // Subsequent polls with B in `stuck` (non-terminal) gate A (A is not
      // stuck — B is non-terminal per D17, which holds the gate).
      for (let i = 0; i < 3; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }
      const aGated = await clerk.show(a.id);
      assert.equal(aGated.phase, 'open', 'A stays open while B is stuck (non-terminal blocker holds gate)');

      // Now move B to failed (external action). On the next poll, A
      // cascades into stuck per the same mechanism — this is the
      // "next poll naturally handles transitive dependents through the
      // same mechanism" wording in D14.
      await writsStacksBook.patch(b.id, { phase: 'failed', resolution: 'also boom' });

      for (let i = 0; i < 4; i++) {
        await spider.crawl();
        const aw = await clerk.show(a.id);
        if (aw.phase === 'stuck') break;
      }
      const aAfterFail = await clerk.show(a.id);
      assert.equal(aAfterFail.phase, 'stuck', 'A should be stuck after B reaches failed — on a later poll than B');
      const aFinal = await clerk.show(a.id);
      assert.equal(aFinal.phase, 'stuck');
      const aStatus = aFinal.status?.spider as Record<string, unknown> | undefined;
      assert.equal(aStatus?.stuckCause, 'failed-blocker');
      assert.deepEqual(aStatus?.blockerIds, [b.id]);
    });
  });

  // ── engine-failure stuck-cause payload ─────────────────────────────
  //
  // Every `failEngine` call site classifies its failure as retryable
  // (transient — a fresh attempt may succeed) or non-retryable
  // (definitional — the same code would reproduce the same failure) and
  // writes a freeform `detail` string to the writ's `status.spider`
  // sub-slot. These tests verify the payload shape for representative
  // paths and confirm that the dependency-recovery causes
  // (failed-blocker / cycle) remain untouched.
  describe('engine-failure stuck cause payload', () => {
    // The following engine-failure classification tests were removed —
    // Spider no longer writes status.spider.stuckCause='engine-failure';
    // engine-failure now transitions the writ directly to phase='failed'.
    // See clockworks-retry dormancy tests for the new behavior. The tests
    // removed from this block were:
    //   - 'session crash classifies retryable:true with a detail...'
    //   - 'graft validation failure classifies retryable:false...'
    //   - 'engine run() throw classifies retryable:true'
    //   - 'unknown block type classifies retryable:false'
    //   - 'non-JSON-serializable engine yields classifies retryable:false'
    //   - 'autoUnstick leaves engine-failure stucks alone'
    //
    // Replacement: one test confirming engine-failure now transitions the
    // writ directly to phase='failed' without writing status.spider.stuckCause.

    it('engine-failure transitions writ to phase=failed without writing status.spider.stuckCause', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'thrower', designId: 'throwing-engine', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'throwing-engine': {
              id: 'throwing-engine',
              async run() {
                throw new Error('kaboom');
              },
            },
          },
        },
      );
      const { clerk, spider } = fix;
      const writ = await clerk.post({ title: 'thrower', body: 'body' });

      // Drive crawls until the writ reaches a terminal state.
      for (let i = 0; i < 10; i++) {
        const r = await spider.crawl();
        if (!r) break;
        const w = await clerk.show(writ.id);
        if (w.phase === 'failed' || w.phase === 'stuck') break;
      }

      const final = await clerk.show(writ.id);
      assert.equal(final.phase, 'failed', 'engine-failure should transition writ directly to failed');
      const status = final.status?.spider as Record<string, unknown> | undefined;
      // Spider no longer writes stuckCause='engine-failure' on the engine-failure path.
      assert.notEqual(status?.stuckCause, 'engine-failure', 'Spider must not write stuckCause=engine-failure');
    });

    it('failed-blocker stuck carries no retryable or detail fields', async () => {
      const { clerk, spider } = fix;
      const blocker = await postWrit(clerk, 'Blocker');
      const dependent = await postWrit(clerk, 'Dependent');
      await clerk.link(dependent.id, blocker.id, 'depends on', 'spider.follows');
      await clerk.transition(blocker.id, 'failed', { resolution: 'boom' });

      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      const w = await clerk.show(dependent.id);
      const status = w.status?.spider as Record<string, unknown> | undefined;
      assert.ok(status, 'status.spider should be set for failed-blocker stucks');
      assert.equal(status!.stuckCause, 'failed-blocker');
      assert.equal(status!.retryable, undefined, 'failed-blocker stucks must not carry retryable');
      assert.equal(status!.detail, undefined, 'failed-blocker stucks must not carry detail');
    });

    it('cycle stuck carries no retryable or detail fields', async () => {
      const { clerk, spider } = fix;
      const a = await postWrit(clerk, 'A');
      const b = await postWrit(clerk, 'B');
      await clerk.link(a.id, b.id, 'depends on', 'spider.follows');
      await clerk.link(b.id, a.id, 'depends on', 'spider.follows');

      for (let i = 0; i < 6; i++) {
        const r = await spider.crawl();
        if (!r) break;
      }

      const w = await clerk.show(a.id);
      const status = w.status?.spider as Record<string, unknown> | undefined;
      assert.ok(status, 'status.spider should be set for cycle stucks');
      assert.equal(status!.stuckCause, 'cycle');
      assert.equal(status!.retryable, undefined, 'cycle stucks must not carry retryable');
      assert.equal(status!.detail, undefined, 'cycle stucks must not carry detail');
    });

    // 'autoUnstick leaves engine-failure stucks alone' was removed — Spider
    // no longer writes status.spider.stuckCause='engine-failure'; engine-failure
    // now transitions the writ directly to phase='failed'. See
    // clockworks-retry dormancy tests for the new behavior.
  });
});
