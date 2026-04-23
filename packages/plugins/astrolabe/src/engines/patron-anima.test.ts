/**
 * patron-anima engine tests.
 *
 * Covers:
 *   - skip-when-unset: no `astrolabe.patronRole` configured → no-op
 *   - fast-path: no decisions on the plan → no-op (no anima call)
 *   - attended-primer contract: a fully pre-filled plan still launches a
 *     session and every decision is reviewed
 *   - every decision appears in the rendered prompt when the plan is
 *     fully pre-filled (D6 drift-prevention)
 *   - abstention surfacing: decisions the anima omits from its emission
 *     have `selected` and `patronOverride` cleared (D7)
 *   - happy path: anima confirms the primer recommendation
 *   - override path: anima picks a different option; `selected` tracks it
 *   - fill-in path: no primer recommendation; anima supplies one
 *   - first-class `low`-confirm path: no principle speaks → confirm the
 *     primer at `low` (D5)
 *   - narrow abstention: anima omits a decision on irresolvable principle
 *     conflict → that decision flows through unfilled
 *   - partial emission: some decisions missing from the anima's response
 *     are left unfilled (for decision-review to catch)
 *   - malformed / missing JSON → all decisions left unfilled
 *   - confidence calibration plumbed through to `Decision.patron.confidence`
 *   - `confirm` verdict whose selection disagrees with recommendation → dropped
 *   - `override` verdict whose selection matches recommendation → dropped
 *   - unknown option key in selection → dropped
 *   - emission that is an object wrapper (`{ verdicts: [...] }`) → accepted
 *   - buildPatronPrompt includes primer recommendation + rationale
 *   - buildPatronPrompt carries the tailored operational discipline:
 *     one-option-per-decision, principle-structural confidence calibration
 *     with `low`-confirm as a first-class emission path, narrow abstention
 *     by omission reserved for irresolvable principle conflict and broken
 *     decision frame only, explicit out-of-lane prohibition on codebase
 *     audit, worked example with four emitted verdicts plus one absent id
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

// ── Fast-paths and the attended-primer contract ──────────────────────

describe('patron-anima engine — no decisions on plan', () => {
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
});

describe('patron-anima engine — attended-primer contract (every decision reviewed)', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('launches a session and reviews every decision even when the primer has pre-filled `selected` on all of them', async () => {
    // Under attended mode, the primer pre-fills `selected` on every
    // decision and patron-anima principle-checks them all. The engine
    // must NOT short-circuit on a fully pre-filled plan.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q1?', options: { A: 'Alpha', B: 'Beta' }, recommendation: 'A', selected: 'A' },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'Xi', Y: 'Yankee' }, recommendation: 'X', selected: 'X' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
        { id: 'D2', verdict: 'confirm', selection: 'X', confidence: 'low' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const result = await engine.run(givens, buildCtx());

    // Engine launched a session — it did NOT short-circuit.
    assert.equal(result.status, 'launched');
    assert.equal(fakeAnimator.summonCalls.length, 1);

    const launched = result as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[]; totalReviewable: number };

    // Every decision was reviewed — the anima's verdicts landed on every one.
    assert.deepEqual(yields.touchedDecisionIds, ['D1', 'D2']);
    assert.equal(yields.totalReviewable, 2);

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].patron?.verdict, 'confirm');
    assert.equal(updated?.decisions?.[1].patron?.verdict, 'confirm');
    assert.equal(updated?.decisions?.[1].patron?.confidence, 'low');
  });
});

// ── Run/collect happy paths ──────────────────────────────────────────

describe('patron-anima engine — run/collect with verdicts', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('confirm: applies primer recommendation and records patron emission', async () => {
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

  it('override: applies anima selection, not the primer recommendation', async () => {
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

  it('fill-in: supplies selection when there is no primer recommendation', async () => {
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

  it('low-confidence confirm is applied as a first-class emission path (principle-absence → confirm the primer)', async () => {
    // `low` confidence is a first-class supported emission: it means "no
    // principle from the role speaks to this decision, so the primer's
    // recommendation stands." The anima confirms and records confidence
    // as `low`, and the engine writes both through to `Decision.selected`
    // and `Decision.patron`. This is the D5 behaviour: `low` is not
    // defensive leniency and is not reserved for abstention.
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
          rationale: 'No principle speaks — confirming the primer.' },
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
    assert.equal(d1?.patron?.rationale, 'No principle speaks — confirming the primer.');
  });

  it('narrow abstention (decision omitted) leaves the decision unfilled — irresolvable principle conflict case', async () => {
    // The anima abstains on D1 (irresolvable principle conflict) by
    // omitting it from the emission array, and confirms D2 at high.
    // D1 flows through to decision-review unfilled; D2 is applied.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Hard conflict?', options: { A: 'A', B: 'B' }, recommendation: 'A' },
      { id: 'D2', scope: [], question: 'Clean?', options: { X: 'X', Y: 'Y' }, recommendation: 'X' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D2', verdict: 'confirm', selection: 'X', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id, cwd: '/tmp/draft' };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[] };

    assert.deepEqual(yields.touchedDecisionIds, ['D2']);
    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.decisions?.[0].selected, undefined,
      'D1 (narrow abstention) must remain unfilled for decision-review to surface');
    assert.equal(updated?.decisions?.[0].patron, undefined);
    assert.equal(updated?.decisions?.[1].selected, 'X');
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

  it('confirm that does not match the primer recommendation is dropped', async () => {
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

// ── Every decision in a fully pre-filled plan lands in the prompt ────

describe('patron-anima engine — every decision reaches the prompt', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('with a fully pre-filled plan, every decision appears in the rendered prompt', async () => {
    // D6 drift-prevention: the attended-primer role file contractually
    // pre-fills `selected` on every decision, and patron-anima must
    // principle-check them all. Asserting prompt content guards against
    // any future filter that would hide pre-filled decisions from the
    // anima.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q1?', options: { A: 'A', B: 'B' }, recommendation: 'A', selected: 'A' },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'X', Y: 'Y' }, recommendation: 'X', selected: 'X' },
      { id: 'D3', scope: [], question: 'Q3?', options: { P: 'P', Q: 'Q' }, recommendation: 'Q', selected: 'Q' },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
        { id: 'D2', verdict: 'confirm', selection: 'X', confidence: 'med' },
        { id: 'D3', verdict: 'confirm', selection: 'Q', confidence: 'low' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    assert.equal(runResult.status, 'launched');

    // The prompt must mention every decision id and question.
    assert.equal(fakeAnimator.summonCalls.length, 1);
    const prompt = fakeAnimator.summonCalls[0].prompt;
    assert.ok(prompt.includes('D1'), 'D1 must appear in the rendered prompt');
    assert.ok(prompt.includes('D2'), 'D2 must appear in the rendered prompt');
    assert.ok(prompt.includes('D3'), 'D3 must appear in the rendered prompt');
    assert.ok(prompt.includes('Q1?'));
    assert.ok(prompt.includes('Q2?'));
    assert.ok(prompt.includes('Q3?'));
  });
});

// ── Abstention surfacing through cleared `selected` ──────────────────

describe('patron-anima engine — abstention surfacing', () => {
  beforeEach(() => { setup({ patronRole: 'guild.patron' }); });
  afterEach(() => { clearGuild(); });

  it('clears `selected` and `patronOverride` on decisions the anima abstains on, so decision-review surfaces them', async () => {
    // D7: engine-only test. With a fully pre-filled plan, the anima
    // emits verdicts for only a subset of decisions. Omitted decisions
    // ("narrow abstention by omission") must have both `selected` and
    // `patronOverride` cleared after collect() so decision-review's
    // `selected === undefined` filter surfaces them to the patron.
    const engine = createPatronAnimaEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Clean?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
        selected: 'A',
      },
      {
        id: 'D2',
        scope: [],
        question: 'Irresolvable conflict?',
        options: { X: 'X', Y: 'Y' },
        recommendation: 'X',
        // The primer pre-filled both `selected` and a stray override
        // (shouldn't happen in practice, but the engine must defensively
        // clear it regardless — D3 clear-both).
        selected: 'X',
        patronOverride: 'Y',
      },
    ];
    const plan = makePlan({ decisions });
    await plansBook.put(plan);

    // Anima emits for D1 only; D2 is abstained (absent from the array).
    fakeAnimator.nextOutput =
      '```json\n' +
      JSON.stringify([
        { id: 'D1', verdict: 'confirm', selection: 'A', confidence: 'high' },
      ]) +
      '\n```';

    const givens = { planId: plan.id };
    const runResult = await engine.run(givens, buildCtx());
    const launched = runResult as { status: 'launched'; sessionId: string };
    const collected = await engine.collect!(launched.sessionId, givens, buildCtx());
    const yields = collected as { touchedDecisionIds: string[] };
    assert.deepEqual(yields.touchedDecisionIds, ['D1']);

    const updated = await plansBook.get(plan.id);

    // D1 was emitted — anima's verdict landed on both `selected` and `patron`.
    assert.equal(updated?.decisions?.[0].selected, 'A');
    assert.equal(updated?.decisions?.[0].patron?.verdict, 'confirm');

    // D2 was abstained — `selected` and `patronOverride` both cleared so
    // decision-review will surface the decision to the patron.
    assert.equal(updated?.decisions?.[1].selected, undefined,
      'abstained decision must have `selected` cleared to surface via decision-review');
    assert.equal(updated?.decisions?.[1].patronOverride, undefined,
      'abstained decision must have `patronOverride` cleared defensively (D3)');
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
  it('buildPatronPrompt includes question, options, and primer recommendation', () => {
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
    assert.ok(prompt.includes('Primer recommendation'));
    assert.ok(prompt.includes('Simpler'));
    // Calibration guidance plumbed through.
    assert.ok(prompt.includes('confidence'));
    assert.ok(prompt.includes('confirm'));
    assert.ok(prompt.includes('override'));
    assert.ok(prompt.includes('fill-in'));
  });

  it('buildPatronPrompt notes absence of primer recommendation', () => {
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

  it('parseEmission drops override verdict lacking a primer recommendation', () => {
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

  it('encodes narrow abstention — reserved for irresolvable principle conflict and broken decision frame only', () => {
    const prompt = oneLine(buildPatronPrompt(sampleDecisions));
    assert.match(prompt, /abstain/i, 'prompt must name the abstain mode');
    assert.match(
      prompt,
      /(leaving|leave) (it|the decision) out of (your|the) emission array entirely/i,
      'prompt must instruct omission as the abstain mechanism',
    );
    // The two — and only two — case names must appear verbatim in the prompt.
    assert.match(
      prompt,
      /irresolvable principle conflict/i,
      'prompt must name the "irresolvable principle conflict" abstention case verbatim',
    );
    assert.match(
      prompt,
      /broken decision frame/i,
      'prompt must name the "broken decision frame" abstention case verbatim',
    );
    // Placeholder verdicts still forbidden as a substitute for narrow abstention.
    assert.match(
      prompt,
      /do not emit a placeholder verdict/i,
      'prompt must forbid placeholder verdicts as abstain substitutes',
    );
    // And the old "low = abstain" framing must not reappear.
    assert.doesNotMatch(
      prompt,
      /`?low`? (means|is|calibration means|=) abstain/i,
      'prompt must not carry the old "low means abstain" framing',
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
      /do not second-guess the primer/i,
      'prompt must forbid re-doing the primer\'s framing work',
    );
  });

  it('calibrates confidence structurally — one principle fires = high, multiple conflict = med, none speaks = low-confirm', () => {
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
      /`med`.{0,200}(multiple|more than one) principles? speak.{0,100}conflict/i,
      'med calibration must be: multiple principles conflict',
    );
    // `low` is a first-class emission path — principle-absence means
    // "confirm the primer at low," not "abstain."
    assert.match(
      prompt,
      /`low`.{0,200}no principle speaks/i,
      'low calibration description must be: no principle speaks',
    );
    assert.match(
      prompt,
      /(confirm the primer|confirming the primer).{0,200}(low|with `low`)/i,
      'low calibration must describe confirming the primer (first-class low-confirm path)',
    );
  });

  it('output-contract example spans all three verdicts plus a first-class low-confirm entry', () => {
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
    // Sanity: the example array must parse as exactly four entries — three
    // verdicts plus a first-class low-confirm (D13).
    const parsed = JSON.parse(exampleBlock) as Array<{ verdict: string; confidence: string }>;
    assert.equal(parsed.length, 4,
      'example emission array must have exactly four entries: confirm-high, override-high, fill-in-med, confirm-low');
    // And one of those must be a low-confidence confirm — the first-class
    // principle-absence path (D5).
    const lowConfirm = parsed.find(e => e.verdict === 'confirm' && e.confidence === 'low');
    assert.ok(lowConfirm,
      'example must include a low-confidence confirm entry — first-class principle-absence path');
  });

  it('output-contract example demonstrates narrow abstention with five named ids and exactly one absent', () => {
    const prompt = buildPatronPrompt(sampleDecisions);
    const flat = oneLine(prompt);
    const fenceMatch = /```json\n([\s\S]+?)\n```/g.exec(prompt);
    assert.ok(fenceMatch);
    const exampleBlock = fenceMatch[1];
    const parsed = JSON.parse(exampleBlock) as Array<{ id: string }>;
    const exampleIds = parsed.map(e => e.id);
    // The example prose names five decisions (EX-1 through EX-5); exactly
    // one is abstained (D13: five ids, four emitted verdicts, one absent).
    const namedIds = ['EX-1', 'EX-2', 'EX-3', 'EX-4', 'EX-5'];
    for (const id of namedIds) {
      assert.match(prompt, new RegExp(id), `example prose should reference ${id} explicitly`);
    }
    const missingFromArray = namedIds.filter(id => !exampleIds.includes(id));
    assert.equal(
      missingFromArray.length,
      1,
      'exactly one of the five example decisions must be absent from the emission array (the narrow-abstention case)',
    );
    // And the prose must point at that absence as the abstain signal.
    assert.match(
      flat,
      new RegExp(`${missingFromArray[0]}.{0,80}absent`, 'i'),
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
    // Normalise whitespace so the regex works across the file's hard-wrapped
    // line breaks.
    const mdOneLine = md.replace(/\s+/g, ' ');
    assert.match(
      mdOneLine,
      /(leaving|leave) (it|the decision) out of (your|the) emission array entirely/i,
      'narrow-abstention omission language must live in the markdown file',
    );
    assert.match(
      md,
      /out of lane/i,
      'out-of-lane section heading must live in the markdown file',
    );
    assert.match(
      md,
      /irresolvable principle conflict/i,
      'the narrow-abstention case name must live in the markdown file verbatim',
    );
    assert.match(
      md,
      /broken decision frame/i,
      'the narrow-abstention case name must live in the markdown file verbatim',
    );

    const engineSrc = readFileSync(resolve(pkgRoot, 'src/engines/patron-anima.ts'), 'utf-8');
    assert.doesNotMatch(
      engineSrc,
      /(leaving|leave) (it|the decision) out of (your|the) emission array entirely/i,
      'narrow-abstention prose must not be embedded inline in patron-anima.ts',
    );
  });
});
