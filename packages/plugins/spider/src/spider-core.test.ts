/**
 * Spider — core engine pipeline tests.
 *
 * Covers the original `describe('Spider', ...)` wrapper that exercises the
 * end-to-end Spider behaviour: walk/dispatch ordering, engine readiness,
 * implement / quick / draft / review / revise engine execution, failure
 * propagation, the givens-and-context assembly path, the full pipeline
 * happy path, query helpers (`show` / `list` / `forWrit` / `createdAt`),
 * downstream engine cancellation, and the `walk()` returns null path.
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

describe('Spider', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Fabricator integration ─────────────────────────────────────────

  describe('Fabricator — Spider engine registration', () => {
    it('registers all five engine designs in the Fabricator', () => {
      const { fabricator } = fix;
      assert.ok(fabricator.getEngineDesign('draft'), 'draft engine registered');
      assert.ok(fabricator.getEngineDesign('implement'), 'implement engine registered');
      assert.ok(fabricator.getEngineDesign('review'), 'review engine registered');
      assert.ok(fabricator.getEngineDesign('revise'), 'revise engine registered');
      assert.ok(fabricator.getEngineDesign('seal'), 'seal engine registered');
    });

    it('returns undefined for an unknown engine ID', () => {
      assert.equal(fix.fabricator.getEngineDesign('nonexistent'), undefined);
    });
  });

  // ── walk() idle ────────────────────────────────────────────────────

  describe('walk() — idle', () => {
    it('returns null when there is no work', async () => {
      const result = await fix.spider.crawl();
      assert.equal(result, null);
    });
  });

  // ── Spawn ──────────────────────────────────────────────────────────

  describe('walk() — spawn', () => {
    it('spawns a rig for an open writ', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);
      assert.equal(writ.phase, 'open');

      const result = await spider.crawl();
      assert.ok(result !== null, 'expected a walk result');
      assert.equal(result.action, 'rig-spawned');
      assert.equal((result as { writId: string }).writId, writ.id);

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1);
      assert.equal(rigs[0].writId, writ.id);
      assert.equal(rigs[0].status, 'running');
      assert.equal(rigs[0].engines.length, 5);

      // Writ should still be open
      const updatedWrit = await clerk.show(writ.id);
      assert.equal(updatedWrit.phase, 'open');
    });

    it('does not spawn a second rig for a writ that already has one', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);

      await spider.crawl(); // spawns rig

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist');
    });

    it('spawns rigs for the oldest open writ first (FIFO)', async () => {
      const { clerk, spider } = fix;

      // Small delay to ensure different createdAt timestamps
      const w1 = await postWrit(clerk, 'First writ');
      await new Promise((r) => setTimeout(r, 2));
      const w2 = await postWrit(clerk, 'Second writ');

      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');
      assert.equal((r1 as { writId: string }).writId, w1.id);

      // Mark rig1 as failed so w2 can spawn
      const rigs = await rigsBook(fix.stacks).list();
      await rigsBook(fix.stacks).patch(rigs[0].id, { status: 'failed' });

      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'rig-spawned');
      assert.equal((r2 as { writId: string }).writId, w2.id);
    });
  });

  // ── Priority ordering ──────────────────────────────────────────────

  describe('walk() — priority ordering: collect > run > spawn', () => {
    it('runs before spawning when a rig already exists', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);

      // Spawn the rig
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');

      // Second walk should run (not spawn another rig)
      // The draft engine will fail (no codexes), resulting in 'rig-completed'
      const r2 = await spider.crawl();
      assert.notEqual(r2?.action, 'rig-spawned');
      // Only one rig created
      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1);
    });

    it('collects before running when a running engine has a terminal session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Set draft to running with a session
      const enginesWithSession = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] }
          : e,
      );
      await book.patch(rig.id, { engines: enginesWithSession });

      // Insert terminal session
      const sessBook = stacks.book<{ id: string; status: string; startedAt: string; provider: string; [key: string]: unknown }>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test' });

      // Walk should collect (not run implement which has no completed upstream)
      const r = await spider.crawl();
      assert.equal(r?.action, 'engine-completed');
      assert.equal((r as { engineId: string }).engineId, 'draft');
    });
  });

  // ── Engine readiness ───────────────────────────────────────────────

  describe('engine readiness — upstream must complete first', () => {
    it('only the first engine (no upstream) is runnable initially', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();

      // All engines except draft should have upstream
      const draft = rig.engines.find((e: EngineInstance) => e.id === 'draft');
      const implement = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.deepEqual(draft?.upstream, []);
      assert.deepEqual(implement?.upstream, ['draft']);
    });

    it('implement only launches after draft is completed', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Mark draft as completed
      const updatedEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }] }
          : e,
      );
      await book.patch(rig.id, { engines: updatedEngines });

      // Now walk should launch implement (quick engine → 'engine-started', not 'engine-completed')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');
    });
  });

  // ── Quick engine execution (implement) ────────────────────────────

  describe('implement engine execution', () => {
    it('launches session on first walk, then collects yields on second walk', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft so implement can run
      const updatedEngines = rig0.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }] }
          : e,
      );
      await book.patch(rig0.id, { engines: updatedEngines });

      // Walk: implement launches an Animator session (quick engine → 'engine-started')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');

      const [rig1] = await book.list();
      const impl1 = rig1.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl1?.status, 'running', 'engine should be running after launch');
      assert.ok(impl1 && latestAttempt(impl1)?.sessionId !== undefined, 'sessionId should be stored');

      // Walk: collect step finds the terminal session and stores yields
      const result2 = await spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'implement');

      const [rig2] = await book.list();
      const impl2 = rig2.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl2?.status, 'completed');
      const impl2Yields = impl2 ? latestAttempt(impl2)?.yields : undefined;
      assert.ok(impl2Yields !== undefined, 'yields should be stored');
      assert.doesNotThrow(() => JSON.stringify(impl2Yields));
    });

    it('marks engine failed and rig failed when engine design is not found', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Inject a bad designId for draft
      const brokenEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
      );
      await book.patch(rig.id, { engines: brokenEngines });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }
    });
  });

  // ── Yield serialization failure ────────────────────────────────────

  describe('yield serialization failure', () => {
    it('non-serializable engine yields cause engine and rig failure', async () => {
      // Register an engine design that returns non-JSON-serializable yields.
      // BigInt causes JSON.stringify to throw, which trips the Spider's
      // `isJsonSerializable` guard and routes the engine through the
      // terminal-failure path.
      const badEngine: EngineDesign = {
        id: 'bad-engine',
        async run() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { status: 'completed' as const, yields: { big: 1n as any } };
        },
      };
      const { clerk, spider, stacks } = buildFixture({}, { status: 'completed' }, {
        customEngines: { 'bad-engine': badEngine },
      });

      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Patch draft to use the bad engine design
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'bad-engine' } : e,
        ),
      });

      const result = await spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');
      const draftErr = draft ? latestAttempt(draft)?.error : undefined;
      assert.ok(draftErr !== undefined && draftErr.length > 0, `expected engine to have an error, got: ${draftErr}`);

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }
    });
  });

  // ── Implement engine — summon args and prompt wrapping ────────────

  describe('implement engine — Animator integration', () => {
    it('calls animator.summon() with role, prompt, cwd, environment, and metadata', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'My commission', 'my-codex');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/the/worktree' } }] }
            : e,
        ),
      });

      const launchResult = await spider.crawl(); // launch implement
      assert.equal(launchResult?.action, 'engine-started');

      assert.equal(summonCalls.length, 1, 'summon should be called once');
      const call = summonCalls[0];
      assert.equal(call.role, 'artificer', 'role defaults to artificer');
      assert.equal(call.cwd, '/the/worktree', 'cwd is draft worktree path');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
      assert.deepEqual(call.metadata, { engineId: 'implement', writId: writ.id });
    });

    it('wraps the writ body with a commit instruction', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await clerk.post({ title: 'My writ', body: 'Build the feature.' });
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }] }
            : e,
        ),
      });

      const launchResult2 = await spider.crawl(); // launch implement
      assert.equal(launchResult2?.action, 'engine-started');

      assert.equal(summonCalls.length, 1);
      const prompt = summonCalls[0].prompt as string;
      assert.ok(prompt.startsWith('Build the feature.\n'), 'prompt starts with writ body');
      assert.ok(prompt.includes('Commit all changes before ending your session.'), 'prompt includes commit instruction');
      assert.ok(prompt.includes('<task-manifest>'), 'prompt includes task manifest execution instructions');
    });

    it('execution epilogue includes task manifest processing rules', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await clerk.post({ title: 'My writ', body: 'Spec body here.' });
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }] }
            : e,
        ),
      });

      await spider.crawl(); // launch implement
      const prompt = summonCalls[0].prompt as string;

      // Verify key task manifest execution rules are present
      assert.ok(prompt.includes('Work through tasks in the order listed'), 'includes ordering rule');
      assert.ok(prompt.includes('<verify>'), 'includes verify checkpoint rule');
      assert.ok(prompt.includes('<done>'), 'includes done criterion rule');
      assert.ok(prompt.includes('<files>'), 'includes files blast-radius rule');
      assert.ok(prompt.includes('Commit after each task'), 'includes commit-per-task rule');
      assert.ok(prompt.includes('verify scope independently'), 'includes scope independence rule');
    });

    it('session failure propagates: engine fails → rig failed → writ transitions to failed', async () => {
      const { clerk, spider, stacks, setSessionOutcome } = fix;
      setSessionOutcome({ status: 'failed', error: 'Process exited with code 1' });

      const writ = await postWrit(clerk, 'Failing writ');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }] }
            : e,
        ),
      });

      // Implement engine has maxAttempts:2 (up to 3 total attempts). Each
      // failed attempt schedules a retry back-off hold. Loop until the budget
      // is exhausted, clearing holdUntil each cycle to force immediate retry.
      for (let i = 0; i < 10; i++) {
        const [cur] = await book.list();
        if (cur.status !== 'running') break;
        // Clear any retry hold on implement so the next crawl dispatches.
        const clearedEngines = cur.engines.map((e: EngineInstance) =>
          e.id === 'implement' && e.status === 'pending' && e.holdReason === 'retry-backoff'
            ? { ...e, holdUntil: undefined }
            : e,
        );
        await book.patch(cur.id, { engines: clearedEngines });
        await spider.crawl();
      }

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed', 'rig should be failed');
      assertTerminalAt(updatedRig);
      const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed', 'implement engine should be failed');

      // Completed upstream engine (draft) is preserved
      const draftEng = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed', 'draft should remain completed');

      // Pending downstream engines should be cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updatedRig.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }

      const failedWrit = await clerk.show(writ.id);
      assert.equal(failedWrit.phase, 'failed', 'writ should transition to failed via CDC');
    });

    it('ImplementYields contain sessionId and sessionStatus from the session record', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk, 'Yields test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }] }
            : e,
        ),
      });

      await spider.crawl(); // launch
      await spider.crawl(); // collect

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'completed');
      const yields = (impl ? latestAttempt(impl)?.yields : undefined) as Record<string, unknown>;
      assert.ok(typeof yields.sessionId === 'string', 'sessionId should be a string');
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  // ── Quick engine collect ───────────────────────────────────────────

  describe('quick engine — collect', () => {
    it('collects yields from a terminal session in the sessions book', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Simulate: draft completed, implement launched a session
      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'x', codexName: 'c', branch: 'b', path: '/p' } }] };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      // Insert terminal session record
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string;
        output?: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: 'Session completed successfully',
      });

      // Walk: collect step should find the terminal session
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'implement');

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'completed');
      const implYields = impl ? latestAttempt(impl)?.yields : undefined;
      assert.ok(implYields !== undefined);
      const yields = implYields as Record<string, unknown>;
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.sessionStatus, 'completed');
    });

    it('marks engine failed and rig failed when session failed', async () => {
      const { clerk, spider, stacks, setSessionOutcome } = fix;
      // Ensure any retried launches also fail, so the retry budget exhausts.
      setSessionOutcome({ status: 'failed', error: 'Process exited with code 1' });
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'x' } }] };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string;
        error?: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'failed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        error: 'Process exited with code 1',
      });

      // Drive the retry budget to exhaustion: implement has maxAttempts:2
      // so up to 3 attempts will each observe the failed session. Clear
      // the retry-backoff hold between crawls so the next dispatch happens
      // immediately; the dispatcher appends a fresh attempts[] row and the
      // new run launches a new session. The mock animator writes a failed
      // session record for each launch, so each retry ends the same way.
      let result: Awaited<ReturnType<typeof spider.crawl>> | null = null;
      for (let i = 0; i < 10; i++) {
        const [cur] = await book.list();
        if (cur.status !== 'running') break;
        const clearedEngines = cur.engines.map((e: EngineInstance) =>
          e.id === 'implement' && e.status === 'pending' && e.holdReason === 'retry-backoff'
            ? { ...e, holdUntil: undefined }
            : e,
        );
        await book.patch(cur.id, { engines: clearedEngines });
        result = await spider.crawl();
      }
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed');

      // Pending downstream engines should be cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }
    });

    it('does not collect a still-running session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'x' } }] };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      // Session is still running
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      // Nothing to collect, implement is running (no pending with completed upstream),
      // spawn skips (rig exists) → null
      const result = await spider.crawl();
      assert.equal(result, null);
    });

    it('does not collect a still-pending session (regression: pre-write SessionDoc)', async () => {
      // Regression for the bug where launchDetached pre-wrote a 'pending'
      // SessionDoc before spawning the babysitter, and tryCollect treated
      // 'pending' as a terminal status. The result was that engines marked
      // themselves complete with sessionStatus: 'pending' as their yields,
      // and rigs finished with no actual work performed.
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'x' } }] };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      // Session is freshly pre-written but the babysitter hasn't yet
      // transitioned it to 'running' or anything else.
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'pending',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      // tryCollect must skip pending → no action this crawl.
      const result = await spider.crawl();
      assert.equal(result, null);

      // Engine must still be running, not completed with bogus yields.
      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'running');
      const implTail = impl ? latestAttempt(impl) : undefined;
      assert.equal(implTail?.yields, undefined);
      assert.equal(implTail?.endedAt, undefined);
    });
  });

  // ── Failure propagation ────────────────────────────────────────────

  describe('failure propagation', () => {
    it('engine failure → rig failed → writ transitions to failed via CDC', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);

      await spider.crawl(); // spawn
      const activeWrit = await clerk.show(writ.id);
      assert.equal(activeWrit.phase, 'open');

      // Inject bad design to trigger failure
      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const brokenEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft' ? { ...e, designId: 'broken' } : e,
      );
      await book.patch(rig.id, { engines: brokenEngines });

      // Walk: engine fails → rig failed → CDC → writ failed
      await spider.crawl();

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed');
      assertTerminalAt(updatedRig);

      const failedDraft = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(failedDraft?.status, 'failed', 'draft engine should be failed');

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updatedRig.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }

      const failedWrit = await clerk.show(writ.id);
      assert.equal(failedWrit.phase, 'failed');
    });
  });

  // ── Givens/context assembly ────────────────────────────────────────

  describe('givens and context assembly', () => {
    it('each engine receives only the givens it needs', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk, 'My writ');
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const eng = (id: string) => rig.engines.find((e: EngineInstance) => e.id === id)!;

      // draft: { writ } — no role
      assert.ok('writ' in eng('draft').givensSpec, 'draft should have writ');
      assert.ok(!('role' in eng('draft').givensSpec), 'draft should not have role');
      assert.equal((eng('draft').givensSpec.writ as WritDoc).id, writ.id);

      // implement: { writ, role }
      assert.ok('writ' in eng('implement').givensSpec, 'implement should have writ');
      assert.ok('role' in eng('implement').givensSpec, 'implement should have role');
      assert.equal((eng('implement').givensSpec.writ as WritDoc).id, writ.id);

      // review: { writ, role: 'reviewer' }
      assert.ok('writ' in eng('review').givensSpec, 'review should have writ');
      assert.equal(eng('review').givensSpec.role, 'reviewer', 'review role should be hardcoded reviewer');

      // revise: { writ, role }
      assert.ok('writ' in eng('revise').givensSpec, 'revise should have writ');
      assert.ok('role' in eng('revise').givensSpec, 'revise should have role');

      // seal: {}
      assert.deepEqual(eng('seal').givensSpec, {}, 'seal should get empty givensSpec');
    });

    it('role defaults to "artificer" when not configured', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const implementEngine = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implementEngine?.givensSpec.role, 'artificer');
    });

    it('upstream map is built from completed engine yields', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Mark draft + implement as completed
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      const implYields = { sessionId: 'stub', sessionStatus: 'completed' };
      const updatedEngines = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] };
        if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: implYields }] };
        return e;
      });
      await book.patch(rig.id, { engines: updatedEngines });

      // Walk: review launches a session (quick engine → 'engine-started')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      // Walk: collect step picks up the completed review session
      const result2 = await spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'review');
    });
  });

  // ── Draft engine — baseSha population ──────────────────────────────

  describe('draft engine — baseSha', () => {
    it('includes baseSha in DraftYields when draft is completed', async () => {
      // The draft engine calls execSync('git rev-parse HEAD') which we can't
      // run in test (no real Scriptorium). Verify that baseSha flows through
      // the rig correctly when pre-completed with yields.
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'abc123def' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] } : e,
        ),
      });

      // Verify baseSha is present in the stored yields
      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'completed');
      const yields = (draft ? latestAttempt(draft)?.yields : undefined) as Record<string, unknown>;
      assert.equal(yields.baseSha, 'abc123def', 'baseSha should be populated in DraftYields');
    });
  });

  // ── Full pipeline ─────────────────────────────────────────────────

  describe('full pipeline', () => {
    it('walks through implement → review → revise → rig completion → writ completed', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk, 'Full pipeline test');

      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft (real impl would need codexes)
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig0.id, {
        engines: rig0.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] } : e,
        ),
      });

      // Walk: implement launches an Animator session (quick engine)
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      // Walk: collect step picks up the completed implement session
      const r1c = await spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      // Walk: review launches a session (quick engine)
      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      // Walk: collect review session
      const r2c = await spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      // Walk: revise launches a session (quick engine)
      const r3 = await spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      // Walk: collect revise session
      const r3c = await spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      // Pre-complete seal (real impl would need codexes)
      const [rig3] = await book.list();
      const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 5 };
      await book.patch(rig3.id, {
        engines: rig3.engines.map((e: EngineInstance) =>
          e.id === 'seal' ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: sealYields }] } : e,
        ),
        status: 'completed',
      });

      // CDC should have fired — writ should now be completed
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
    });

    it('walks all 5 engines to rig completion without manual seal patching', async () => {
      // Register a stub seal engine that doesn't require Scriptorium
      const stubSealEngine: EngineDesign = {
        id: 'seal',
        async run() {
          return {
            status: 'completed' as const,
            yields: { sealedCommit: 'abc', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 },
          };
        },
      };
      const { clerk, spider, stacks, setSessionOutcome } = buildFixture({}, { status: 'completed' }, {
        customEngines: { seal: stubSealEngine },
      });

      const writ = await postWrit(clerk, 'Full pipeline stub seal');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft (requires Scriptorium — not available in tests)
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig0.id, {
        engines: rig0.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] } : e,
        ),
      });

      // implement launches
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      // collect implement
      const r1c = await spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      // review launches (quick engine)
      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      // collect review
      const r2c = await spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      // revise launches (quick engine)
      const r3 = await spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      // collect revise
      const r3c = await spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      // seal runs (stub) — last engine → rig completes
      const r4 = await spider.crawl();
      assert.equal(r4?.action, 'rig-completed');
      assert.equal((r4 as { outcome: string }).outcome, 'completed');

      // CDC should have fired — writ should now be completed
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed', 'writ should transition to completed via CDC');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
      assertTerminalAt(finalRig);
    });
  });

  // ── Review engine — Animator integration ─────────────────────────

  describe('review engine — Animator integration', () => {
    it('calls animator.summon() with reviewer role, draft cwd, and prompt containing spec', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'Review integration test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch review
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      assert.equal(summonCalls.length, 1, 'summon should be called once for review');
      const call = summonCalls[0];
      assert.equal(call.role, 'reviewer', 'review engine uses reviewer role');
      assert.equal(call.cwd, '/p', 'cwd is the draft worktree path');
      assert.ok(call.prompt.includes('# Code Review'), 'prompt includes review header');
      assert.ok(call.prompt.includes(writ.body), 'prompt includes writ body (spec)');
      assert.ok(call.prompt.includes('## Instructions'), 'prompt includes instructions section');
      assert.ok(call.prompt.includes('### Overall: PASS or FAIL'), 'prompt includes findings format');
      assert.deepEqual(call.metadata?.mechanicalChecks, [], 'no mechanical checks when not configured');
    });

    it('collects ReviewYields: parses PASS from session.output', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const findings = '### Overall: PASS\n\n### Completeness\nAll requirements met.';
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: findings,
        metadata: { mechanicalChecks: [] },
      });

      const result = await spider.crawl(); // collect review
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'review');

      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = (reviewEngine ? latestAttempt(reviewEngine)?.yields : undefined) as ReviewYields;
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.passed, true, 'passed should be true when output contains PASS');
      assert.equal(yields.findings, findings);
      assert.deepEqual(yields.mechanicalChecks, []);
    });

    it('collects ReviewYields: passed is false when output contains FAIL', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.',
        metadata: { mechanicalChecks: [] },
      });

      await spider.crawl(); // collect review
      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = (reviewEngine ? latestAttempt(reviewEngine)?.yields : undefined) as ReviewYields;
      assert.equal(yields.passed, false, 'passed should be false when output contains FAIL');
    });

    it('collects ReviewYields: mechanicalChecks retrieved from session.metadata', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const checks: MechanicalCheck[] = [
        { name: 'build', passed: true, output: 'Build succeeded', durationMs: 1200 },
        { name: 'test', passed: false, output: '3 tests failed', durationMs: 4500 },
      ];
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: '### Overall: FAIL',
        metadata: { mechanicalChecks: checks },
      });

      await spider.crawl(); // collect review
      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = (reviewEngine ? latestAttempt(reviewEngine)?.yields : undefined) as ReviewYields;
      assert.equal(yields.mechanicalChecks.length, 2);
      assert.equal(yields.mechanicalChecks[0].name, 'build');
      assert.equal(yields.mechanicalChecks[0].passed, true);
      assert.equal(yields.mechanicalChecks[1].name, 'test');
      assert.equal(yields.mechanicalChecks[1].passed, false);
    });
  });

  // ── Review engine — mechanical checks ────────────────────────────

  describe('review engine — mechanical checks', () => {
    let mechFix: ReturnType<typeof buildFixture>;

    beforeEach(() => {
      mechFix = buildFixture({
        spider: {
          variables: { buildCommand: 'echo "build output"', testCommand: 'exit 1' },
        },
      });
    });

    afterEach(() => {
      clearGuild();
    });

    it('executes build and test commands; captures pass/fail from exit code', async () => {
      const { clerk, spider, stacks, summonCalls } = mechFix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/tmp', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch review (runs checks first)
      assert.equal(result?.action, 'engine-started');

      assert.equal(summonCalls.length, 1);
      const checks = summonCalls[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.equal(checks.length, 2, 'both build and test checks should run');

      const buildCheck = checks.find((c) => c.name === 'build');
      assert.ok(buildCheck, 'build check should be present');
      assert.equal(buildCheck!.passed, true, 'echo exits 0 → passed');
      assert.ok(buildCheck!.output.includes('build output'), 'output captured from stdout');
      assert.ok(typeof buildCheck!.durationMs === 'number', 'durationMs recorded');

      const testCheck = checks.find((c) => c.name === 'test');
      assert.ok(testCheck, 'test check should be present');
      assert.equal(testCheck!.passed, false, 'exit 1 → failed');
    });

    it('skips checks gracefully when no buildCommand or testCommand configured', async () => {
      const noCmdFix = buildFixture({ spider: {} }); // no buildCommand/testCommand
      const { clerk, spider: w, stacks: s, summonCalls: sc } = noCmdFix;
      await postWrit(clerk);
      await w.crawl(); // spawn

      const book = rigsBook(s);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          return e;
        }),
      });

      await w.crawl(); // launch review
      assert.deepEqual(sc[0].metadata?.mechanicalChecks, [], 'no checks when commands not configured');
      clearGuild();
    });

    it('truncates check output to 4KB', async () => {
      const bigFix = buildFixture({
        spider: { variables: { buildCommand: 'python3 -c "print(\'x\' * 8192)"' } },
      });
      const { clerk, spider: w, stacks: s, summonCalls: sc } = bigFix;
      await postWrit(clerk);
      await w.crawl(); // spawn

      const book = rigsBook(s);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/tmp', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          return e;
        }),
      });

      await w.crawl(); // launch review (runs check with big output)
      const checks = sc[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.ok(checks[0].output.length <= 4096, `output should be truncated to 4KB, got ${checks[0].output.length} chars`);
      clearGuild();
    });
  });

  // ── Revise engine — Animator integration ─────────────────────────

  describe('revise engine — Animator integration', () => {
    it('calls animator.summon() with role from givens, draft cwd, and writ env', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'Revise integration test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = { sessionId: 'rev-1', passed: true, findings: '### Overall: PASS\nAll good.', mechanicalChecks: [] };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: reviewYields }] };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch revise
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      assert.equal(summonCalls.length, 1, 'summon called once for revise');
      const call = summonCalls[0];
      assert.equal(call.role, 'artificer', 'revise uses role from givens (default artificer)');
      assert.equal(call.cwd, '/p', 'cwd is draft worktree path');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
    });

    it('revision prompt includes pass branch when review passed', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await postWrit(clerk, 'Pass branch test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = {
        sessionId: 'rev-1',
        passed: true,
        findings: '### Overall: PASS\nAll requirements met.',
        mechanicalChecks: [],
      };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: reviewYields }] };
          return e;
        }),
      });

      await spider.crawl(); // launch revise
      const prompt = summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: PASS'), 'prompt includes PASS result');
      assert.ok(prompt.includes('The review passed'), 'prompt includes pass branch instruction');
      assert.ok(prompt.includes(reviewYields.findings), 'prompt includes review findings');
    });

    it('revision prompt includes fail branch when review failed', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await postWrit(clerk, 'Fail branch test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = {
        sessionId: 'rev-1',
        passed: false,
        findings: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.',
        mechanicalChecks: [],
      };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: reviewYields }] };
          return e;
        }),
      });

      await spider.crawl(); // launch revise
      const prompt = summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: FAIL'), 'prompt includes FAIL result');
      assert.ok(
        prompt.includes('The review identified issues that need to be addressed'),
        'prompt includes fail branch instruction',
      );
      assert.ok(prompt.includes(reviewYields.findings), 'prompt includes review findings');
    });

    it('ReviseYields: sessionId and sessionStatus collected from session record', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const reviewYields: ReviewYields = { sessionId: 'rev-1', passed: true, findings: '### Overall: PASS', mechanicalChecks: [] };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } }] };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } }] };
          if (e.id === 'review') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: reviewYields }] };
          if (e.id === 'revise') return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      const result = await spider.crawl(); // collect revise
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      const [updated] = await book.list();
      const reviseEngine = updated.engines.find((e: EngineInstance) => e.id === 'revise');
      const yields = (reviseEngine ? latestAttempt(reviseEngine)?.yields : undefined) as { sessionId: string; sessionStatus: string };
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  // ── show / list / forWrit ─────────────────────────────────────────

  describe('show()', () => {
    it('returns the full RigDoc for a valid rig id', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rigs = await spider.list();
      assert.equal(rigs.length, 1);
      const rigId = rigs[0].id;

      const rig = await spider.show(rigId);
      assert.equal(rig.id, rigId);
      assert.equal(rig.writId, writ.id);
      assert.equal(rig.status, 'running');
      assert.equal(rig.engines.length, 5);
      assert.equal(typeof rig.createdAt, 'string');
    });

    it('throws with "not found" message for an unknown rig id', async () => {
      const { spider } = fix;
      await assert.rejects(
        () => spider.show('rig-nonexistent'),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, 'Rig "rig-nonexistent" not found.');
          return true;
        },
      );
    });
  });

  describe('list()', () => {
    it('returns empty array when no rigs exist', async () => {
      const { spider } = fix;
      const rigs = await spider.list();
      assert.deepEqual(rigs, []);
    });

    it('returns rigs ordered by createdAt descending', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      const older = new Date(Date.now() - 100).toISOString();
      const newer = new Date().toISOString();
      await book.put({ id: 'rig-old', writId: 'w-1', status: 'running', engines: [], createdAt: older });
      await book.put({ id: 'rig-new', writId: 'w-2', status: 'running', engines: [], createdAt: newer });

      const rigs = await spider.list();
      assert.equal(rigs.length, 2);
      // Newest first
      assert.ok(rigs[0].createdAt >= rigs[1].createdAt);
    });

    it('filters by status', async () => {
      const { clerk, spider } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn (status: running)

      const running = await spider.list({ status: 'running' });
      assert.equal(running.length, 1);
      assert.equal(running[0].status, 'running');

      const completed = await spider.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('respects limit', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-limit-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() });
      }

      const limited = await spider.list({ limit: 2 });
      assert.equal(limited.length, 2);
    });

    it('respects offset', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-offset-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() });
      }

      const all = await spider.list();
      assert.equal(all.length, 3);

      const page = await spider.list({ limit: 2, offset: 2 });
      assert.equal(page.length, 1);
    });
  });

  describe('forWrit()', () => {
    it('returns the rig for a writ that has been spawned', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rig = await spider.forWrit(writ.id);
      assert.ok(rig !== null);
      assert.equal(rig.writId, writ.id);
    });

    it('returns null when no rig exists for a writ', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      // Do not crawl — no rig spawned yet

      const rig = await spider.forWrit(writ.id);
      assert.equal(rig, null);
    });

    it('returns null for a non-existent writ id', async () => {
      const { spider } = fix;
      const rig = await spider.forWrit('w-nonexistent');
      assert.equal(rig, null);
    });
  });

  describe('createdAt', () => {
    it('is set to a valid ISO timestamp when a rig is spawned', async () => {
      const { clerk, spider } = fix;
      const before = new Date().toISOString();
      await postWrit(clerk);
      await spider.crawl(); // spawn
      const after = new Date().toISOString();

      const rigs = await spider.list();
      assert.equal(rigs.length, 1);
      const { createdAt } = rigs[0];
      assert.equal(typeof createdAt, 'string');
      assert.ok(!isNaN(new Date(createdAt).getTime()), 'createdAt must be a valid date');
      assert.ok(createdAt >= before, 'createdAt must not be before spawn');
      assert.ok(createdAt <= after, 'createdAt must not be after spawn');
    });
  });

  // ── Downstream engine cancellation ───────────────────────────────

  describe('downstream engine cancellation', () => {
    it('(a) first-engine failure cancels all downstream engines', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Inject bad designId for draft (first engine) to trigger failure
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed', 'draft should be failed');

      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }
    });

    it('(b) mid-pipeline failure preserves completed upstream, cancels pending downstream', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Pre-complete draft, then inject bad designId for implement
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] };
          if (e.id === 'implement') return { ...e, designId: 'nonexistent-engine' };
          return e;
        }),
      });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();

      // Completed upstream engine preserved
      const draftEng = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed', 'draft should remain completed');

      // Failed engine
      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'failed', 'implement should be failed');

      // Pending downstream engines cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
        assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
      }
    });

    it('(c) a running engine is not cancelled when another engine fails', async () => {
      // This test manually places two engines in a runnable state within one rig,
      // so raise per-rig limit to allow the second engine to run.
      const { clerk, spider, stacks } = buildFixture({ spider: { maxConcurrentEnginesPerRig: 5 } });
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Draft completed, implement is running with a sessionId,
      // review is pending — inject bad designId for review so it fails next
      // But we need to fail via failEngine path: inject bad designId on review directly
      // and manually set implement to running to test it isn't cancelled.
      const fakeSessionId = generateId('ses', 4);
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T00:00:01Z', status: 'completed' as const, yields: draftYields }] };
          if (e.id === 'implement') return { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] };
          if (e.id === 'review') return { ...e, designId: 'nonexistent-engine', upstream: [] };
          return e;
        }),
      });

      // review now has no upstream and bad designId — running it will fail it
      const result = await spider.crawl();
      // review fails (bad designId) → rig failed
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();

      // The running engine (implement) must NOT be cancelled
      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'running', 'running implement engine should not be cancelled');

      // The failed engine
      const reviewEng = updated.engines.find((e: EngineInstance) => e.id === 'review');
      assert.equal(reviewEng?.status, 'failed', 'review should be failed');

      // Only pending engines should be cancelled (revise and seal)
      for (const id of ['revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
      }
    });

    it('cancelled engines have no completedAt', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      await spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0, 'expected cancelled engines');
      for (const eng of cancelled) {
        assert.equal(latestAttempt(eng)?.endedAt, undefined, `${eng.id} should not have endedAt`);
      }
    });

    it('cancelled engines have no error', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      await spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0, 'expected cancelled engines');
      for (const eng of cancelled) {
        assert.equal(latestAttempt(eng)?.error, undefined, `${eng.id} should not have error`);
      }
    });
  });

  // ── Walk returns null ──────────────────────────────────────────────

  describe('walk() returns null', () => {
    it('returns null when no rigs exist and no open writs', async () => {
      const result = await fix.spider.crawl();
      assert.equal(result, null);
    });

    it('returns null when the rig has a running engine with no terminal session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Put draft in 'running' with a live session
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'running' as const, attempts: [{ startedAt: '2024-01-01T00:00:00Z', sessionId: fakeSessionId }] }
            : e,
        ),
      });

      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      const result = await spider.crawl();
      assert.equal(result, null);
    });
  });
});
