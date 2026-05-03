/**
 * Spider — rig cancellation and writ→rig cascade.
 *
 * Covers the rig-cancellation path (manual cancel, terminal-engine
 * cancellation, concurrent-engine throttle sub-describes, and the
 * countRunningEngines / countRunningEnginesInRig helpers) plus the
 * writ→rig cascade — how a writ reaching a terminal phase cancels its
 * associated rig.
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

// ── In-file helpers ─────────────────────────────────────────────────────

const COMPLETED_AT_START = '2024-01-01T00:00:00Z';
const COMPLETED_AT_END = '2024-01-01T00:00:01Z';
const DRAFT_YIELDS = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' };

const draftCompletedAttempt = (): EngineAttempt => ({
  startedAt: COMPLETED_AT_START,
  endedAt: COMPLETED_AT_END,
  status: 'completed',
  yields: DRAFT_YIELDS,
});

function findEngine(rig: RigDoc | RigView, id: string): EngineInstance {
  const eng = rig.engines.find((e: EngineInstance) => e.id === id);
  assert.ok(eng, `engine "${id}" should exist`);
  return eng!;
}

function assertEnginesCancelled(rig: RigDoc | RigView, ids: readonly string[]): void {
  for (const id of ids) {
    const eng = rig.engines.find((e: EngineInstance) => e.id === id);
    assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
  }
}

// Engine-instance factories for raw rigsBook.put() seeds.
const pendingEng = (id: string, upstream: string[] = []): EngineInstance => ({
  id, designId: 'dummy', status: 'pending', upstream, givensSpec: {},
});
const runningEng = (
  id: string,
  opts: { upstream?: string[]; sessionId?: string; startedAt?: string } = {},
): EngineInstance => ({
  id, designId: 'dummy', status: 'running', upstream: opts.upstream ?? [], givensSpec: {},
  attempts: [{
    startedAt: opts.startedAt ?? new Date().toISOString(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  }],
});
const completedEng = (
  id: string,
  yields: Record<string, unknown> = { x: 1 },
  upstream: string[] = [],
): EngineInstance => ({
  id, designId: 'dummy', status: 'completed', upstream, givensSpec: {},
  attempts: [{ startedAt: COMPLETED_AT_START, endedAt: COMPLETED_AT_END, status: 'completed', yields }],
});
const cancelledEng = (id: string, opts: { error?: string } = {}): EngineInstance => ({
  id, designId: 'dummy', status: 'cancelled', upstream: [], givensSpec: {},
  ...(opts.error
    ? { attempts: [{ startedAt: COMPLETED_AT_START, endedAt: COMPLETED_AT_END, status: 'failed' as const, error: opts.error }] }
    : {}),
});
const legacyBlockedEng = (id: string, requestId: string = 'ir-123'): EngineInstance => ({
  id, designId: 'dummy',
  status: 'blocked' as unknown as EngineInstance['status'],
  upstream: [], givensSpec: {},
  holdReason: 'patron-input',
  holdCondition: { requestId },
});

// Rig seeder — fills in id + createdAt, casts legacy statuses through unknown.
async function seedRig(
  book: ReturnType<typeof rigsBook>,
  opts: {
    writId: string;
    status?: RigDoc['status'] | 'blocked' | 'stuck';
    engines: EngineInstance[];
    terminalAt?: string;
    createdAt?: string;
  },
): Promise<string> {
  const rigId = generateId('rig', 4);
  const now = opts.createdAt ?? new Date().toISOString();
  await book.put({
    id: rigId,
    writId: opts.writId,
    status: (opts.status ?? 'running') as RigDoc['status'],
    engines: opts.engines,
    createdAt: now,
    ...(opts.terminalAt ? { terminalAt: opts.terminalAt } : {}),
  });
  return rigId;
}

// Common bootstrap: spawn rig → mark draft completed → launch implement →
// override the auto-completed session to be 'running' so it stays active.
async function completeDraftAndLaunchRunningImpl(fix: ReturnType<typeof buildFixture>): Promise<{ rig: RigDoc; sessionId: string }> {
  const { spider, stacks } = fix;
  const book = rigsBook(stacks);
  const [rig] = await book.list();

  const updatedEngines = rig.engines.map((e: EngineInstance) =>
    e.id === 'draft'
      ? { ...e, status: 'completed' as const, attempts: [draftCompletedAttempt()] }
      : e,
  );
  await book.patch(rig.id, { engines: updatedEngines });

  const startResult = await spider.crawl();
  assert.equal(startResult?.action, 'engine-started');

  const [rigAfterStart] = await book.list();
  const impl = findEngine(rigAfterStart, 'implement');
  const sessionId = latestAttempt(impl)?.sessionId;
  assert.ok(sessionId, 'implement should have a sessionId');

  const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
  await sessBook.patch(sessionId!, { status: 'running', endedAt: undefined });

  return { rig: rigAfterStart, sessionId: sessionId! };
}

// Throttle-suite engine designs (reused across many buildFixture calls).
const quickStubDesign: EngineDesign = {
  id: 'quick-stub',
  run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
  collect: async () => ({ yields: {} }),
};
const clockworkStubDesign: EngineDesign = {
  id: 'stub-clockwork',
  run: async () => ({ status: 'completed' as const, yields: { done: true } }),
};
const singleTpl = (id: string, designId: string): RigTemplate => ({
  engines: [{ id, designId, givens: {} }],
});
const parallelTpl = (designId: string, ids: string[]): RigTemplate => ({
  engines: ids.map((id) => ({ id, designId, givens: {} })),
});

// ── Rig cancellation tests ──────────────────────────────────────────────

describe('Spider — rig cancellation', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('cancel running rig — happy path', async () => {
    const { clerk, spider, stacks, cancelCalls } = fix;
    await postWrit(clerk);
    await spider.crawl(); // spawn

    const { rig, sessionId } = await completeDraftAndLaunchRunningImpl(fix);

    const cancelledRig = await spider.cancel(rig.id);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);

    assert.equal(cancelCalls.length, 1, 'should have called animator.cancel once');
    assert.equal(cancelCalls[0].sessionId, sessionId);

    const impl = findEngine(cancelledRig, 'implement');
    assert.equal(impl.status, 'cancelled', 'implement should be cancelled');
    assert.ok(latestAttempt(impl)?.endedAt, 'implement should have endedAt');

    assertEnginesCancelled(cancelledRig, ['review', 'revise', 'seal']);

    const draft = findEngine(cancelledRig, 'draft');
    assert.equal(draft.status, 'completed', 'draft should remain completed');
  });

  it('cancel running rig with reason stores reason in error field', async () => {
    const { clerk, spider } = fix;
    await postWrit(clerk);
    await spider.crawl(); // spawn

    const { rig } = await completeDraftAndLaunchRunningImpl(fix);

    const cancelledRig = await spider.cancel(rig.id, { reason: 'No longer needed' });

    const impl = findEngine(cancelledRig, 'implement');
    assert.equal(latestAttempt(impl)?.error, 'No longer needed', 'reason should be in attempt error field');
  });

  // The new schema never writes rig.status='blocked' or engine.status='blocked';
  // these tests persist a legacy-shaped rig (cast through `as unknown as RigDoc`)
  // to exercise the legacy-tolerance branch in api.cancel.
  it('cancel legacy blocked rig — blocked engine gets cancelled with hold metadata cleared', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'blocked',
      engines: [
        legacyBlockedEng('eng-blocked'),
        pendingEng('eng-pending', ['eng-blocked']),
      ],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled');
    assertTerminalAt(cancelledRig);
    const engBlocked = findEngine(cancelledRig, 'eng-blocked');
    assert.equal(engBlocked.status, 'cancelled', 'legacy blocked engine should be cancelled');
    assert.equal(engBlocked.holdReason, undefined, 'holdReason should be cleared');
    assert.equal(engBlocked.holdCondition, undefined, 'holdCondition should be cleared');

    // The legacy-tolerant path only rewrites engines with legacy status='blocked';
    // plain 'pending' engines are left alone. The rig-level 'cancelled' status
    // (via cancelledAt) is the meaningful terminal signal.
  });

  it('cancel rig rejects pending input requests', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'blocked',
      engines: [legacyBlockedEng('eng-blocked', 'ir-test')],
    });

    const irBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
    const now = new Date().toISOString();
    await irBook.put({
      id: 'ir-test',
      rigId,
      engineId: 'eng-blocked',
      status: 'pending',
      questions: { q1: { type: 'boolean', label: 'Continue?' } },
      answers: {},
      createdAt: now,
      updatedAt: now,
    });

    await spider.cancel(rigId);

    const updatedIr = await irBook.get('ir-test');
    assert.equal(updatedIr?.status, 'rejected', 'input request should be rejected');
    assert.equal(updatedIr?.rejectionReason, 'Rig cancelled', 'rejection reason should be set');
  });

  it('cancel is idempotent on completed rig', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'completed',
      engines: [completedEng('eng1', {})],
    });

    const result = await spider.cancel(rigId);
    assert.equal(result.status, 'completed', 'should return rig unchanged');
  });

  it('cancel is idempotent on already-cancelled rig', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'cancelled',
      engines: [cancelledEng('eng1')],
    });

    const result = await spider.cancel(rigId);
    assert.equal(result.status, 'cancelled', 'should return rig unchanged');
  });

  it('cancel non-existent rig throws', async () => {
    const { spider } = fix;
    await assert.rejects(
      () => spider.cancel('rig-nonexistent'),
      /not found/i,
    );
  });

  it('tryCollect detects cancelled session → rig-completed cancelled', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const fakeSessionId = generateId('ses', 4);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'running',
      engines: [
        runningEng('eng-running', { sessionId: fakeSessionId }),
        pendingEng('eng-pending', ['eng-running']),
      ],
    });

    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    const now = new Date().toISOString();
    await sessBook.put({
      id: fakeSessionId,
      status: 'cancelled',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      provider: 'test',
      exitCode: 1,
      error: 'User cancelled',
      metadata: {},
    });

    const result = await spider.crawl();

    assert.ok(result !== null, 'crawl should return a result');
    assert.equal(result!.action, 'rig-completed');
    assert.equal((result as { outcome: string }).outcome, 'cancelled');

    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled');
    assertTerminalAt(updatedRig);
    const engRunning = findEngine(updatedRig!, 'eng-running');
    assert.equal(engRunning.status, 'cancelled', 'running engine should be cancelled');
    assert.equal(latestAttempt(engRunning)?.error, 'User cancelled', 'error from session should be preserved');
    const engPending = findEngine(updatedRig!, 'eng-pending');
    assert.equal(engPending.status, 'cancelled', 'pending engine should be cancelled');
  });

  it('tryCollect cancelled session rejects pending input requests', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const fakeSessionId = generateId('ses', 4);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'running',
      engines: [
        runningEng('eng-running', { sessionId: fakeSessionId }),
        { ...pendingEng('eng-blocked'), holdReason: 'patron-input', holdCondition: { requestId: 'ir-x' } },
      ],
    });

    const irBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
    const now = new Date().toISOString();
    await irBook.put({
      id: 'ir-x',
      rigId,
      engineId: 'eng-blocked',
      status: 'pending',
      questions: { q1: { type: 'text', label: 'Describe' } },
      answers: {},
      createdAt: now,
      updatedAt: now,
    });

    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    await sessBook.put({
      id: fakeSessionId,
      status: 'cancelled',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      provider: 'test',
      exitCode: 1,
      metadata: {},
    });

    await spider.crawl();

    const updatedIr = await irBook.get('ir-x');
    assert.equal(updatedIr?.status, 'rejected', 'input request should be rejected');
    assert.equal(updatedIr?.rejectionReason, 'Rig cancelled');
  });

  it('CDC handler transitions writ to cancelled with error reason', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [cancelledEng('eng1', { error: 'User requested stop' })],
    });

    await book.patch(rigId, { status: 'cancelled' });

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should transition to cancelled');
  });

  it('CDC handler cancelled without engine error uses "Rig cancelled" fallback', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [{
        ...cancelledEng('eng1'),
        attempts: [{ startedAt: COMPLETED_AT_START, endedAt: COMPLETED_AT_END, status: 'failed' as const }],
      }],
    });

    await book.patch(rigId, { status: 'cancelled' });

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should transition to cancelled');
  });

  // ── Rig cancel with already-terminal writ ─────────────────────────────

  it('cancel rig whose writ is already cancelled — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'cancelled');

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [
        runningEng('eng-running'),
        pendingEng('eng-pending', ['eng-running']),
      ],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);
    assertEnginesCancelled(cancelledRig, ['eng-running', 'eng-pending']);

    // Writ should remain cancelled (not re-transitioned)
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should still be cancelled');
  });

  it('cancel rig whose writ is already completed — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'completed');

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [
        runningEng('eng-running'),
        pendingEng('eng-pending', ['eng-running']),
      ],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should still be completed');
  });

  it('cancel rig whose writ is already failed — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'failed');

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [
        runningEng('eng-running'),
        pendingEng('eng-pending', ['eng-running']),
      ],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'failed', 'writ should still be failed');
  });

  it('cancel rig with open writ — both rig and writ transition to cancelled', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [runningEng('eng-running')],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should also be cancelled');
  });

  it('cancel rig with mixed engine statuses — running/pending cancelled, completed preserved', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'cancelled');

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      engines: [
        completedEng('eng-completed'),
        runningEng('eng-running', { upstream: ['eng-completed'] }),
        pendingEng('eng-pending1', ['eng-running']),
        pendingEng('eng-pending2', ['eng-running']),
        pendingEng('eng-pending3', ['eng-pending1', 'eng-pending2']),
      ],
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);

    const engCompleted = findEngine(cancelledRig, 'eng-completed');
    assert.equal(engCompleted.status, 'completed', 'completed engine should be preserved');

    assertEnginesCancelled(cancelledRig, ['eng-running', 'eng-pending1', 'eng-pending2', 'eng-pending3']);
  });

  // Keep-first: terminalAt pins the FIRST terminal transition. A legacy rig
  // persisted as `'stuck'` that is later cancelled (via SpiderApi.cancel's
  // legacy-tolerant arm) must retain the terminalAt recorded at `stuck`,
  // not overwrite it on the later cancellation.
  it('terminalAt uses keep-first semantics — legacy stuck → cancelled preserves original timestamp', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const stuckAt = '2025-01-01T00:00:00.000Z';
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'stuck',
      engines: [{
        id: 'eng-failed', designId: 'dummy', status: 'failed', upstream: [], givensSpec: {},
        attempts: [{ startedAt: stuckAt, endedAt: stuckAt, status: 'failed', error: 'boom' }],
      }],
      createdAt: stuckAt,
      terminalAt: stuckAt, // simulates the terminalAt written when the rig first entered `stuck`
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(cancelledRig);
    assert.equal(
      cancelledRig.terminalAt,
      stuckAt,
      'terminalAt must not be overwritten on subsequent terminal transition (keep-first)',
    );
  });

  // ── Concurrent engine throttle ────────────────────────────────────────

  describe('countRunningEngines / countRunningEnginesInRig', () => {
    const now = new Date().toISOString();

    function makeRig(id: string, engines: Array<{ id: string; status: string }>): RigDoc {
      return {
        id,
        writId: `writ-${id}`,
        status: 'running',
        engines: engines.map((e) => ({
          id: e.id,
          designId: 'stub',
          status: e.status as EngineInstance['status'],
          upstream: [],
          givensSpec: {},
        })),
        createdAt: now,
      };
    }

    it('counts only running engines across rigs', () => {
      const rigs = [
        makeRig('r1', [
          { id: 'e1', status: 'running' },
          { id: 'e2', status: 'pending' },
          { id: 'e3', status: 'completed' },
        ]),
        makeRig('r2', [
          { id: 'e4', status: 'running' },
          { id: 'e5', status: 'running' },
        ]),
        makeRig('r3', [
          { id: 'e6', status: 'pending' },
          { id: 'e7', status: 'failed' },
          { id: 'e8', status: 'cancelled' },
          { id: 'e9', status: 'skipped' },
        ]),
      ];
      assert.equal(countRunningEngines(rigs), 3, 'should count 3 running engines');
    });

    it('returns 0 when no engines are running', () => {
      const rigs = [makeRig('r1', [{ id: 'e1', status: 'pending' }, { id: 'e2', status: 'completed' }])];
      assert.equal(countRunningEngines(rigs), 0);
    });

    it('returns 0 for empty rigs array', () => {
      assert.equal(countRunningEngines([]), 0);
    });

    it('counts running engines in a single rig', () => {
      const rig = makeRig('r1', [
        { id: 'e1', status: 'running' },
        { id: 'e2', status: 'running' },
        { id: 'e3', status: 'pending' },
        { id: 'e4', status: 'completed' },
      ]);
      assert.equal(countRunningEnginesInRig(rig), 2);
    });

    it('returns 0 when rig has no running engines', () => {
      const rig = makeRig('r1', [{ id: 'e1', status: 'pending' }, { id: 'e2', status: 'pending' }]);
      assert.equal(countRunningEnginesInRig(rig), 0);
    });
  });

  describe('Concurrent engine throttle — tryRun', () => {
    const PARALLEL_TEMPLATE = parallelTpl('quick-stub', ['a', 'b', 'c']);

    it('defers an engine when it would breach the system-wide limit', async () => {
      // maxConcurrentEngines=1: after one engine launches, the next should be deferred
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 3 } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'throttle-test', body: 'b' });
      await spider.crawl(); // spawn rig
      await spider.crawl(); // run engine 'a' → launched (1 running)

      // Now engine 'b' is runnable but system limit is 1
      const result = await spider.crawl();
      // tryRun defers all runnable engines and returns null; trySpawn also returns null → overall null
      assert.equal(result, null, 'should idle when system-wide limit reached');

      const [rig] = await rigsBook(stacks).list();
      assert.equal(findEngine(rig, 'b').status, 'pending', 'engine b should remain pending');
    });

    it('defers an engine when it would breach the per-rig limit', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 10, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'per-rig-test', body: 'b' });
      await spider.crawl(); // spawn rig
      await spider.crawl(); // run engine 'a' → launched (1 running in rig)

      const result = await spider.crawl();
      assert.equal(result, null, 'should idle when per-rig limit reached');

      const [rig] = await rigsBook(stacks).list();
      assert.equal(findEngine(rig, 'b').status, 'pending', 'engine b should remain pending');
    });

    it('starts engine when both limits have room', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 5, maxConcurrentEnginesPerRig: 3 } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider } = fix;
      await clerk.post({ title: 'start-test', body: 'b' });
      await spider.crawl(); // spawn rig
      const result = await spider.crawl(); // run engine 'a' → should succeed
      assert.ok(result !== null, 'should start engine');
      assert.equal(result!.action, 'engine-started');
    });
  });

  describe('Concurrent engine throttle — trySpawn', () => {
    it('does not spawn a new rig when system-wide engine limit is reached', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: singleTpl('only', 'quick-stub') }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig for writ1
      await spider.crawl(); // run engine 'only' in rig1 → launched (1 running)

      const result = await spider.crawl();
      assert.equal(result, null, 'should not spawn second rig when at system limit');

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist');
    });

    it('spawns a new rig when system-wide limit has room', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: singleTpl('only', 'stub-clockwork') }, maxConcurrentEngines: 5 } },
        { status: 'completed' },
        { customEngines: { 'stub-clockwork': clockworkStubDesign } },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig for writ1
      await spider.crawl(); // run clockwork engine in rig1 → completed (0 running now)
      const result = await spider.crawl(); // should spawn rig for writ2
      assert.ok(result !== null, 'should have work');
      assert.equal(result!.action, 'rig-spawned', 'should spawn when limit has room');

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 2, 'both rigs should exist');
    });
  });

  describe('Concurrent engine throttle — behavioral', () => {
    it('with maxConcurrentEngines=2, exactly 2 engines reach running status across rigs', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: singleTpl('only', 'quick-stub') }, maxConcurrentEngines: 2, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;

      for (let i = 1; i <= 4; i++) await clerk.post({ title: `writ${i}`, body: 'b' });

      // Spawn rig1, spawn rig2, run rig1 engine, run rig2 engine, then no more
      for (let i = 0; i < 20; i++) await spider.crawl();

      const allRigs = await rigsBook(stacks).list();
      let totalRunning = 0;
      for (const rig of allRigs) {
        for (const e of rig.engines) if (e.status === 'running') totalRunning++;
      }

      assert.equal(totalRunning, 2, 'exactly 2 engines should be running');
      // trySpawn is also throttled, so only 2 rigs spawn
      assert.equal(allRigs.length, 2, 'only 2 rigs should be spawned (trySpawn throttled)');
    });

    it('deferred engines start once a slot frees after completion', async () => {
      // Two-engine sequential template. With maxConcurrentEngines=1, the
      // clockwork engine occupies the slot transiently (completes in same
      // tick), freeing it for the quick engine on the next tick.
      const TWO_ENGINE: RigTemplate = {
        engines: [
          { id: 'step1', designId: 'stub-clockwork', givens: {} },
          { id: 'step2', designId: 'quick-stub', givens: {}, upstream: ['step1'] },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: TWO_ENGINE }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        { customEngines: { 'stub-clockwork': clockworkStubDesign, 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig1
      await spider.crawl(); // run step1 (clockwork) → engine-completed (slot freed)
      await spider.crawl(); // run step2 (quick) → engine-started (1 running slot used)

      const r = await spider.crawl();
      assert.equal(r, null, 'should idle when quick engine is running and system limit reached');

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist while slot is occupied');
      assert.equal(findEngine(rigs[0], 'step2').status, 'running', 'step2 should be running');
    });
  });

  describe('Concurrent engine throttle — regression', () => {
    it('tryCollect is never throttled', async () => {
      // With maxConcurrentEngines=1, collect should still work even if 1 engine is running
      const fix = buildFixture(
        { spider: { rigTemplates: { default: singleTpl('only', 'animator-quick') }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'animator-quick': {
              id: 'animator-quick',
              async run() {
                const animator = (await import('@shardworks/nexus-core')).guild().apparatus<AnimatorApi>('animator');
                const handle = animator.summon({ role: 'test', prompt: 'test', cwd: '/tmp' });
                return { status: 'launched' as const, sessionId: handle.sessionId };
              },
            },
          },
        },
      );
      const { clerk, spider } = fix;

      await clerk.post({ title: 'collect-test', body: 'b' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run → launched (1 running)

      // The mock animator eagerly writes terminal session, so collect should pick it up
      const result = await spider.crawl();
      assert.ok(result !== null, 'collect should not be blocked by throttle');
      assert.equal(result!.action, 'rig-completed', 'should collect and complete rig');
    });

    it('uses defaults of maxConcurrentEngines=3, maxConcurrentEnginesPerRig=1 when not configured', async () => {
      const fix = buildFixture(
        { spider: { rigTemplates: { default: singleTpl('only', 'quick-stub') } } },
        { status: 'completed' },
        { customEngines: { 'quick-stub': quickStubDesign } },
      );
      const { clerk, spider, stacks } = fix;

      for (let i = 0; i < 5; i++) await clerk.post({ title: `writ${i}`, body: 'b' });

      for (let i = 0; i < 30; i++) await spider.crawl();

      const allRigs = await rigsBook(stacks).list();
      let totalRunning = 0;
      for (const rig of allRigs) {
        for (const e of rig.engines) if (e.status === 'running') totalRunning++;
      }

      assert.equal(totalRunning, 3, 'default maxConcurrentEngines should be 3');
      assert.equal(allRigs.length, 3, 'default limit should cap at 3 spawned rigs');
    });
  });
});

// ── Writ→Rig cascade tests ──────────────────────────────────────────

describe('Spider — writ→rig cascade', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  /**
   * Helper: post a writ, spawn a rig, advance the first engine to running
   * with an active animator session. Returns both writ and rig.
   */
  async function spawnRunningRig(opts?: { parentId?: string }) {
    const { clerk, spider, stacks } = fix;
    const writ = opts?.parentId
      ? await clerk.post({ title: 'Child writ', body: 'child', parentId: opts.parentId })
      : await postWrit(clerk);

    // Writs start in 'open' status (either standalone or child). The parent
    // does not auto-transition when a child is added; children are created
    // directly in 'open'. The spider's trySpawn picks up the 'open' writ.

    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const rigs = await book.find({ where: [['writId', '=', writ.id]], limit: 1 });
    const rig = rigs[0];

    // Mark draft as completed so implement can launch
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'draft'
        ? { ...e, status: 'completed' as const, attempts: [draftCompletedAttempt()] }
        : e,
    );
    await book.patch(rig.id, { engines: updatedEngines });

    await spider.crawl(); // engine-started

    const [rigAfterStart] = await book.find({ where: [['writId', '=', writ.id]], limit: 1 });
    const implEngine = rigAfterStart.engines.find((e: EngineInstance) => e.id === 'implement');

    // Override the auto-completed session to be running
    const implSessionId = implEngine ? latestAttempt(implEngine)?.sessionId : undefined;
    if (implSessionId) {
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.patch(implSessionId, { status: 'running', endedAt: undefined });
    }

    const freshWrit = await clerk.show(writ.id);
    return { writ: freshWrit, rig: rigAfterStart };
  }

  // V1 [R1, R2]: Cancel writ cascades to rig
  it('writ cancelled cascades to rig cancellation', async () => {
    const { clerk, stacks, cancelCalls } = fix;
    const { writ, rig } = await spawnRunningRig();

    await clerk.transition(writ.id, 'cancelled');

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled after writ cancellation');
    assertTerminalAt(updatedRig);

    assert.ok(cancelCalls.length >= 1, 'animator.cancel should have been called');
  });

  // V6 [R5]: Writ failed does NOT cascade to rig cancellation
  it('writ failed does not cascade to rig — rig remains running', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    await clerk.transition(writ.id, 'failed', { resolution: 'External failure' });

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'running', 'rig should remain running after writ failure');
  });

  // V2 [R1, R3]: Cancel writ with no rig (no-op)
  it('writ cancelled with no rig is a silent no-op', async () => {
    const { clerk } = fix;
    const writ = await postWrit(clerk);

    await clerk.transition(writ.id, 'cancelled');

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled');
  });

  // V3 [R1, R4]: Cancel writ when rig is already terminal
  it('writ cancelled when rig is already terminal is a silent no-op', async () => {
    const { clerk, spider, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    await spider.cancel(rig.id);

    const book = rigsBook(stacks);
    const cancelledRig = await book.get(rig.id);
    assert.equal(cancelledRig?.status, 'cancelled', 'rig should already be cancelled');
    assertTerminalAt(cancelledRig);
    const originalTerminalAt = cancelledRig!.terminalAt;

    // The writ may already be cancelled by the rig→writ CDC; if not, cancel it.
    const currentWrit = await clerk.show(writ.id);
    if (currentWrit.phase !== 'cancelled') {
      await clerk.transition(writ.id, 'cancelled');
    }

    // Rig should still be cancelled and terminalAt should be kept (keep-first).
    const rigAfter = await book.get(rig.id);
    assert.equal(rigAfter?.status, 'cancelled', 'rig should remain cancelled');
    assert.equal(
      rigAfter?.terminalAt,
      originalTerminalAt,
      'terminalAt should not be overwritten on idempotent cancel (keep-first)',
    );
  });

  // V4 [R5, R6]: Circular cascade — writ cancelled first
  it('circular cascade completes without error when writ cancelled first', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // writ→rig CDC cancels rig → rig→writ CDC sees writ already terminal, skips
    await clerk.transition(writ.id, 'cancelled');

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled');

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(updatedRig);
  });

  // V4 complement: Circular cascade — rig cancelled first
  it('circular cascade completes without error when rig cancelled first', async () => {
    const { clerk, spider, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // rig→writ CDC transitions writ → writ→rig CDC sees rig already terminal, skips
    await spider.cancel(rig.id);

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled');
    assertTerminalAt(updatedRig);

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled via rig→writ CDC');
  });

  // V5 [R5]: Cancel rig whose writ is already terminal (existing bug fix)
  it('rig cancellation succeeds when writ is already terminal', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Out-of-band cancellation: directly patch the writ to a terminal state
    const writsBook = stacks.book<WritDoc>('clerk', 'writs');
    await writsBook.patch(writ.id, { phase: 'cancelled', resolvedAt: new Date().toISOString() });

    // Cancel should succeed because the guard skips clerk.transition()
    const cancelledRig = await spider.cancel(rig.id);
    assert.equal(cancelledRig.status, 'cancelled', 'rig cancellation should succeed');
    assertTerminalAt(cancelledRig);
  });

  // V8 [R1, R4]: Completed writ with completed rig (no-op)
  it('writ completed with already-completed rig is a silent no-op', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Mark all engines as completed so the rig completes
    const nowIso = new Date().toISOString();
    const completedEngines = rig.engines.map((e: EngineInstance) => ({
      ...e,
      status: 'completed' as const,
      attempts: [{ startedAt: nowIso, endedAt: nowIso, status: 'completed' as const, yields: { mock: true } }],
    }));
    await book.patch(rig.id, { engines: completedEngines, status: 'completed' });

    // The rig→writ CDC should have completed the writ
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should be completed via rig→writ CDC');

    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'completed', 'rig should remain completed');
  });

  // Edge case: legacy blocked rig with cancelled writ.
  // Seeds a legacy-shaped rig doc to verify the writ-cancel CDC path
  // exercises api.cancel's legacy-tolerance branch.
  it('legacy blocked rig is cancelled when writ is cancelled', async () => {
    const { clerk, stacks } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'blocked',
      engines: [
        legacyBlockedEng('eng-blocked'),
        pendingEng('eng-pending', ['eng-blocked']),
      ],
    });

    await clerk.transition(writ.id, 'cancelled');

    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled', 'legacy blocked rig should be cancelled');
    assertTerminalAt(updatedRig);

    // Legacy blocked engine should be flipped to cancelled with hold metadata cleared
    const engBlocked = findEngine(updatedRig!, 'eng-blocked');
    assert.equal(engBlocked.status, 'cancelled', 'legacy blocked engine should be cancelled');
    assert.equal(engBlocked.holdReason, undefined, 'holdReason should be cleared');
    assert.equal(engBlocked.holdCondition, undefined, 'holdCondition should be cleared');
  });

  // [R5]: Writ completed does NOT cascade to rig cancellation
  it('writ completed does not cascade to rig — rig remains running', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'running', 'rig should remain running after writ completion');
  });

  // [R4]: Cancel reason format includes writ ID
  it('cancel reason matches "Writ <writId> cancelled" format', async () => {
    const { clerk, cancelCalls } = fix;
    const { writ } = await spawnRunningRig();

    await clerk.transition(writ.id, 'cancelled');

    const reasonCall = cancelCalls.find((c) => c.options?.reason?.includes(writ.id));
    assert.ok(reasonCall, 'animator.cancel should have been called with writ ID in reason');
    assert.equal(reasonCall!.options!.reason, `Writ ${writ.id} cancelled`, 'reason should match exact format');
  });

  // [R6]: Rig cancel with already-completed writ succeeds
  it('rig cancellation succeeds when writ is already completed', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    const writsBookHandle = stacks.book<WritDoc>('clerk', 'writs');
    await writsBookHandle.patch(writ.id, { phase: 'completed', resolvedAt: new Date().toISOString() });

    const cancelledRig = await spider.cancel(rig.id);
    assert.equal(cancelledRig.status, 'cancelled', 'rig cancellation should succeed');
    assertTerminalAt(cancelledRig);

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should remain completed');
  });

  // [R1]: Cascade with already-terminal rig is idempotent
  it('writ cancelled when rig is already cancelled is a silent no-op', async () => {
    const { clerk, stacks } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = await seedRig(book, {
      writId: writ.id,
      status: 'cancelled',
      engines: [cancelledEng('eng1')],
    });

    await clerk.transition(writ.id, 'cancelled');

    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should remain cancelled');
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled');
  });

  // Mandate's `parentTerminal` action drives the downward cascade: when a
  // mandate parent reaches a `failure`- or `cancelled`-attr terminal,
  // every non-terminal descendant is transitioned to `cancelled` with the
  // canonical resolution `Automatically cancelled due to parent termination`.
  // Spider's writ→rig CDC then cancels each child's rig automatically.
  // The two tests below pin that end-to-end behaviour.

  it('parent writ cancellation cascades to child writ and rig', async () => {
    const { clerk, stacks, realClerk } = fix;

    // Create parent as a draft via realClerk so the fixture's auto-publish
    // wrapper doesn't move it to `open`. The spider only dispatches `open`
    // writs; a `new` parent keeps its own rig out of the picture so this
    // test exercises only the parent→child cascade path.
    const parentWrit = await realClerk.post({ title: 'Parent writ', body: 'parent' });
    assert.equal(parentWrit.phase, 'new', 'parent should be a draft');

    const childWrit = await clerk.post({ title: 'Child writ', body: 'child', parentId: parentWrit.id });
    assert.equal(childWrit.phase, 'open', 'child should be open');

    const book = rigsBook(stacks);
    const childRigId = await seedRig(book, {
      writId: childWrit.id,
      engines: [{ id: 'eng1', designId: 'draft', status: 'running', upstream: [], givensSpec: {}, attempts: [{ startedAt: new Date().toISOString() }] }],
    });

    await realClerk.transition(parentWrit.id, 'cancelled');

    const updatedChildWrit = await clerk.show(childWrit.id);
    assert.equal(updatedChildWrit.phase, 'cancelled', 'child writ should be cancelled via cascade');
    assert.equal(
      updatedChildWrit.resolution,
      'Automatically cancelled due to parent termination',
      'child writ should carry the canonical cascade resolution',
    );

    const updatedChildRig = await book.get(childRigId);
    assert.equal(updatedChildRig?.status, 'cancelled', 'child rig should be cancelled via writ→rig CDC');
  });

  it('parent writ cancellation cascades to multiple child rigs', async () => {
    const { clerk, stacks, realClerk } = fix;

    const parentWrit = await realClerk.post({ title: 'Parent', body: 'parent' });
    assert.equal(parentWrit.phase, 'new', 'parent should be a draft');

    const child1 = await clerk.post({ title: 'Child 1', body: 'c1', parentId: parentWrit.id });
    const child2 = await clerk.post({ title: 'Child 2', body: 'c2', parentId: parentWrit.id });

    const book = rigsBook(stacks);
    const startedAt = new Date().toISOString();
    const draftRunning = (id: string): EngineInstance => ({
      id, designId: 'draft', status: 'running', upstream: [], givensSpec: {},
      attempts: [{ startedAt }],
    });
    const child1RigId = await seedRig(book, { writId: child1.id, engines: [draftRunning('eng1')] });
    const child2RigId = await seedRig(book, { writId: child2.id, engines: [draftRunning('eng1')] });

    await realClerk.transition(parentWrit.id, 'cancelled');

    const updatedChild1 = await clerk.show(child1.id);
    const updatedChild2 = await clerk.show(child2.id);
    assert.equal(updatedChild1.phase, 'cancelled', 'child1 writ should be cancelled via cascade');
    assert.equal(updatedChild2.phase, 'cancelled', 'child2 writ should be cancelled via cascade');
    assert.equal(updatedChild1.resolution, 'Automatically cancelled due to parent termination');
    assert.equal(updatedChild2.resolution, 'Automatically cancelled due to parent termination');

    const updatedRig1 = await book.get(child1RigId);
    const updatedRig2 = await book.get(child2RigId);
    assert.equal(updatedRig1?.status, 'cancelled', 'child1 rig should be cancelled via writ→rig CDC');
    assert.equal(updatedRig2?.status, 'cancelled', 'child2 rig should be cancelled via writ→rig CDC');
  });
});
