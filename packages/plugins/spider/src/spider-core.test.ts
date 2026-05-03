/**
 * Spider — core engine pipeline tests.
 *
 * End-to-end Spider behaviour: walk/dispatch ordering, engine readiness,
 * implement / quick / draft / review / revise engine execution, failure
 * propagation, the givens-and-context assembly path, the full pipeline
 * happy path, query helpers (`show` / `list` / `forWrit` / `createdAt`),
 * downstream engine cancellation, and the `walk()` returns null path.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, generateId } from '@shardworks/nexus-core';

import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { SessionDoc } from '@shardworks/animator-apparatus';

import type { RigDoc, EngineInstance, EngineAttempt, ReviewYields, MechanicalCheck } from './types.ts';

import {
  latestAttempt,
  buildFixture,
  rigsBook,
  postWrit,
  assertTerminalAt,
} from './spider-test-fixture.ts';

// ── In-file helpers ────────────────────────────────────────────────────

const COMPLETED_AT_START = '2024-01-01T00:00:00Z';
const COMPLETED_AT_END = '2024-01-01T00:00:01Z';

const completedAttempt = (yields: Record<string, unknown>): EngineAttempt => ({
  startedAt: COMPLETED_AT_START,
  endedAt: COMPLETED_AT_END,
  status: 'completed',
  yields,
});

const runningAttempt = (sessionId: string): EngineAttempt => ({
  startedAt: COMPLETED_AT_START,
  sessionId,
});

const draftYields = (path = '/p') => ({ draftId: 'd1', codexName: 'c', branch: 'b', path, baseSha: 'sha1' });
const implYields = { sessionId: 's1', sessionStatus: 'completed' };

/** Replace one engine in a rig's engines[] (returns the new array). */
function withEngine(
  engines: EngineInstance[],
  id: string,
  patch: Partial<EngineInstance>,
): EngineInstance[] {
  return engines.map(e => e.id === id ? { ...e, ...patch } as EngineInstance : e);
}

/** Mark `engineId` completed with the supplied yields. */
function completeEngine(
  engines: EngineInstance[],
  engineId: string,
  yields: Record<string, unknown>,
): EngineInstance[] {
  return withEngine(engines, engineId, { status: 'completed', attempts: [completedAttempt(yields)] });
}

/**
 * Pre-complete the canonical pipeline up to `upTo` (exclusive). Order:
 * 'draft' → 'implement' → 'review' → 'revise' → 'seal'. Returns the new
 * engines[] array.
 */
function completePipelineUpTo(
  engines: EngineInstance[],
  upTo: 'implement' | 'review' | 'revise' | 'seal' | 'after-revise',
  reviewYields?: ReviewYields,
): EngineInstance[] {
  let next = completeEngine(engines, 'draft', draftYields());
  if (upTo === 'implement') return next;
  next = completeEngine(next, 'implement', implYields);
  if (upTo === 'review') return next;
  if (reviewYields) next = completeEngine(next, 'review', reviewYields as unknown as Record<string, unknown>);
  return next;
}

/** Assert the named engines are cancelled with no endedAt / error. */
function assertCancelled(rig: RigDoc, ids: readonly string[]) {
  for (const id of ids) {
    const eng = rig.engines.find((e: EngineInstance) => e.id === id);
    assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
    assert.equal(eng && latestAttempt(eng)?.endedAt, undefined, `${id} should not have endedAt`);
    assert.equal(eng && latestAttempt(eng)?.error, undefined, `${id} should not have error`);
  }
}

/**
 * Drive the retry budget to exhaustion: clear any retry-backoff hold on
 * `engineId` between crawls so the next dispatch happens immediately.
 * Loops until the rig is no longer running, or `maxIterations` is hit.
 * Returns the final crawl result.
 */
async function exhaustRetryBudget(
  fix: ReturnType<typeof buildFixture>,
  engineId: string,
  maxIterations = 10,
) {
  const book = rigsBook(fix.stacks);
  let result: Awaited<ReturnType<typeof fix.spider.crawl>> | null = null;
  for (let i = 0; i < maxIterations; i++) {
    const [cur] = await book.list();
    if (cur.status !== 'running') break;
    const cleared = cur.engines.map((e: EngineInstance) =>
      e.id === engineId && e.status === 'pending' && e.holdReason === 'retry-backoff'
        ? { ...e, holdUntil: undefined }
        : e,
    );
    await book.patch(cur.id, { engines: cleared });
    result = await fix.spider.crawl();
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Spider', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => { fix = buildFixture(); });
  afterEach(() => { clearGuild(); });

  describe('Fabricator — Spider engine registration', () => {
    it('registers all five engine designs in the Fabricator', () => {
      const { fabricator } = fix;
      assert.ok(fabricator.getEngineDesign('draft'));
      assert.ok(fabricator.getEngineDesign('implement'));
      assert.ok(fabricator.getEngineDesign('review'));
      assert.ok(fabricator.getEngineDesign('revise'));
      assert.ok(fabricator.getEngineDesign('seal'));
    });

    it('returns undefined for an unknown engine ID', () => {
      assert.equal(fix.fabricator.getEngineDesign('nonexistent'), undefined);
    });
  });

  describe('walk() — idle', () => {
    it('returns null when there is no work', async () => {
      assert.equal(await fix.spider.crawl(), null);
    });
  });

  describe('walk() — spawn', () => {
    it('spawns a rig for an open writ', async () => {
      const writ = await postWrit(fix.clerk);
      assert.equal(writ.phase, 'open');

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-spawned');
      assert.equal((result as { writId: string }).writId, writ.id);

      const rigs = await rigsBook(fix.stacks).list();
      assert.equal(rigs.length, 1);
      assert.equal(rigs[0].writId, writ.id);
      assert.equal(rigs[0].status, 'running');
      assert.equal(rigs[0].engines.length, 5);

      const updated = await fix.clerk.show(writ.id);
      assert.equal(updated.phase, 'open');
    });

    it('does not spawn a second rig for a writ that already has one', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();
      const rigs = await rigsBook(fix.stacks).list();
      assert.equal(rigs.length, 1);
    });

    it('spawns rigs for the oldest open writ first (FIFO)', async () => {
      const w1 = await postWrit(fix.clerk, 'First writ');
      await new Promise((r) => setTimeout(r, 2));
      const w2 = await postWrit(fix.clerk, 'Second writ');

      const r1 = await fix.spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');
      assert.equal((r1 as { writId: string }).writId, w1.id);

      const rigs = await rigsBook(fix.stacks).list();
      await rigsBook(fix.stacks).patch(rigs[0].id, { status: 'failed' });

      const r2 = await fix.spider.crawl();
      assert.equal(r2?.action, 'rig-spawned');
      assert.equal((r2 as { writId: string }).writId, w2.id);
    });
  });

  describe('walk() — priority ordering: collect > run > spawn', () => {
    it('runs before spawning when a rig already exists', async () => {
      await postWrit(fix.clerk);
      const r1 = await fix.spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');

      // Second walk runs (not spawn). The draft engine fails (no codexes),
      // resulting in 'rig-completed'.
      const r2 = await fix.spider.crawl();
      assert.notEqual(r2?.action, 'rig-spawned');
      const rigs = await rigsBook(fix.stacks).list();
      assert.equal(rigs.length, 1);
    });

    it('collects before running when a running engine has a terminal session', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      await book.patch(rig.id, {
        engines: withEngine(rig.engines, 'draft', {
          status: 'running',
          attempts: [runningAttempt(fakeSessionId)],
        }),
      });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test' } as SessionDoc);

      const r = await fix.spider.crawl();
      assert.equal(r?.action, 'engine-completed');
      assert.equal((r as { engineId: string }).engineId, 'draft');
    });
  });

  describe('engine readiness — upstream must complete first', () => {
    it('only the first engine (no upstream) is runnable initially', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const [rig] = await rigsBook(fix.stacks).list();
      const draft = rig.engines.find((e: EngineInstance) => e.id === 'draft');
      const implement = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.deepEqual(draft?.upstream, []);
      assert.deepEqual(implement?.upstream, ['draft']);
    });

    it('implement only launches after draft is completed', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'implement') });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');
    });
  });

  describe('implement engine execution', () => {
    it('launches session on first walk, then collects yields on second walk', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig0] = await book.list();
      await book.patch(rig0.id, { engines: completePipelineUpTo(rig0.engines, 'implement') });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');

      const [rig1] = await book.list();
      const impl1 = rig1.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl1?.status, 'running');
      assert.ok(impl1 && latestAttempt(impl1)?.sessionId !== undefined);

      const result2 = await fix.spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'implement');

      const [rig2] = await book.list();
      const impl2 = rig2.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl2?.status, 'completed');
      const impl2Yields = impl2 ? latestAttempt(impl2)?.yields : undefined;
      assert.ok(impl2Yields !== undefined);
      assert.doesNotThrow(() => JSON.stringify(impl2Yields));
    });

    it('marks engine failed and rig failed when engine design is not found', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: withEngine(rig.engines, 'draft', { designId: 'nonexistent-engine' }),
      });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');

      assertCancelled(updated, ['implement', 'review', 'revise', 'seal']);
    });
  });

  describe('yield serialization failure', () => {
    it('non-serializable engine yields cause engine and rig failure', async () => {
      // BigInt causes JSON.stringify to throw, which trips the Spider's
      // `isJsonSerializable` guard and routes the engine through the
      // terminal-failure path.
      const badEngine: EngineDesign = {
        id: 'bad-engine',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async run() { return { status: 'completed', yields: { big: 1n as any } }; },
      };
      const fix2 = buildFixture({}, { status: 'completed' }, { customEngines: { 'bad-engine': badEngine } });

      await postWrit(fix2.clerk);
      await fix2.spider.crawl();

      const book = rigsBook(fix2.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: withEngine(rig.engines, 'draft', { designId: 'bad-engine' }),
      });

      const result = await fix2.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');
      const draftErr = draft ? latestAttempt(draft)?.error : undefined;
      assert.ok(draftErr !== undefined && draftErr.length > 0, `expected engine error, got: ${draftErr}`);

      assertCancelled(updated, ['implement', 'review', 'revise', 'seal']);
    });
  });

  describe('implement engine — Animator integration', () => {
    it('calls animator.summon() with role, prompt, cwd, environment, and metadata', async () => {
      const writ = await postWrit(fix.clerk, 'My commission', 'my-codex');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: completeEngine(rig.engines, 'draft', draftYields('/the/worktree')),
      });

      const launchResult = await fix.spider.crawl();
      assert.equal(launchResult?.action, 'engine-started');

      assert.equal(fix.summonCalls.length, 1);
      const call = fix.summonCalls[0];
      assert.equal(call.role, 'artificer');
      assert.equal(call.cwd, '/the/worktree');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
      assert.deepEqual(call.metadata, { engineId: 'implement', writId: writ.id });
    });

    it('wraps the writ body with a commit instruction', async () => {
      await fix.clerk.post({ title: 'My writ', body: 'Build the feature.' });
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'implement') });

      const launchResult = await fix.spider.crawl();
      assert.equal(launchResult?.action, 'engine-started');

      assert.equal(fix.summonCalls.length, 1);
      const prompt = fix.summonCalls[0].prompt as string;
      assert.ok(prompt.startsWith('Build the feature.\n'));
      assert.ok(prompt.includes('Commit all changes before ending your session.'));
      assert.ok(prompt.includes('<task-manifest>'));
    });

    it('execution epilogue includes task manifest processing rules', async () => {
      await fix.clerk.post({ title: 'My writ', body: 'Spec body here.' });
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'implement') });

      await fix.spider.crawl();
      const prompt = fix.summonCalls[0].prompt as string;

      assert.ok(prompt.includes('Work through tasks in the order listed'));
      assert.ok(prompt.includes('<verify>'));
      assert.ok(prompt.includes('<done>'));
      assert.ok(prompt.includes('<files>'));
      assert.ok(prompt.includes('Commit after each task'));
      assert.ok(prompt.includes('verify scope independently'));
    });

    it('session failure propagates: engine fails → rig failed → writ transitions to failed', async () => {
      fix.setSessionOutcome({ status: 'failed', error: 'Process exited with code 1' });
      const writ = await postWrit(fix.clerk, 'Failing writ');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'implement') });

      // Implement engine has maxAttempts:2 (3 total); each failed attempt
      // schedules a retry back-off. Drive the budget to exhaustion.
      await exhaustRetryBudget(fix, 'implement');

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed');
      assertTerminalAt(updatedRig);
      const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed');

      const draftEng = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed');

      assertCancelled(updatedRig, ['review', 'revise', 'seal']);

      const failedWrit = await fix.clerk.show(writ.id);
      assert.equal(failedWrit.phase, 'failed');
    });

    it('ImplementYields contain sessionId and sessionStatus from the session record', async () => {
      await postWrit(fix.clerk, 'Yields test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'implement') });

      await fix.spider.crawl(); // launch
      await fix.spider.crawl(); // collect

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'completed');
      const yields = (impl ? latestAttempt(impl)?.yields : undefined) as Record<string, unknown>;
      assert.ok(typeof yields.sessionId === 'string');
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  describe('quick engine — collect', () => {
    it('collects yields from a terminal session in the sessions book', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const engines = withEngine(
        completeEngine(rig.engines, 'draft', { draftId: 'x', codexName: 'c', branch: 'b', path: '/p' }),
        'implement',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test',
        output: 'Session completed successfully',
      } as SessionDoc);

      const result = await fix.spider.crawl();
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
      // Ensure retried launches also fail so the retry budget exhausts.
      fix.setSessionOutcome({ status: 'failed', error: 'Process exited with code 1' });
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = withEngine(
        completeEngine(rig.engines, 'draft', { draftId: 'x' }),
        'implement',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'failed', startedAt: new Date().toISOString(), provider: 'test',
        error: 'Process exited with code 1',
      } as SessionDoc);

      const result = await exhaustRetryBudget(fix, 'implement');
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      assertTerminalAt(updated);
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed');

      assertCancelled(updated, ['review', 'revise', 'seal']);
    });

    it('does not collect a still-running session', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = withEngine(
        completeEngine(rig.engines, 'draft', { draftId: 'x' }),
        'implement',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'running', startedAt: new Date().toISOString(), provider: 'test' } as SessionDoc);

      const result = await fix.spider.crawl();
      assert.equal(result, null);
    });

    it('does not collect a still-pending session (regression: pre-write SessionDoc)', async () => {
      // Regression: launchDetached pre-wrote a 'pending' SessionDoc before
      // spawning the babysitter, and tryCollect treated 'pending' as
      // terminal. Engines marked themselves complete with sessionStatus:
      // 'pending' as their yields and rigs finished with no actual work.
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = withEngine(
        completeEngine(rig.engines, 'draft', { draftId: 'x' }),
        'implement',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'pending', startedAt: new Date().toISOString(), provider: 'test' } as SessionDoc);

      const result = await fix.spider.crawl();
      assert.equal(result, null);

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'running');
      const implTail = impl ? latestAttempt(impl) : undefined;
      assert.equal(implTail?.yields, undefined);
      assert.equal(implTail?.endedAt, undefined);
    });
  });

  describe('failure propagation', () => {
    it('engine failure → rig failed → writ transitions to failed via CDC', async () => {
      const writ = await postWrit(fix.clerk);
      await fix.spider.crawl();
      const activeWrit = await fix.clerk.show(writ.id);
      assert.equal(activeWrit.phase, 'open');

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: withEngine(rig.engines, 'draft', { designId: 'broken' }) });

      await fix.spider.crawl();

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed');
      assertTerminalAt(updatedRig);

      const failedDraft = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(failedDraft?.status, 'failed');

      assertCancelled(updatedRig, ['implement', 'review', 'revise', 'seal']);

      const failedWrit = await fix.clerk.show(writ.id);
      assert.equal(failedWrit.phase, 'failed');
    });
  });

  describe('givens and context assembly', () => {
    it('each engine receives only the givens it needs', async () => {
      const writ = await postWrit(fix.clerk, 'My writ');
      await fix.spider.crawl();

      const [rig] = await rigsBook(fix.stacks).list();
      const eng = (id: string) => rig.engines.find((e: EngineInstance) => e.id === id)!;

      assert.ok('writ' in eng('draft').givensSpec);
      assert.ok(!('role' in eng('draft').givensSpec));
      assert.equal((eng('draft').givensSpec.writ as WritDoc).id, writ.id);

      assert.ok('writ' in eng('implement').givensSpec);
      assert.ok('role' in eng('implement').givensSpec);
      assert.equal((eng('implement').givensSpec.writ as WritDoc).id, writ.id);

      assert.ok('writ' in eng('review').givensSpec);
      assert.equal(eng('review').givensSpec.role, 'reviewer');

      assert.ok('writ' in eng('revise').givensSpec);
      assert.ok('role' in eng('revise').givensSpec);

      assert.deepEqual(eng('seal').givensSpec, {});
    });

    it('role defaults to "artificer" when not configured', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const [rig] = await rigsBook(fix.stacks).list();
      const implementEngine = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implementEngine?.givensSpec.role, 'artificer');
    });

    it('upstream map is built from completed engine yields', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();

      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'review') });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      const result2 = await fix.spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'review');
    });
  });

  describe('draft engine — baseSha', () => {
    it('includes baseSha in DraftYields when draft is completed', async () => {
      // The draft engine calls execSync('git rev-parse HEAD'); we can't
      // run that in test (no real Scriptorium). Verify baseSha flows
      // through when pre-completed with yields.
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const yields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'abc123def' };
      await book.patch(rig.id, { engines: completeEngine(rig.engines, 'draft', yields) });

      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'completed');
      const stored = (draft ? latestAttempt(draft)?.yields : undefined) as Record<string, unknown>;
      assert.equal(stored.baseSha, 'abc123def');
    });
  });

  describe('full pipeline', () => {
    it('walks through implement → review → revise → rig completion → writ completed', async () => {
      const writ = await postWrit(fix.clerk, 'Full pipeline test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig0] = await book.list();
      await book.patch(rig0.id, { engines: completePipelineUpTo(rig0.engines, 'implement') });

      const r1 = await fix.spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      const r1c = await fix.spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      const r2 = await fix.spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      const r2c = await fix.spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      const r3 = await fix.spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      const r3c = await fix.spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      // Pre-complete seal (real impl would need codexes).
      const [rig3] = await book.list();
      const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 5 };
      await book.patch(rig3.id, {
        engines: completeEngine(rig3.engines, 'seal', sealYields),
        status: 'completed',
      });

      const finalWrit = await fix.clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
    });

    it('walks all 5 engines to rig completion without manual seal patching', async () => {
      const stubSealEngine: EngineDesign = {
        id: 'seal',
        async run() {
          return {
            status: 'completed',
            yields: { sealedCommit: 'abc', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 },
          };
        },
      };
      const fix2 = buildFixture({}, { status: 'completed' }, { customEngines: { seal: stubSealEngine } });

      const writ = await postWrit(fix2.clerk, 'Full pipeline stub seal');
      await fix2.spider.crawl();

      const book = rigsBook(fix2.stacks);
      const [rig0] = await book.list();
      await book.patch(rig0.id, { engines: completePipelineUpTo(rig0.engines, 'implement') });

      const r1 = await fix2.spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      const r1c = await fix2.spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      const r2 = await fix2.spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      const r2c = await fix2.spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      const r3 = await fix2.spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      const r3c = await fix2.spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      const r4 = await fix2.spider.crawl();
      assert.equal(r4?.action, 'rig-completed');
      assert.equal((r4 as { outcome: string }).outcome, 'completed');

      const finalWrit = await fix2.clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
      assertTerminalAt(finalRig);
    });
  });

  describe('review engine — Animator integration', () => {
    it('calls animator.summon() with reviewer role, draft cwd, and prompt containing spec', async () => {
      const writ = await postWrit(fix.clerk, 'Review integration test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'review') });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      assert.equal(fix.summonCalls.length, 1);
      const call = fix.summonCalls[0];
      assert.equal(call.role, 'reviewer');
      assert.equal(call.cwd, '/p');
      assert.ok(call.prompt.includes('# Code Review'));
      assert.ok(call.prompt.includes(writ.body));
      assert.ok(call.prompt.includes('## Instructions'));
      assert.ok(call.prompt.includes('### Overall: PASS or FAIL'));
      assert.deepEqual(call.metadata?.mechanicalChecks, []);
    });

    it('collects ReviewYields: parses PASS from session.output', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const findings = '### Overall: PASS\n\n### Completeness\nAll requirements met.';
      const engines = withEngine(
        completePipelineUpTo(rig.engines, 'review'),
        'review',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test',
        output: findings, metadata: { mechanicalChecks: [] },
      } as SessionDoc);

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'review');

      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = (reviewEngine ? latestAttempt(reviewEngine)?.yields : undefined) as ReviewYields;
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.passed, true);
      assert.equal(yields.findings, findings);
      assert.deepEqual(yields.mechanicalChecks, []);
    });

    it('collects ReviewYields: passed is false when output contains FAIL', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = withEngine(
        completePipelineUpTo(rig.engines, 'review'),
        'review',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test',
        output: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.', metadata: { mechanicalChecks: [] },
      } as SessionDoc);

      await fix.spider.crawl();
      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = (reviewEngine ? latestAttempt(reviewEngine)?.yields : undefined) as ReviewYields;
      assert.equal(yields.passed, false);
    });

    it('collects ReviewYields: mechanicalChecks retrieved from session.metadata', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const checks: MechanicalCheck[] = [
        { name: 'build', passed: true, output: 'Build succeeded', durationMs: 1200 },
        { name: 'test', passed: false, output: '3 tests failed', durationMs: 4500 },
      ];
      const engines = withEngine(
        completePipelineUpTo(rig.engines, 'review'),
        'review',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test',
        output: '### Overall: FAIL', metadata: { mechanicalChecks: checks },
      } as SessionDoc);

      await fix.spider.crawl();
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

  describe('review engine — mechanical checks', () => {
    let mechFix: ReturnType<typeof buildFixture>;

    beforeEach(() => {
      mechFix = buildFixture({
        spider: { variables: { buildCommand: 'echo "build output"', testCommand: 'exit 1' } },
      });
    });

    afterEach(() => { clearGuild(); });

    it('executes build and test commands; captures pass/fail from exit code', async () => {
      await postWrit(mechFix.clerk);
      await mechFix.spider.crawl();

      const book = rigsBook(mechFix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: completeEngine(
          completeEngine(rig.engines, 'draft', draftYields('/tmp')),
          'implement',
          implYields,
        ),
      });

      const result = await mechFix.spider.crawl();
      assert.equal(result?.action, 'engine-started');

      assert.equal(mechFix.summonCalls.length, 1);
      const checks = mechFix.summonCalls[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.equal(checks.length, 2);

      const buildCheck = checks.find((c) => c.name === 'build');
      assert.ok(buildCheck);
      assert.equal(buildCheck!.passed, true);
      assert.ok(buildCheck!.output.includes('build output'));
      assert.ok(typeof buildCheck!.durationMs === 'number');

      const testCheck = checks.find((c) => c.name === 'test');
      assert.ok(testCheck);
      assert.equal(testCheck!.passed, false);
    });

    it('skips checks gracefully when no buildCommand or testCommand configured', async () => {
      const noCmdFix = buildFixture({ spider: {} });
      await postWrit(noCmdFix.clerk);
      await noCmdFix.spider.crawl();

      const book = rigsBook(noCmdFix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'review') });

      await noCmdFix.spider.crawl();
      assert.deepEqual(noCmdFix.summonCalls[0].metadata?.mechanicalChecks, []);
      clearGuild();
    });

    it('truncates check output to 4KB', async () => {
      const bigFix = buildFixture({ spider: { variables: { buildCommand: 'python3 -c "print(\'x\' * 8192)"' } } });
      await postWrit(bigFix.clerk);
      await bigFix.spider.crawl();

      const book = rigsBook(bigFix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: completeEngine(
          completeEngine(rig.engines, 'draft', draftYields('/tmp')),
          'implement',
          implYields,
        ),
      });

      await bigFix.spider.crawl();
      const checks = bigFix.summonCalls[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.ok(checks[0].output.length <= 4096, `output should be ≤ 4KB, got ${checks[0].output.length}`);
      clearGuild();
    });
  });

  describe('revise engine — Animator integration', () => {
    const passingReview: ReviewYields = {
      sessionId: 'rev-1', passed: true, findings: '### Overall: PASS\nAll good.', mechanicalChecks: [],
    };
    const failingReview: ReviewYields = {
      sessionId: 'rev-1', passed: false, findings: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.', mechanicalChecks: [],
    };

    it('calls animator.summon() with role from givens, draft cwd, and writ env', async () => {
      const writ = await postWrit(fix.clerk, 'Revise integration test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'revise', passingReview) });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      assert.equal(fix.summonCalls.length, 1);
      const call = fix.summonCalls[0];
      assert.equal(call.role, 'artificer');
      assert.equal(call.cwd, '/p');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
    });

    it('revision prompt includes pass branch when review passed', async () => {
      await postWrit(fix.clerk, 'Pass branch test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: completePipelineUpTo(rig.engines, 'revise', { ...passingReview, findings: '### Overall: PASS\nAll requirements met.' }),
      });

      await fix.spider.crawl();
      const prompt = fix.summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: PASS'));
      assert.ok(prompt.includes('The review passed'));
      assert.ok(prompt.includes('### Overall: PASS\nAll requirements met.'));
    });

    it('revision prompt includes fail branch when review failed', async () => {
      await postWrit(fix.clerk, 'Fail branch test');
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: completePipelineUpTo(rig.engines, 'revise', failingReview) });

      await fix.spider.crawl();
      const prompt = fix.summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: FAIL'));
      assert.ok(prompt.includes('The review identified issues that need to be addressed'));
      assert.ok(prompt.includes(failingReview.findings));
    });

    it('ReviseYields: sessionId and sessionStatus collected from session record', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = withEngine(
        completePipelineUpTo(rig.engines, 'revise', passingReview),
        'revise',
        { status: 'running', attempts: [runningAttempt(fakeSessionId)] },
      );
      await book.patch(rig.id, { engines });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test' } as SessionDoc);

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      const [updated] = await book.list();
      const reviseEngine = updated.engines.find((e: EngineInstance) => e.id === 'revise');
      const yields = (reviseEngine ? latestAttempt(reviseEngine)?.yields : undefined) as { sessionId: string; sessionStatus: string };
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  describe('show()', () => {
    it('returns the full RigDoc for a valid rig id', async () => {
      const writ = await postWrit(fix.clerk);
      await fix.spider.crawl();

      const rigs = await fix.spider.list();
      assert.equal(rigs.length, 1);
      const rigId = rigs[0].id;

      const rig = await fix.spider.show(rigId);
      assert.equal(rig.id, rigId);
      assert.equal(rig.writId, writ.id);
      assert.equal(rig.status, 'running');
      assert.equal(rig.engines.length, 5);
      assert.equal(typeof rig.createdAt, 'string');
    });

    it('throws with "not found" message for an unknown rig id', async () => {
      await assert.rejects(
        () => fix.spider.show('rig-nonexistent'),
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
      assert.deepEqual(await fix.spider.list(), []);
    });

    it('returns rigs ordered by createdAt descending', async () => {
      const book = rigsBook(fix.stacks);
      const older = new Date(Date.now() - 100).toISOString();
      const newer = new Date().toISOString();
      await book.put({ id: 'rig-old', writId: 'w-1', status: 'running', engines: [], createdAt: older } as RigDoc);
      await book.put({ id: 'rig-new', writId: 'w-2', status: 'running', engines: [], createdAt: newer } as RigDoc);

      const rigs = await fix.spider.list();
      assert.equal(rigs.length, 2);
      assert.ok(rigs[0].createdAt >= rigs[1].createdAt);
    });

    it('filters by status', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const running = await fix.spider.list({ status: 'running' });
      assert.equal(running.length, 1);
      assert.equal(running[0].status, 'running');

      const completed = await fix.spider.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('respects limit', async () => {
      const book = rigsBook(fix.stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-limit-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() } as RigDoc);
      }
      const limited = await fix.spider.list({ limit: 2 });
      assert.equal(limited.length, 2);
    });

    it('respects offset', async () => {
      const book = rigsBook(fix.stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-offset-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() } as RigDoc);
      }
      const all = await fix.spider.list();
      assert.equal(all.length, 3);

      const page = await fix.spider.list({ limit: 2, offset: 2 });
      assert.equal(page.length, 1);
    });
  });

  describe('forWrit()', () => {
    it('returns the rig for a writ that has been spawned', async () => {
      const writ = await postWrit(fix.clerk);
      await fix.spider.crawl();

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig !== null);
      assert.equal(rig.writId, writ.id);
    });

    it('returns null when no rig exists for a writ', async () => {
      const writ = await postWrit(fix.clerk);
      assert.equal(await fix.spider.forWrit(writ.id), null);
    });

    it('returns null for a non-existent writ id', async () => {
      assert.equal(await fix.spider.forWrit('w-nonexistent'), null);
    });
  });

  describe('createdAt', () => {
    it('is set to a valid ISO timestamp when a rig is spawned', async () => {
      const before = new Date().toISOString();
      await postWrit(fix.clerk);
      await fix.spider.crawl();
      const after = new Date().toISOString();

      const rigs = await fix.spider.list();
      assert.equal(rigs.length, 1);
      const { createdAt } = rigs[0];
      assert.equal(typeof createdAt, 'string');
      assert.ok(!isNaN(new Date(createdAt).getTime()));
      assert.ok(createdAt >= before);
      assert.ok(createdAt <= after);
    });
  });

  describe('downstream engine cancellation', () => {
    it('(a) first-engine failure cancels all downstream engines', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: withEngine(rig.engines, 'draft', { designId: 'nonexistent-engine' }) });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');

      assertCancelled(updated, ['implement', 'review', 'revise', 'seal']);
    });

    it('(b) mid-pipeline failure preserves completed upstream, cancels pending downstream', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: withEngine(
          completeEngine(rig.engines, 'draft', draftYields()),
          'implement',
          { designId: 'nonexistent-engine' },
        ),
      });

      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      const draftEng = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed');

      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'failed');

      assertCancelled(updated, ['review', 'revise', 'seal']);
    });

    it('(c) a running engine is not cancelled when another engine fails', async () => {
      // Manually places two engines runnable in one rig — raise the
      // per-rig limit to allow it.
      const fix2 = buildFixture({ spider: { maxConcurrentEnginesPerRig: 5 } });
      await postWrit(fix2.clerk);
      await fix2.spider.crawl();

      const book = rigsBook(fix2.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const engines = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') return { ...e, status: 'completed' as const, attempts: [completedAttempt(draftYields())] };
        if (e.id === 'implement') return { ...e, status: 'running' as const, attempts: [runningAttempt(fakeSessionId)] };
        if (e.id === 'review') return { ...e, designId: 'nonexistent-engine', upstream: [] };
        return e;
      });
      await book.patch(rig.id, { engines });

      const result = await fix2.spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();

      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'running', 'running implement engine should not be cancelled');

      const reviewEng = updated.engines.find((e: EngineInstance) => e.id === 'review');
      assert.equal(reviewEng?.status, 'failed');

      for (const id of ['revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
      }
    });

    it('cancelled engines have no completedAt', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: withEngine(rig.engines, 'draft', { designId: 'nonexistent-engine' }) });

      await fix.spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0);
      for (const eng of cancelled) {
        assert.equal(latestAttempt(eng)?.endedAt, undefined, `${eng.id} should not have endedAt`);
      }
    });

    it('cancelled engines have no error', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, { engines: withEngine(rig.engines, 'draft', { designId: 'nonexistent-engine' }) });

      await fix.spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0);
      for (const eng of cancelled) {
        assert.equal(latestAttempt(eng)?.error, undefined, `${eng.id} should not have error`);
      }
    });
  });

  describe('walk() returns null', () => {
    it('returns null when no rigs exist and no open writs', async () => {
      assert.equal(await fix.spider.crawl(), null);
    });

    it('returns null when the rig has a running engine with no terminal session', async () => {
      await postWrit(fix.clerk);
      await fix.spider.crawl();

      const book = rigsBook(fix.stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      await book.patch(rig.id, {
        engines: withEngine(rig.engines, 'draft', { status: 'running', attempts: [runningAttempt(fakeSessionId)] }),
      });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'running', startedAt: new Date().toISOString(), provider: 'test' } as SessionDoc);

      assert.equal(await fix.spider.crawl(), null);
    });
  });
});
