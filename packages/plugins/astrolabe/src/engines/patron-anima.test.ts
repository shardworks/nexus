/**
 * patron-anima engine tests.
 *
 * Covers:
 *   - skip-when-unset: no `astrolabe.patronRole` configured → no-op
 *   - fast-path: no reviewable decisions → no-op (no anima call)
 *   - happy path: anima confirms the analyst recommendation
 *   - override path: anima picks a different option; `selected` tracks it
 *   - fill-in path: no analyst recommendation; anima supplies one
 *   - partial emission: some decisions missing from the anima's response
 *     are left unfilled (for decision-review to catch)
 *   - malformed / missing JSON → all reviewable decisions left unfilled
 *   - confidence calibration plumbed through to `Decision.patron.confidence`
 *   - pre-decided decisions untouched even when present in the plan
 *   - `confirm` verdict whose selection disagrees with recommendation → dropped
 *   - `override` verdict whose selection matches recommendation → dropped
 *   - unknown option key in selection → dropped
 *   - emission that is an object wrapper (`{ verdicts: [...] }`) → accepted
 *   - buildPatronPrompt includes analyst recommendation + rationale
 *   - buildPatronPrompt carries the tailored operational discipline:
 *     one-option-per-decision, principle-structural confidence calibration,
 *     abstain-by-omission, explicit out-of-lane prohibition on codebase
 *     audit, three-verdict worked example with abstained entry absent
 *   - buildPatronPrompt pulls static content from the packaged markdown
 *     file rather than assembling it inline
 *   - extractJsonBlock picks the last fenced block
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';
import type {
  AnimatorApi,
  AnimateHandle,
  SessionChunk,
  SessionDoc,
  SummonRequest,
} from '@shardworks/animator-apparatus';

import {
  createPatronAnimaEngine,
  buildPatronPrompt,
  extractJsonBlock,
  parseEmission,
} from './patron-anima.ts';
import type { Decision, PlanDoc } from '../types.ts';

// ── Test harness ─────────────────────────────────────────────────────

let stacks: StacksApi;
let plansBook: Book<PlanDoc>;
let sessionsBook: Book<SessionDoc>;
let memBackend: MemoryBackend;

interface FakeAnimator extends AnimatorApi {
  /** All summon calls captured in order. */
  summonCalls: SummonRequest[];
  /** Set the output that the next summon call's session will record to Stacks. */
  nextOutput: string | null;
  /** Override the status written to the SessionDoc (default: 'completed'). */
  nextStatus: SessionDoc['status'];
}

let fakeAnimator: FakeAnimator;

function emptyChunks(): AsyncIterable<SessionChunk> {
  return {
    [Symbol.asyncIterator]: async function* () {
      // no chunks
    },
  };
}

function makeFakeAnimator(): FakeAnimator {
  const inst: FakeAnimator = {
    summonCalls: [],
    nextOutput: null,
    nextStatus: 'completed',
    summon(request: SummonRequest): AnimateHandle {
      inst.summonCalls.push(request);
      const sessionId = `ses-${inst.summonCalls.length.toString().padStart(4, '0')}`;
      const now = new Date().toISOString();
      const doc: SessionDoc = {
        id: sessionId,
        status: inst.nextStatus,
        startedAt: now,
        endedAt: now,
        durationMs: 1,
        provider: 'fake',
        exitCode: 0,
        ...(inst.nextOutput !== null ? { output: inst.nextOutput } : {}),
        metadata: request.metadata ?? {},
      };
      // Write eagerly so collect() can read it synchronously.
      void sessionsBook.put(doc);
      return {
        sessionId,
        chunks: emptyChunks(),
        result: Promise.resolve({
          id: sessionId,
          status: inst.nextStatus === 'cancelled' || inst.nextStatus === 'pending' || inst.nextStatus === 'running'
            ? 'completed'
            : inst.nextStatus,
          startedAt: now,
          endedAt: now,
          durationMs: 1,
          provider: 'fake',
          exitCode: 0,
          ...(inst.nextOutput !== null ? { output: inst.nextOutput } : {}),
        }),
      };
    },
    animate(): AnimateHandle {
      throw new Error('FakeAnimator.animate not implemented');
    },
    subscribeToSession() {
      return null;
    },
    async cancel() {
      throw new Error('FakeAnimator.cancel not implemented');
    },
  };
  return inst;
}

function buildCtx(overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    rigId: 'rig-pa-001',
    engineId: 'patron-anima',
    upstream: {},
    ...overrides,
  };
}

function buildStartupCtx(): StartupContext {
  return { on() {}, kits() { return []; } };
}

function setup(config: { patronRole?: string } = {}): void {
  memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig & { astrolabe?: { patronRole?: string } } = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    settings: { model: 'sonnet' },
    ...(config.patronRole !== undefined ? { astrolabe: { patronRole: config.patronRole } } : {}),
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  const stacksApparatus = (stacksPlugin as {
    apparatus: { start: (ctx: StartupContext) => void; provides: unknown };
  }).apparatus;
  stacksApparatus.start(buildStartupCtx());
  stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  memBackend.ensureBook({ ownerId: 'astrolabe', book: 'plans' }, {
    indexes: ['status', 'codex', 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['status', 'startedAt'],
  });

  plansBook = stacks.book<PlanDoc>('astrolabe', 'plans');
  sessionsBook = stacks.book<SessionDoc>('animator', 'sessions');

  fakeAnimator = makeFakeAnimator();
  apparatusMap.set('animator', fakeAnimator);
}

function makePlan(overrides: Partial<PlanDoc> = {}): PlanDoc {
  const now = new Date().toISOString();
  return {
    id: 'w-pa-001',
    codex: 'test-codex',
    status: 'analyzing',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Skip-when-unset tests ────────────────────────────────────────────

describe('patron-anima engine — skip-when-unset', () => {
  afterEach(() => { clearGuild(); });

  it('no-ops when astrolabe config is absent entirely', async () => {
    setup(); // no patronRole
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, {});

    // Animator must NOT be invoked when no patron is configured.
    assert.equal(fakeAnimator.summonCalls.length, 0);

    // Plan is unchanged — decision is still reviewable (selected undefined).
    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
    assert.equal(updated?.decisions?.[0].patron, undefined);
  });

  it('no-ops when patronRole is an empty string', async () => {
    setup({ patronRole: '' });
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' } },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.equal(fakeAnimator.summonCalls.length, 0);
  });

  it('no-ops when patronRole is whitespace only', async () => {
    setup({ patronRole: '   ' });
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' } },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.equal(fakeAnimator.summonCalls.length, 0);
  });
});

// ── Fast-path: no reviewable decisions ───────────────────────────────

describe('patron-anima engine — no reviewable decisions', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('no-ops and does not invoke animator when plan has no decisions', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const plan = makePlan({ decisions: [] });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.equal(fakeAnimator.summonCalls.length, 0);
  });

  it('no-ops when every decision is already pre-decided by the analyst', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, selected: 'A' },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'X' }, selected: 'X' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.equal(fakeAnimator.summonCalls.length, 0);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, 'A');
    assert.equal(updated?.decisions?.[1].selected, 'X');
  });
});

// ── Run/collect happy paths ──────────────────────────────────────────

describe('patron-anima engine — run/collect with verdicts', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('confirm: applies analyst recommendation and records patron emission', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which pattern?',
        options: { A: 'Strategy', B: 'Observer' },
        recommendation: 'A',
        rationale: 'Simpler',
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high',
          rationale: 'Matches simplicity principle.' },
      ]) +
      '\n```';

    const givens = { planId: plan.id, cwd: '/tmp/draft' };
    const runResult = await engine.run(givens, buildCtx());
    assert.equal(runResult.status, 'launched');
    const launched = runResult as { status: 'launched'; sessionId: string };
    assert.ok(launched.sessionId);

    // Animator received the request.
    assert.equal(fakeAnimator.summonCalls.length, 1);
    assert.equal(fakeAnimator.summonCalls[0].role, 'guild.patron');
    assert.equal(fakeAnimator.summonCalls[0].cwd, '/tmp/draft');
    assert.ok(fakeAnimator.summonCalls[0].prompt.includes('D1'));

    // Collect applies the verdict.
    assert.equal(typeof engine.collect, 'function');
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { sessionId: string; touchedDecisionIds: string[]; totalReviewable: number };
    assert.equal(yields.sessionId, launched.sessionId);
    assert.deepEqual(yields.touchedDecisionIds, ['D1']);
    assert.equal(yields.totalReviewable, 1);

    const updated = await plansBook.get(plan.id);
    const d1 = updated?.decisions?.[0];
    assert.equal(d1?.selected, 'A');
    assert.equal(d1?.patron?.verdict, 'confirm');
    assert.equal(d1?.patron?.selection, 'A');
    assert.equal(d1?.patron?.confidence, 'high');
    assert.equal(d1?.patron?.rationale, 'Matches simplicity principle.');
  });

  it('override: applies anima selection, not the analyst recommendation', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'Option A', B: 'Option B' },
        recommendation: 'A',
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'override', selection: 'B', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id, cwd: '/tmp/draft' };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    const d1 = updated?.decisions?.[0];
    assert.equal(d1?.selected, 'B'); // override, not recommendation
    assert.equal(d1?.patron?.verdict, 'override');
    assert.equal(d1?.patron?.selection, 'B');
  });

  it('fill-in: supplies selection when there is no analyst recommendation', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { X: 'X', Y: 'Y' },
        // no recommendation
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'fill-in', selection: 'Y', confidence: 'med' },
      ]) +
      '\n```';

    const givens = { planId: plan.id, cwd: '/tmp/draft' };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    const d1 = updated?.decisions?.[0];
    assert.equal(d1?.selected, 'Y');
    assert.equal(d1?.patron?.verdict, 'fill-in');
    assert.equal(d1?.patron?.confidence, 'med');
  });

  it('low-confidence emissions are still applied (defensive parser leniency — the prompt tells the anima to abstain instead)', async () => {
    // Under the tailored operational discipline, the anima is instructed to
    // abstain (omit) on `low` calibration rather than emit it. The parser,
    // however, still accepts `low` as a valid value — this test locks in
    // that defensive leniency so a stray low emission from a mis-behaving
    // anima is applied rather than silently dropped.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'low',
          rationale: 'Stray low-confidence emission.' },
      ]) +
      '\n```';

    const givens = { planId: plan.id, cwd: '/tmp/draft' };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    const d1 = updated?.decisions?.[0];
    assert.equal(d1?.selected, 'A');
    assert.equal(d1?.patron?.confidence, 'low');
    assert.equal(d1?.patron?.verdict, 'confirm');
  });
});

// ── Partial emission / malformed input ───────────────────────────────

describe('patron-anima engine — partial / malformed emissions', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('fills only the decisions covered by the emission; leaves the rest unfilled', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q1?', options: { A: 'A', B: 'B' }, recommendation: 'A' },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'X', Y: 'Y' }, recommendation: 'X' },
      { id: 'D3', scope: [], question: 'Q3?', options: { P: 'P', Q: 'Q' }, recommendation: 'P' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    // Anima only answered D1 and D3 — skipped D2.
    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
        { id: 'D3', verdict: 'override', selection: 'Q', confidence: 'med' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[] };
    assert.deepEqual(yields.touchedDecisionIds, ['D1', 'D3']);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, 'A');
    assert.equal(updated?.decisions?.[1].selected, undefined,
      'D2 was omitted from the emission → stays reviewable for decision-review');
    assert.equal(updated?.decisions?.[1].patron, undefined);
    assert.equal(updated?.decisions?.[2].selected, 'Q');
  });

  it('unparseable output leaves all decisions unfilled — does not throw', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    // Output is prose with no JSON fence.
    fakeAnimator.nextOutput = 'Sorry, I cannot help with this request.';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[]; totalReviewable: number };

    assert.deepEqual(yields.touchedDecisionIds, []);
    assert.equal(yields.totalReviewable, 1);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
    assert.equal(updated?.decisions?.[0].patron, undefined);
  });

  it('malformed JSON inside the fence leaves all decisions unfilled', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput = '```json\n{ this is not valid\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });

  it('empty session output leaves all decisions unfilled', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput = null;

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });

  it('failed session still collects cleanly — decisions left unfilled', async () => {
    // The session ended in 'failed' status — engine should not throw during
    // collect; unfilled decisions fall through to decision-review as normal.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextStatus = 'failed';
    fakeAnimator.nextOutput = null;

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[] };
    assert.deepEqual(yields.touchedDecisionIds, []);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });
});

// ── Invariant guards on malformed verdicts ───────────────────────────

describe('patron-anima engine — verdict validation', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('confirm that does not match the analyst recommendation is dropped', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    // The anima says "confirm" but the selection disagrees with the
    // recommendation — this is nonsensical; drop the verdict so we don't
    // silently relabel it as an override.
    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'B', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[] };
    assert.deepEqual(yields.touchedDecisionIds, []);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
    assert.equal(updated?.decisions?.[0].patron, undefined);
  });

  it('override whose selection matches the recommendation is dropped', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A', B: 'B' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'override', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });

  it('unknown option key is rejected — anima cannot write custom answers', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A', B: 'B' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'override', selection: 'Z', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });

  it('verdict for an unknown decision id is ignored', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
        { id: 'D999', verdict: 'confirm', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    assert.deepEqual((collected as { touchedDecisionIds: string[] }).touchedDecisionIds, ['D1']);
  });

  it('invalid confidence value drops the verdict', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'unsure' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined);
  });

  it('object-wrapped emission (`{ verdicts: [...] }`) is accepted', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify({
        verdicts: [
          { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
        ],
      }) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    assert.deepEqual((collected as { touchedDecisionIds: string[] }).touchedDecisionIds, ['D1']);
  });
});

// ── Pre-decided decisions are untouched ──────────────────────────────

describe('patron-anima engine — pre-decided decisions', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('only reviewable decisions are prompted; pre-decided ones are left alone', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Reviewable?', options: { A: 'A', B: 'B' }, recommendation: 'A' },
      { id: 'D2', scope: [], question: 'Pre-decided?', options: { X: 'X', Y: 'Y' }, selected: 'X' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };

    // The prompt must mention D1 only (not D2).
    assert.equal(fakeAnimator.summonCalls.length, 1);
    const prompt = fakeAnimator.summonCalls[0].prompt;
    assert.ok(prompt.includes('D1'));
    assert.ok(!prompt.includes('D2'));

    await engine.collect!(launched.sessionId, givens, buildCtx());

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, 'A'); // D1 filled by anima
    assert.equal(updated?.decisions?.[0].patron?.verdict, 'confirm');
    assert.equal(updated?.decisions?.[1].selected, 'X'); // D2 pre-decided, untouched
    assert.equal(updated?.decisions?.[1].patron, undefined);
  });
});

// ── Error paths ──────────────────────────────────────────────────────

describe('patron-anima engine — error paths', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('throws when plan not found', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    await assert.rejects(
      () => engine.run({ planId: 'nonexistent' }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('not found'));
        return true;
      },
    );
  });

  it('throws when planId given is missing', async () => {
    const engine = createPatronAnimaEngine(() => plansBook);
    await assert.rejects(
      () => engine.run({}, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('planId'));
        return true;
      },
    );
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe('patron-anima — pure helpers', () => {
  it('buildPatronPrompt includes question, options, and analyst recommendation', () => {
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which pattern?',
        context: 'Chosen in the spec writer',
        options: { A: 'Strategy', B: 'Observer' },
        recommendation: 'A',
        rationale: 'Simpler',
      },
    ];
    const prompt = buildPatronPrompt(decisions);
    assert.ok(prompt.includes('D1'));
    assert.ok(prompt.includes('Which pattern?'));
    assert.ok(prompt.includes('Chosen in the spec writer'));
    assert.ok(prompt.includes('Strategy'));
    assert.ok(prompt.includes('Observer'));
    assert.ok(prompt.includes('Analyst recommendation'));
    assert.ok(prompt.includes('Simpler'));
    // Calibration guidance plumbed through.
    assert.ok(prompt.includes('confidence'));
    assert.ok(prompt.includes('confirm'));
    assert.ok(prompt.includes('override'));
    assert.ok(prompt.includes('fill-in'));
  });

  it('buildPatronPrompt notes absence of analyst recommendation', () => {
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A' },
      },
    ];
    const prompt = buildPatronPrompt(decisions);
    assert.ok(prompt.includes('(none — you must fill in)'));
  });

  it('extractJsonBlock picks the last fenced block', () => {
    const output = 'First:\n```json\n[1]\n```\n\nSecond:\n```json\n[2]\n```\n';
    assert.equal(extractJsonBlock(output), '[2]');
  });

  it('extractJsonBlock returns null when output has no JSON', () => {
    assert.equal(extractJsonBlock('just prose'), null);
  });

  it('extractJsonBlock accepts plain fences (no json tag)', () => {
    assert.equal(extractJsonBlock('```\n[3]\n```'), '[3]');
  });

  it('extractJsonBlock accepts a bare JSON array', () => {
    assert.equal(extractJsonBlock('[1,2,3]'), '[1,2,3]');
  });

  it('parseEmission silently drops non-object entries', () => {
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const output =
      '```json\n' +
      JSON.stringify([
        null,
        'not-an-object',
        42,
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';
    const result = parseEmission(output, decisions);
    assert.equal(result.size, 1);
    assert.equal(result.get('D1')?.selection, 'A');
  });

  it('parseEmission drops override verdict lacking an analyst recommendation', () => {
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A', B: 'B' } },
      // no recommendation, so `override` is meaningless
    ];
    const output =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'override', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';
    const result = parseEmission(output, decisions);
    assert.equal(result.size, 0);
  });

  it('parseEmission omits rationale field when anima did not supply one', () => {
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A' }, recommendation: 'A' },
    ];
    const output =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';
    const result = parseEmission(output, decisions);
    const emission = result.get('D1');
    assert.ok(emission);
    assert.equal(emission.rationale, undefined);
  });
});

// ── Operational-prompt discipline framings ───────────────────────────

/**
 * The tailored operational prompt is the unit of value shipped by this
 * commission. These assertions pin each discipline framing to the rendered
 * prompt so future edits to the markdown can't silently drop one. They also
 * verify the static content is loaded from the packaged markdown file (not
 * reassembled in TypeScript) and that the output-contract example spans
 * the three verdicts plus an explicit abstain-by-omission worked example.
 */
describe('buildPatronPrompt — tailored operational discipline', () => {
  const sampleDecisions: Decision[] = [
    {
      id: 'D1',
      scope: [],
      question: 'Which pattern?',
      options: { A: 'Strategy', B: 'Observer' },
      recommendation: 'A',
      rationale: 'Simpler',
    },
  ];

  // The markdown prompt is hard-wrapped, so assertions that need to span a
  // line break use a helper that normalises whitespace before matching.
  const oneLine = (s: string): string => s.replace(/\s+/g, ' ');

  it('carries the one-option-per-decision constraint', () => {
    const prompt = oneLine(buildPatronPrompt(sampleDecisions));
    // Each decision offers a fixed set of option keys; selection must be one of them.
    assert.match(
      prompt,
      /one of the offered option keys/i,
      'prompt must forbid custom / free-text answers',
    );
    assert.match(
      prompt,
      /no custom answers/i,
      'prompt must name the custom-answer failure mode explicitly',
    );
  });

  it('encodes abstain-by-omission — no placeholder verdict, decision simply absent', () => {
    const prompt = oneLine(buildPatronPrompt(sampleDecisions));
    assert.match(prompt, /abstain/i, 'prompt must name the abstain mode');
    assert.match(
      prompt,
      /leave the decision out of your emission array entirely/i,
      'prompt must instruct omission as the abstain mechanism',
    );
    // Must not slip back into the old "default to confirm at low" framing.
    assert.doesNotMatch(
      prompt,
      /default(ing)? to (`?confirm`?|confirm) at (`?low`?|low)/i,
      'prompt must not carry the old default-to-confirm-at-low framing',
    );
    // Must explicitly reject placeholder verdicts / low-confidence confirms as substitutes for abstain.
    assert.match(
      prompt,
      /do not emit a placeholder verdict/i,
      'prompt must forbid placeholder verdicts as abstain substitutes',
    );
    assert.match(
      prompt,
      /do not emit a low-confidence confirm/i,
      'prompt must forbid low-confidence-confirm as an abstain substitute',
    );
  });

  it('carries the explicit out-of-lane prohibition on codebase audit', () => {
    const prompt = oneLine(buildPatronPrompt(sampleDecisions));
    assert.match(prompt, /out of lane/i, 'prompt must have a named out-of-lane section');
    assert.match(prompt, /do not read files/i, 'prompt must forbid file reads');
    assert.match(prompt, /grep/i, 'prompt must forbid grep specifically');
    assert.match(
      prompt,
      /do not audit the codebase/i,
      'prompt must forbid codebase audit explicitly',
    );
    assert.match(
      prompt,
      /do not probe implementation feasibility/i,
      'prompt must forbid implementation-feasibility probing',
    );
    assert.match(
      prompt,
      /do not second-guess the analyst/i,
      'prompt must forbid re-doing the analyst\'s framing work',
    );
  });

  it('calibrates confidence structurally — one principle fires = high, multiple conflict = med, none speaks = abstain', () => {
    const prompt = oneLine(buildPatronPrompt(sampleDecisions));
    // Calibration is structural, not content-aware.
    assert.match(
      prompt,
      /confidence is \*?\*?structural\*?\*?/i,
      'prompt must frame confidence as structural',
    );
    // Reject content-aware calibration drift explicitly.
    assert.match(
      prompt,
      /not from how familiar the domain feels/i,
      'prompt must reject domain-familiarity as a confidence source',
    );
    // The three calibrations and their structural meanings.
    assert.match(
      prompt,
      /`high`.{0,80}(one principle|single principle).{0,80}fires? cleanly/i,
      'high calibration must be: one principle fires cleanly',
    );
    assert.match(
      prompt,
      /`med`.{0,160}(multiple|more than one) principles? speak.{0,80}conflict/i,
      'med calibration must be: multiple principles conflict',
    );
    assert.match(
      prompt,
      /`low`.{0,80}no principle speaks/i,
      'low calibration description must be: no principle speaks (and therefore abstain)',
    );
  });

  it('output-contract example spans all three verdicts (confirm / override / fill-in)', () => {
    const prompt = buildPatronPrompt(sampleDecisions);
    // There must be a worked example.
    assert.match(prompt, /worked example/i);
    // Find the fenced JSON example block — the example emission array.
    const fenceMatch = /```json\n([\s\S]+?)\n```/g.exec(prompt);
    assert.ok(fenceMatch, 'prompt must contain at least one fenced JSON example block');
    const exampleBlock = fenceMatch[1];
    assert.match(exampleBlock, /"verdict"\s*:\s*"confirm"/, 'example must include a confirm entry');
    assert.match(exampleBlock, /"verdict"\s*:\s*"override"/, 'example must include an override entry');
    assert.match(exampleBlock, /"verdict"\s*:\s*"fill-in"/, 'example must include a fill-in entry');
    // Sanity: the example array should parse as exactly three entries.
    const parsed = JSON.parse(exampleBlock) as Array<{ verdict: string }>;
    assert.equal(parsed.length, 3, 'example emission array must have exactly three entries');
  });

  it('output-contract example demonstrates abstain-by-omission with a named, absent decision', () => {
    const prompt = buildPatronPrompt(sampleDecisions);
    const flat = oneLine(prompt);
    const fenceMatch = /```json\n([\s\S]+?)\n```/g.exec(prompt);
    assert.ok(fenceMatch);
    const exampleBlock = fenceMatch[1];
    const parsed = JSON.parse(exampleBlock) as Array<{ id: string }>;
    const exampleIds = parsed.map(e => e.id);
    // The example prose names four decisions (EX-1 through EX-4); one is abstained.
    const namedIds = ['EX-1', 'EX-2', 'EX-3', 'EX-4'];
    for (const id of namedIds) {
      assert.match(prompt, new RegExp(id), `example prose should reference ${id} explicitly`);
    }
    const missingFromArray = namedIds.filter(id => !exampleIds.includes(id));
    assert.equal(
      missingFromArray.length,
      1,
      'exactly one of the four example decisions must be absent from the emission array (the abstain case)',
    );
    // And the prose must point at that absence as the abstain signal.
    assert.match(
      flat,
      new RegExp(`${missingFromArray[0]}.{0,40}absent`, 'i'),
      'the abstained decision\'s absence from the array must be called out in prose',
    );
  });

  it('does not mention pre-empted decisions (belt-and-suspenders: the engine filters them before the prompt is composed)', () => {
    const prompt = buildPatronPrompt(sampleDecisions);
    assert.doesNotMatch(
      prompt,
      /pre-?empt/i,
      'prompt must not instruct the anima about pre-empted decisions — they are filtered upstream',
    );
  });

  it('loads its static content from the packaged markdown file, not from TypeScript string fragments', () => {
    // The markdown must be part of the plugin's published distribution.
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

    const pkgJson = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8')) as {
      files?: string[];
    };
    assert.ok(Array.isArray(pkgJson.files), 'package.json must declare a files list');
    assert.ok(
      pkgJson.files!.includes('patron-anima-prompt.md'),
      'patron-anima-prompt.md must be packaged in the plugin distribution',
    );

    // The distinctive operational-prompt language must live in the markdown
    // file, not in the engine's TypeScript. (Spot-check a distinctive phrase.)
    const md = readFileSync(resolve(pkgRoot, 'patron-anima-prompt.md'), 'utf-8');
    assert.match(
      md,
      /leave the decision out of your emission array entirely/i,
      'abstain-by-omission language must live in the markdown file',
    );
    assert.match(
      md,
      /out of lane/i,
      'out-of-lane section heading must live in the markdown file',
    );

    const engineSrc = readFileSync(resolve(pkgRoot, 'src/engines/patron-anima.ts'), 'utf-8');
    assert.doesNotMatch(
      engineSrc,
      /leave the decision out of your emission array entirely/i,
      'abstain-by-omission prose must not be embedded inline in patron-anima.ts',
    );
  });
});
