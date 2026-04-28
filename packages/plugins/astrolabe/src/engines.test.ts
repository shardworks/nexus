/**
 * Astrolabe engine tests.
 *
 * Tests plan-init, inventory-check, and decision-review engines using
 * an in-memory Stacks backend and a minimal fake guild.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '@shardworks/spider-apparatus';

import {
  createPlanInitEngine,
  createInventoryCheckEngine,
  createDecisionReviewEngine,
  createObservationLiftEngine,
} from './engines/index.ts';
import type { PlanDoc, Decision, ScopeItem, Observation } from './types.ts';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

// ── Test harness ─────────────────────────────────────────────────────

let stacks: StacksApi;
let plansBook: Book<PlanDoc>;
let inputRequestsBook: Book<InputRequestDoc>;
let memBackend: MemoryBackend;

// Mutable clerk overrides — tests can swap these out per-scenario
let mockClerkPost: (params: unknown) => Promise<{ id: string; title: string }> =
  async () => { throw new Error('clerk.post not implemented'); };
let mockClerkLink: (
  sourceId: string,
  targetId: string,
  label: string,
  kind?: string,
) => Promise<unknown> =
  async () => ({});
// Records every call to `clerk.link` so tests can assert on the full
// 4-tuple — including the optional `kind` argument that the previous
// 3-arg shim rendered unobservable.
const mockClerkLinkCalls: Array<{
  sourceId: string;
  targetId: string;
  label: string;
  kind: string | undefined;
}> = [];
let mockClerkTransition: (id: string, to: string, fields?: unknown) => Promise<{ id: string }> =
  async () => { throw new Error('clerk.transition not implemented'); };

const mockClerkApi = {
  show: async (id: string) => ({
    id,
    type: 'mandate',
    status: 'open' as const,
    title: `Mandate for ${id}`,
    body: 'Body',
    codex: 'test-codex',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  post: async (params: unknown) => mockClerkPost(params),
  list: async () => [],
  count: async () => 0,
  link: async (
    sourceId: string,
    targetId: string,
    label: string,
    kind?: string,
  ) => {
    mockClerkLinkCalls.push({ sourceId, targetId, label, kind });
    return mockClerkLink(sourceId, targetId, label, kind);
  },
  links: async () => ({ outbound: [], inbound: [] }),
  unlink: async () => {},
  transition: async (id: string, to: string, fields?: unknown) =>
    mockClerkTransition(id, to, fields),
};

function buildCtx(overrides: Partial<EngineRunContext> = {}): EngineRunContext {
  return {
    rigId: 'rig-test-001',
    engineId: 'decision-review',
    upstream: {},
    ...overrides,
  };
}

function buildStartupCtx(): StartupContext {
  return {
    on() {},
    kits() { return []; },
  };
}

function setup() {
  memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    settings: { model: 'sonnet' },
  };

  const fakeGuild: Guild = {
    home: '/tmp/fake-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
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

  // Start stacks
  const stacksApparatus = (stacksPlugin as {
    apparatus: { start: (ctx: StartupContext) => void; provides: unknown };
  }).apparatus;
  stacksApparatus.start(buildStartupCtx());
  stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Ensure books exist
  memBackend.ensureBook({ ownerId: 'astrolabe', book: 'plans' }, {
    indexes: ['status', 'codex', 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['rigId', 'engineId', 'status'],
  });

  plansBook = stacks.book<PlanDoc>('astrolabe', 'plans');
  inputRequestsBook = stacks.book<InputRequestDoc>('spider', 'input-requests');

  // Register mock clerk
  apparatusMap.set('clerk', mockClerkApi);

  // Reset call recorders so each test sees a clean slate.
  mockClerkLinkCalls.length = 0;
  // Default link mock no-ops; tests that need a specific behaviour
  // (e.g. injected failures) override `mockClerkLink` directly.
  mockClerkLink = async () => ({});
}

function makePlan(overrides: Partial<PlanDoc> = {}): PlanDoc {
  const now = new Date().toISOString();
  return {
    id: 'w-test-001',
    codex: 'test-codex',
    status: 'reading',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── plan-init tests ───────────────────────────────────────────────────

describe('plan-init engine', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { clearGuild(); });

  it('creates a PlanDoc with status reading and yields planId', async () => {
    const engine = createPlanInitEngine(() => plansBook);
    const writ = { id: 'w-abc', codex: 'my-codex', type: 'mandate', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

    const result = await engine.run({ writ }, buildCtx());

    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, { planId: 'w-abc' });

    const plan = await plansBook.get('w-abc');
    assert.ok(plan);
    assert.equal(plan.codex, 'my-codex');
    assert.equal(plan.status, 'reading');
    assert.ok(plan.createdAt);
    assert.ok(plan.updatedAt);
  });

  it('throws when writ has no codex', async () => {
    const engine = createPlanInitEngine(() => plansBook);
    const writ = { id: 'w-abc', codex: undefined, type: 'mandate', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

    await assert.rejects(
      () => engine.run({ writ }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('no codex'));
        return true;
      },
    );
  });

  it('throws when writ codex is empty string', async () => {
    const engine = createPlanInitEngine(() => plansBook);
    const writ = { id: 'w-abc', codex: '   ', type: 'mandate', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

    await assert.rejects(
      () => engine.run({ writ }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('no codex'));
        return true;
      },
    );
  });

  it('throws when a plan already exists for the writ', async () => {
    const engine = createPlanInitEngine(() => plansBook);
    const writ = { id: 'w-dup', codex: 'codex-a', type: 'mandate', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

    await engine.run({ writ }, buildCtx());

    await assert.rejects(
      () => engine.run({ writ }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('already exists'));
        return true;
      },
    );
  });
});

// ── inventory-check tests ─────────────────────────────────────────────

describe('inventory-check engine', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { clearGuild(); });

  it('completes when plan has a non-empty inventory and transitions status to analyzing', async () => {
    const engine = createInventoryCheckEngine(() => plansBook);
    const plan = makePlan({ inventory: 'src/app.ts — main entry point' });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, {});

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'analyzing');
  });

  it('throws when plan has no inventory field', async () => {
    const engine = createInventoryCheckEngine(() => plansBook);
    const plan = makePlan();
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('no inventory'));
        return true;
      },
    );
  });

  it('throws when plan inventory is empty string', async () => {
    const engine = createInventoryCheckEngine(() => plansBook);
    const plan = makePlan({ inventory: '' });
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('no inventory'));
        return true;
      },
    );
  });

  it('throws when plan not found', async () => {
    const engine = createInventoryCheckEngine(() => plansBook);

    await assert.rejects(
      () => engine.run({ planId: 'nonexistent' }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('not found'));
        return true;
      },
    );
  });
});

// ── decision-review tests ─────────────────────────────────────────────

describe('decision-review engine', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { clearGuild(); });

  it('completes immediately when plan has no decisions and no scope', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const plan = makePlan({ status: 'analyzing', decisions: [], scope: [] });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, { decisionSummary: '' });

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'writing');
  });

  it('completes immediately when plan has no decisions and no scope (undefined fields)', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const plan = makePlan({ status: 'analyzing' });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'writing');
  });

  it('blocks on first run with decisions and scope items', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: ['S1'],
        question: 'Which pattern?',
        options: { A: 'Strategy pattern', B: 'Observer pattern' },
        recommendation: 'A',
        rationale: 'Simpler',
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Refactor module X', rationale: 'Needed', included: true },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'blocked');
    const blocked = result as { status: 'blocked'; blockType: string; condition: unknown };
    assert.equal(blocked.blockType, 'patron-input');
    assert.ok((blocked.condition as { requestId: string }).requestId);

    // Plan should be in 'reviewing' status
    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'reviewing');

    // InputRequestDoc should exist
    const requestId = (blocked.condition as { requestId: string }).requestId;
    const inputReq = await inputRequestsBook.get(requestId);
    assert.ok(inputReq);
    assert.equal(inputReq.status, 'pending');
    assert.ok(inputReq.questions['D1']);
    assert.ok(inputReq.questions['scope:S1']);
    // Pre-filled answer for recommendation
    assert.deepEqual(inputReq.answers['D1'], { selected: 'A' });
    // Pre-filled scope inclusion
    assert.equal(inputReq.answers['scope:S1'], true);
  });

  it('pre-fills answers for decisions with recommendations and scope items', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q1?',
        options: { A: 'A', B: 'B' },
        recommendation: 'B',
      },
      {
        id: 'D2',
        scope: [],
        question: 'Q2?',
        options: { X: 'X', Y: 'Y' },
        // no recommendation
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Item 1', rationale: 'R', included: false },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'blocked');
    const blocked = result as { status: 'blocked'; blockType: string; condition: { requestId: string } };

    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    assert.ok(inputReq);
    assert.deepEqual(inputReq.answers['D1'], { selected: 'B' });
    assert.equal(inputReq.answers['D2'], undefined);
    assert.equal(inputReq.answers['scope:S1'], false);
  });

  it('reconciles selected answer back to decision on re-run', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
        recommendation: 'A',
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Include thing', rationale: 'Because', included: true },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    // First run
    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(firstResult.status, 'blocked');
    const blocked = firstResult as { status: 'blocked'; blockType: string; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron answers: override D1 to B, scope S1 stays true
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: {
        D1: { selected: 'B' },
        'scope:S1': false,
      },
      updatedAt: new Date().toISOString(),
    });

    // Re-run
    const reRunCtx = buildCtx({
      priorBlock: {
        type: 'patron-input',
        condition: { requestId },
        blockedAt: new Date().toISOString(),
      },
    });
    const secondResult = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(secondResult.status, 'completed');

    const yields = (secondResult as { status: 'completed'; yields: { decisionSummary: string } }).yields;
    assert.ok(typeof yields.decisionSummary === 'string');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.status, 'writing');
    assert.equal(finalPlan?.decisions?.[0].selected, 'B');
    assert.equal(finalPlan?.scope?.[0].included, false);
  });

  it('reconciles patron override (custom answer) on re-run', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    // First run
    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron provides a custom answer
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { custom: 'We will use a completely different approach' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const secondResult = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(secondResult.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.decisions?.[0].patronOverride, 'We will use a completely different approach');
    assert.equal(finalPlan?.decisions?.[0].selected, undefined);
  });

  it('builds decisionSummary markdown on re-run', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which pattern?',
        options: { A: 'Strategy', B: 'Observer' },
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Feature X', rationale: 'R', included: true },
      { id: 'S2', description: 'Feature Y', rationale: 'R', included: false },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'A' }, 'scope:S1': true, 'scope:S2': false },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const secondResult = await engine.run({ planId: plan.id }, reRunCtx);
    const { decisionSummary } = (secondResult as { status: 'completed'; yields: { decisionSummary: string } }).yields;

    assert.ok(decisionSummary.includes('## Decisions'));
    assert.ok(decisionSummary.includes('D1'));
    assert.ok(decisionSummary.includes('Strategy'));
    assert.ok(decisionSummary.includes('## Scope'));
    assert.ok(decisionSummary.includes('[x] S1'));
    assert.ok(decisionSummary.includes('[ ] S2'));
  });

  it('composeDetails — both context and rationale', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A' },
        context: 'Some context',
        rationale: 'Some rationale',
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { details?: string };
    assert.ok(q?.details?.includes('Some context'));
    assert.ok(q?.details?.includes('Some rationale'));
    assert.ok(q?.details?.includes('Recommendation rationale:'));
  });

  it('composeDetails — only context', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A' },
        context: 'Only context',
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { details?: string };
    assert.equal(q?.details, 'Only context');
  });

  it('composeDetails — neither context nor rationale gives undefined details', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { details?: string };
    assert.equal(q?.details, undefined);
  });

  it('throws when a decision has no selected or patronOverride after re-run', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'First question?',
        options: { A: 'Option A', B: 'Option B' },
      },
      {
        id: 'D2',
        scope: [],
        question: 'Second question?',
        options: { X: 'Option X', Y: 'Option Y' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    // First run — creates InputRequestDoc
    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Only D1 gets an answer; D2 has no answer
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'A' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });

    await assert.rejects(
      () => engine.run({ planId: plan.id }, reRunCtx),
      (err: Error) => {
        assert.ok(
          err.message.includes('inconsistent state') && err.message.includes('D2'),
          `Expected inconsistent state message about D2, got: ${err.message}`,
        );
        return true;
      },
    );

    // PlanDoc must still be in 'reviewing' status — not patched to 'writing'
    const notPatched = await plansBook.get(plan.id);
    assert.equal(notPatched?.status, 'reviewing');
  });

  it('throws listing all unresolved decisions when multiple are unresolved', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q1?', options: { A: 'A', B: 'B' } },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'X', Y: 'Y' } },
      { id: 'D3', scope: [], question: 'Q3?', options: { P: 'P', Q: 'Q' } },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Only D2 gets an answer; D1 and D3 are unresolved
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D2: { selected: 'X' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });

    await assert.rejects(
      () => engine.run({ planId: plan.id }, reRunCtx),
      (err: Error) => {
        assert.ok(
          err.message.includes('inconsistent state') && err.message.includes('D1') && err.message.includes('D3'),
          `Expected D1 and D3 in message, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('patronOverride satisfies validation — does not throw', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q?', options: { A: 'A', B: 'B' } },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron provides a custom (override) answer
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { custom: 'A custom override' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });

    const result = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(result.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.decisions?.[0].patronOverride, 'A custom override');
    assert.equal(finalPlan?.decisions?.[0].selected, undefined);
  });
  // ── Invariant enforcement tests ──────────────────────────────────────

  it('custom override leaves selected absent (regression: dual-state bug)', async () => {
    // Under the razor semantics an primer-set `selected` means the decision
    // is auto-accepted and never appears in the InputRequestDoc — so the
    // "stale pre-fill" scenario from the original regression can no longer
    // occur. What still matters is the reconcile branch that ensures
    // `selected` is absent (not just undefined) after a custom override
    // answer — this test guards that invariant-preserving `delete`.
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
        recommendation: 'A',
        // no `selected` — reviewable decision (per razor: left unset so the
        // patron can weigh in).
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    // First run
    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron provides a custom override
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { custom: 'Use twoPhaseRigTemplate and threePhaseRigTemplate' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const result = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(result.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.decisions?.[0].patronOverride, 'Use twoPhaseRigTemplate and threePhaseRigTemplate');
    assert.equal(finalPlan?.decisions?.[0].selected, undefined);
    // Verify the field is absent, not just undefined — protects the invariant
    // that exactly one of { selected, patronOverride } is set.
    assert.equal('selected' in (finalPlan?.decisions?.[0] ?? {}), false);
  });

  it('selected answer clears stale patronOverride', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
        patronOverride: 'stale custom text', // stale override from prior run
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron picks a listed option
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'B' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const result = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(result.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.decisions?.[0].selected, 'B');
    assert.equal(finalPlan?.decisions?.[0].patronOverride, undefined);
    assert.equal('patronOverride' in (finalPlan?.decisions?.[0] ?? {}), false);
  });

  it('patron picks a different listed option — selected updated, no patronOverride', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
        recommendation: 'A',
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Patron picks B instead of recommended A
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'B' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const result = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(result.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.decisions?.[0].selected, 'B');
    assert.equal(finalPlan?.decisions?.[0].patronOverride, undefined);
  });

  it('invariant violation throws — both selected and patronOverride set', async () => {
    // This test simulates a scenario where a decision somehow ends up
    // with both fields after reconcile (shouldn't happen with correct code,
    // but the validation catches it if it does).
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q?',
        options: { A: 'A' },
        // Both set — violates invariant
        selected: 'A',
        patronOverride: 'custom text',
      },
      {
        id: 'D2',
        scope: [],
        question: 'Q2?',
        options: { X: 'X' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Only answer D2 — D1 retains both fields since no answer overwrites it
    // But wait: D1 already has both, and no answer for D1 means it keeps both
    // Actually the filter checks (selected !== undefined) === (patronOverride !== undefined)
    // D1: selected='A', patronOverride='custom text' → true === true → true → inconsistent ✓
    // D2: answer { selected: 'X' } → selected='X', patronOverride=undefined → true === false → false → ok
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D2: { selected: 'X' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });

    await assert.rejects(
      () => engine.run({ planId: plan.id }, reRunCtx),
      (err: Error) => {
        assert.ok(
          err.message.includes('inconsistent state') && err.message.includes('D1'),
          `Expected inconsistent state error for D1, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('invariant violation throws — neither selected nor patronOverride set', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      { id: 'D1', scope: [], question: 'Q1?', options: { A: 'A' } },
      { id: 'D2', scope: [], question: 'Q2?', options: { X: 'X' } },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // Only answer D1 — D2 has neither field
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'A' } },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });

    await assert.rejects(
      () => engine.run({ planId: plan.id }, reRunCtx),
      (err: Error) => {
        assert.ok(
          err.message.includes('inconsistent state') && err.message.includes('D2'),
          `Expected inconsistent state error for D2, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('buildDecisionSummary emits one line per decision — selected-only and patronOverride-only', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Pattern?',
        options: { A: 'Strategy', B: 'Observer' },
      },
      {
        id: 'D2',
        scope: [],
        question: 'Naming?',
        options: { X: 'camelCase', Y: 'snake_case' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    // D1: selected, D2: custom override
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: {
        D1: { selected: 'A' },
        D2: { custom: 'Use PascalCase for all identifiers' },
      },
      updatedAt: new Date().toISOString(),
    });

    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const result = await engine.run({ planId: plan.id }, reRunCtx);
    const { decisionSummary } = (result as { status: 'completed'; yields: { decisionSummary: string } }).yields;

    // D1 should have Selected line, not Patron override
    assert.ok(decisionSummary.includes('**Selected:** Strategy'));
    assert.ok(!decisionSummary.includes('**Patron override:** Strategy'));

    // D2 should have Patron override line, not Selected
    assert.ok(decisionSummary.includes('**Patron override:** Use PascalCase for all identifiers'));
    // Should NOT have a Selected line for D2
    const d2Section = decisionSummary.split('D2:')[1];
    assert.ok(!d2Section.includes('**Selected:**'));
  });

  it('surfaced ChoiceQuestionSpec has no tags property', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Which approach?',
        options: { A: 'Option A', B: 'Option B' },
        recommendation: 'A',
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as Record<string, unknown>;
    assert.equal('tags' in q, false);
  });

  // ── Analyst pre-decision / fast-path tests (razor + three defaults) ─

  it('fast-path: all decisions pre-decided with no scope — skips gate', async () => {
    // D10(a): when the primer has pre-filled `selected` on every decision
    // and there are no scope items, the engine must skip the patron-review
    // gate entirely and transition straight to 'writing'.
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Q1?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
        selected: 'A', // primer pre-decided
      },
      {
        id: 'D2',
        scope: [],
        question: 'Q2?',
        options: { X: 'X', Y: 'Y' },
        recommendation: 'Y',
        selected: 'Y', // primer pre-decided
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope: [] });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, { decisionSummary: '' });

    // Plan transitions straight to 'writing' — no 'reviewing' stop
    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'writing');

    // Analyst pre-fills are preserved on the plan
    assert.equal(updated?.decisions?.[0].selected, 'A');
    assert.equal(updated?.decisions?.[1].selected, 'Y');

    // No InputRequestDoc was created
    const reqs = await inputRequestsBook.find({
      where: [['rigId', '=', 'rig-test-001'], ['engineId', '=', 'decision-review']],
      limit: 10,
    });
    assert.equal(reqs.length, 0);
  });

  it('mixed: pre-decided decisions excluded, reviewable + scope surfaced', async () => {
    // D10(b): only reviewable decisions (selected === undefined) populate the
    // InputRequestDoc; pre-decided decisions are skipped entirely (no question,
    // no answer). Scope items populate as before.
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: ['S1'],
        question: 'Reviewable?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
        // no `selected` — reviewable
      },
      {
        id: 'D2',
        scope: ['S1'],
        question: 'Pre-decided?',
        options: { X: 'X', Y: 'Y' },
        recommendation: 'X',
        selected: 'X', // primer pre-decided — should NOT appear in InputRequestDoc
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Scope item', rationale: 'Reason', included: true },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'blocked');
    const blocked = result as { status: 'blocked'; blockType: string; condition: { requestId: string } };

    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    assert.ok(inputReq);

    // D1 (reviewable) is present; D2 (pre-decided) is absent entirely
    assert.ok('D1' in inputReq.questions);
    assert.equal('D2' in inputReq.questions, false);
    assert.deepEqual(inputReq.answers['D1'], { selected: 'A' });
    assert.equal('D2' in inputReq.answers, false);

    // Scope still surfaces
    assert.ok('scope:S1' in inputReq.questions);
    assert.equal(inputReq.answers['scope:S1'], true);
  });

  it('fast-path: pre-decided only with scope — scope auto-accepted, no gate', async () => {
    // D10(c) with D6 consistency: fast-path is scope-agnostic. When every
    // decision is pre-decided — even if scope items exist — the engine
    // skips the patron-review gate; scope items' existing `included`
    // flags are implicitly accepted.
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: ['S1'],
        question: 'All pre-decided?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
        selected: 'A',
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'In-scope item', rationale: 'R', included: true },
      { id: 'S2', description: 'Out-of-scope item', rationale: 'R', included: false },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());

    // Fast-path: plan transitions directly to 'writing', no block emitted
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, { decisionSummary: '' });

    const updated = await plansBook.get(plan.id);
    assert.equal(updated?.status, 'writing');
    assert.equal(updated?.decisions?.[0].selected, 'A');
    // Scope inclusion flags are preserved exactly as the primer set them
    assert.equal(updated?.scope?.[0].included, true);
    assert.equal(updated?.scope?.[1].included, false);

    // No InputRequestDoc was created
    const reqs = await inputRequestsBook.find({
      where: [['rigId', '=', 'rig-test-001'], ['engineId', '=', 'decision-review']],
      limit: 10,
    });
    assert.equal(reqs.length, 0);
  });

  it('reconcile preserves primer-set `selected` through the round trip', async () => {
    // D10(d): a mixed plan goes through first-pass (reviewable + pre-decided)
    // and reconcile; the pre-decided decision's primer-set `selected`
    // must survive reconcile untouched, while the reviewable decision's
    // patron answer lands correctly. The invariant check must pass.
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Reviewable?',
        options: { A: 'A', B: 'B' },
        recommendation: 'A',
        // no `selected` — reviewable
      },
      {
        id: 'D2',
        scope: [],
        question: 'Pre-decided?',
        options: { X: 'X', Y: 'Y' },
        recommendation: 'X',
        selected: 'X', // primer pre-decided
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    // First run — blocks on D1 only; D2 is not in the InputRequestDoc
    const firstResult = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(firstResult.status, 'blocked');
    const blocked = firstResult as { status: 'blocked'; condition: { requestId: string } };
    const requestId = blocked.condition.requestId;

    const inputReq = await inputRequestsBook.get(requestId);
    assert.ok(inputReq);
    assert.ok('D1' in inputReq.questions);
    assert.equal('D2' in inputReq.questions, false);

    // Patron answers D1 (overriding the recommendation)
    await inputRequestsBook.patch(requestId, {
      status: 'completed',
      answers: { D1: { selected: 'B' } },
      updatedAt: new Date().toISOString(),
    });

    // Re-run — reconcile must not throw the invariant error for D2
    const reRunCtx = buildCtx({
      priorBlock: { type: 'patron-input', condition: { requestId }, blockedAt: new Date().toISOString() },
    });
    const secondResult = await engine.run({ planId: plan.id }, reRunCtx);
    assert.equal(secondResult.status, 'completed');

    const finalPlan = await plansBook.get(plan.id);
    assert.equal(finalPlan?.status, 'writing');
    // D1: patron's selected answer landed
    assert.equal(finalPlan?.decisions?.[0].selected, 'B');
    assert.equal(finalPlan?.decisions?.[0].patronOverride, undefined);
    // D2: primer-set `selected` preserved unchanged
    assert.equal(finalPlan?.decisions?.[1].selected, 'X');
    assert.equal(finalPlan?.decisions?.[1].patronOverride, undefined);

    // The decisionSummary yields both entries identically (no auto vs. confirmed marker)
    const { decisionSummary } = (secondResult as { status: 'completed'; yields: { decisionSummary: string } }).yields;
    assert.ok(decisionSummary.includes('D1'));
    assert.ok(decisionSummary.includes('D2'));
    assert.ok(decisionSummary.includes('**Selected:** X'));
  });

});

// ── observation-lift tests ────────────────────────────────────────────

describe('observation-lift engine', () => {
  beforeEach(() => {
    setup();
    // Default: no-op post that each test overrides as needed.
    mockClerkPost = async () => ({ id: 'writ-default', title: 'default' });
  });
  afterEach(() => { clearGuild(); });

  it('has id astrolabe.observation-lift and a run function', () => {
    const engine = createObservationLiftEngine(() => plansBook);
    assert.equal(engine.id, 'astrolabe.observation-lift');
    assert.equal(typeof engine.run, 'function');
  });

  it('throws when the plan does not exist', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    await assert.rejects(
      () => engine.run({ planId: 'no-such-plan' }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('not found'));
        return true;
      },
    );
  });

  it('throws when plan status is not completed', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const obs: Observation[] = [{ id: 'obs-1', title: 'T', body: 'B' }];
    const plan = makePlan({ status: 'writing', observations: obs });
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(
          err.message.includes('completed'),
          `Expected "completed" in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('no-ops with empty writIds when observations field is undefined', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const plan = makePlan({ status: 'completed' });
    await plansBook.put(plan);

    const postCalls: unknown[] = [];
    mockClerkPost = async (params) => {
      postCalls.push(params);
      return { id: 'should-not-be-called', title: 'x' };
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      (result as { status: 'completed'; yields: { writIds: string[] } }).yields,
      { writIds: [] },
    );
    assert.equal(postCalls.length, 0);
    assert.equal(mockClerkLinkCalls.length, 0);
  });

  it('no-ops with empty writIds when observations is an empty array', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const plan = makePlan({ status: 'completed', observations: [] });
    await plansBook.put(plan);

    const postCalls: unknown[] = [];
    mockClerkPost = async (params) => {
      postCalls.push(params);
      return { id: 'should-not-be-called', title: 'x' };
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      (result as { status: 'completed'; yields: { writIds: string[] } }).yields,
      { writIds: [] },
    );
    assert.equal(postCalls.length, 0);
    assert.equal(mockClerkLinkCalls.length, 0);
  });

  it('silently skips a legacy string-shaped observations payload', async () => {
    // D15: pre-existing plandocs carry `observations` as a prose string;
    // the engine must not explode — it treats a non-array as empty.
    const engine = createObservationLiftEngine(() => plansBook);
    const plan = makePlan({
      status: 'completed',
      // Intentionally bypass the typed shape to simulate legacy data.
      observations: '## Risks\n- stale prose' as unknown as Observation[],
    });
    await plansBook.put(plan);

    const postCalls: unknown[] = [];
    mockClerkPost = async (params) => {
      postCalls.push(params);
      return { id: 'should-not-be-called', title: 'x' };
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual(
      (result as { status: 'completed'; yields: { writIds: string[] } }).yields,
      { writIds: [] },
    );
    assert.equal(postCalls.length, 0);
    assert.equal(mockClerkLinkCalls.length, 0);
  });

  // ── Flat mode: exactly one observation ─────────────────────────────

  it('flat mode — single observation posts one top-level draft mandate with both lifted-from and spider.follows edges', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      {
        id: 'obs-1',
        title: 'Replace deprecated helper in src/foo.ts',
        body: '`renderLegacy` in `src/foo.ts` is superseded by `renderCard`.',
      },
    ];

    const plan = makePlan({
      id: 'w-mandate-flat',
      codex: 'my-codex',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    // Track post / link interleaving so we can assert call ordering.
    const callLog: Array<{ kind: 'post' | 'link'; arg: unknown }> = [];

    const postCalls: Array<Record<string, unknown>> = [];
    let counter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      counter += 1;
      callLog.push({ kind: 'post', arg: p });
      return { id: `w-obs-flat-${counter}`, title: p.title as string };
    };
    mockClerkLink = async (sourceId, targetId, label, kind) => {
      callLog.push({ kind: 'link', arg: { sourceId, targetId, label, kind } });
      return {};
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    const yields = (result as { status: 'completed'; yields: { writIds: string[] } }).yields;
    assert.deepEqual(yields.writIds, ['w-obs-flat-1']);

    // Exactly one post — a top-level draft mandate (no parentId).
    assert.equal(postCalls.length, 1);
    const call = postCalls[0];
    assert.equal(call.type, 'mandate');
    assert.equal(call.title, observations[0].title);
    assert.equal(call.body, observations[0].body);
    assert.equal(call.codex, 'my-codex');
    // The engine no longer threads `draft` — `PostCommissionRequest.draft`
    // was removed; posted mandates land in their type's declared initial
    // state (`new`) by default, which is the draft slot for mandate.
    assert.equal('draft' in call, false, 'engine must not pass the removed `draft` field');
    assert.equal('parentId' in call, false, 'flat-mode writ must be top-level (no parentId)');

    // Two outbound edges, both from the new draft to the originating mandate:
    //   1. astrolabe.lifted-from (provenance)
    //   2. spider.follows       (precedence gate)
    assert.equal(mockClerkLinkCalls.length, 2);

    const liftedLink = mockClerkLinkCalls.find((l) => l.kind === 'astrolabe.lifted-from');
    assert.ok(liftedLink, 'must emit an astrolabe.lifted-from edge');
    assert.equal(liftedLink.sourceId, 'w-obs-flat-1');
    assert.equal(liftedLink.targetId, 'w-mandate-flat');
    assert.equal(liftedLink.label, 'lifted from');

    const followsLink = mockClerkLinkCalls.find((l) => l.kind === 'spider.follows');
    assert.ok(followsLink, 'must emit a spider.follows edge');
    assert.equal(followsLink.sourceId, 'w-obs-flat-1');
    assert.equal(followsLink.targetId, 'w-mandate-flat');
    assert.equal(followsLink.label, 'depends on');

    // Call ordering: post comes first, then the two links after it.
    assert.deepEqual(
      callLog.map((c) => c.kind),
      ['post', 'link', 'link'],
    );

    // The plandoc itself is not mutated — observations array unchanged,
    // no tracking field added.
    const after = await plansBook.get(plan.id);
    assert.deepEqual(after?.observations, observations);
    assert.equal('observationWritIds' in (after ?? {}), false);
  });

  it('flat mode — fails fast on clerk.post error; no link is attempted', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'only — explodes', body: 'b1' },
    ];

    const plan = makePlan({
      id: 'w-mandate-flat-post-fail',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    mockClerkPost = async () => {
      throw new Error('simulated clerk.post failure');
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated clerk.post failure'));
        return true;
      },
    );

    // No links attempted — the post threw before any link call.
    assert.equal(mockClerkLinkCalls.length, 0);
  });

  it('flat mode — fails fast on clerk.link error; post persisted but link failed', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'only — link explodes', body: 'b1' },
    ];

    const plan = makePlan({
      id: 'w-mandate-flat-link-fail',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    let postCounter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCounter += 1;
      return { id: `w-flat-linkfail-${postCounter}`, title: p.title as string };
    };

    mockClerkLink = async () => {
      throw new Error('simulated clerk.link failure');
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated clerk.link failure'));
        return true;
      },
    );

    // The first link attempt (astrolabe.lifted-from) threw — the second
    // (spider.follows) never executed.
    assert.equal(mockClerkLinkCalls.length, 1);
    assert.equal(mockClerkLinkCalls[0].sourceId, 'w-flat-linkfail-1');
    assert.equal(mockClerkLinkCalls[0].targetId, 'w-mandate-flat-link-fail');
    assert.equal(mockClerkLinkCalls[0].kind, 'astrolabe.lifted-from');
  });

  // ── Grouped mode: two or more observations ─────────────────────────

  it('grouped mode — creates an observation-set parent plus N draft mandate children with the correct edges', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      {
        id: 'obs-1',
        title: 'Replace deprecated helper in src/foo.ts',
        body: '`renderLegacy` in `src/foo.ts` is superseded by `renderCard`.',
      },
      {
        id: 'obs-2',
        title: 'Fix typo in plan-finalize error',
        body: 'Message reads "spec writier" instead of "spec writer".',
      },
      {
        id: 'obs-3',
        title: 'Audit stale docs in README',
        body: 'Docs still claim `observations` is a string.',
      },
    ];

    const plan = makePlan({
      id: 'w-mandate-grouped',
      codex: 'my-codex',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const callLog: Array<{ kind: 'post' | 'link'; arg: unknown }> = [];

    const postCalls: Array<Record<string, unknown>> = [];
    let counter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      counter += 1;
      callLog.push({ kind: 'post', arg: p });
      // First post is the group parent, subsequent posts are children.
      const id = counter === 1 ? 'w-obs-group' : `w-obs-child-${counter - 1}`;
      return { id, title: p.title as string };
    };
    mockClerkLink = async (sourceId, targetId, label, kind) => {
      callLog.push({ kind: 'link', arg: { sourceId, targetId, label, kind } });
      return {};
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');

    // yields.writIds is exactly the N child ids in record order — NOT
    // including the group parent id.
    const yields = (result as { status: 'completed'; yields: { writIds: string[] } }).yields;
    assert.deepEqual(yields.writIds, ['w-obs-child-1', 'w-obs-child-2', 'w-obs-child-3']);

    // Four posts total: one group parent + three children.
    assert.equal(postCalls.length, 4);

    // Group parent shape — type observation-set, top-level (no parentId),
    // title embeds the originating mandate title, body lists the child
    // titles with a preamble naming the originating writ.
    const groupPost = postCalls[0];
    assert.equal(groupPost.type, 'observation-set');
    assert.equal(groupPost.codex, 'my-codex');
    // The engine no longer threads `draft` — posts land in the type's
    // declared initial state (`new`) by default.
    assert.equal('draft' in groupPost, false, 'engine must not pass the removed `draft` field');
    assert.equal('parentId' in groupPost, false, 'group parent must be top-level');
    assert.equal(groupPost.title, 'Observations from "Mandate for w-mandate-grouped"');
    const body = groupPost.body as string;
    assert.ok(
      body.includes('Mandate for w-mandate-grouped'),
      'group body preamble must name the originating mandate',
    );
    assert.ok(body.includes('w-mandate-grouped'), 'group body preamble must include originating writ id');
    assert.ok(body.includes(`1. ${observations[0].title}`), 'group body must include numbered child 1');
    assert.ok(body.includes(`2. ${observations[1].title}`), 'group body must include numbered child 2');
    assert.ok(body.includes(`3. ${observations[2].title}`), 'group body must include numbered child 3');

    // Each child post is a draft mandate whose parentId is the group
    // parent's id, with title/body from the matching observation.
    for (let i = 0; i < observations.length; i++) {
      const call = postCalls[i + 1];
      const obs = observations[i];
      assert.equal(call.type, 'mandate');
      assert.equal(call.title, obs.title);
      assert.equal(call.body, obs.body);
      assert.equal(call.codex, 'my-codex');
      assert.equal(call.parentId, 'w-obs-group');
      // The engine no longer threads `draft` — posts land in the type's
      // declared initial state (`new`) by default.
      assert.equal('draft' in call, false, 'engine must not pass the removed `draft` field');
    }

    // Edges: exactly 1 group-parent lifted-from + N child spider.follows
    // (no lifted-from on children, no spider.follows on group parent).
    assert.equal(mockClerkLinkCalls.length, 1 + observations.length);

    const liftedLinks = mockClerkLinkCalls.filter((l) => l.kind === 'astrolabe.lifted-from');
    assert.equal(liftedLinks.length, 1, 'exactly one lifted-from edge (on the group parent)');
    assert.equal(liftedLinks[0].sourceId, 'w-obs-group');
    assert.equal(liftedLinks[0].targetId, 'w-mandate-grouped');
    assert.equal(liftedLinks[0].label, 'lifted from');

    const followsLinks = mockClerkLinkCalls.filter((l) => l.kind === 'spider.follows');
    assert.equal(followsLinks.length, observations.length, 'one spider.follows edge per child');
    for (let i = 0; i < observations.length; i++) {
      const link = followsLinks[i];
      assert.equal(link.sourceId, `w-obs-child-${i + 1}`);
      assert.equal(link.targetId, 'w-mandate-grouped');
      assert.equal(link.label, 'depends on');
    }

    // The group parent must NOT carry a spider.follows edge.
    const groupFollowsEdge = mockClerkLinkCalls.find(
      (l) => l.kind === 'spider.follows' && l.sourceId === 'w-obs-group',
    );
    assert.equal(groupFollowsEdge, undefined, 'group parent must not carry spider.follows');

    // Children must NOT carry astrolabe.lifted-from edges.
    const childLiftedEdge = mockClerkLinkCalls.find(
      (l) => l.kind === 'astrolabe.lifted-from' && l.sourceId.startsWith('w-obs-child-'),
    );
    assert.equal(childLiftedEdge, undefined, 'children must not carry lifted-from');

    // Call ordering: group post → group lifted-from link → then per
    // record: child post → child spider.follows link.
    assert.deepEqual(
      callLog.map((c) => c.kind),
      ['post', 'link', 'post', 'link', 'post', 'link', 'post', 'link'],
    );

    // The plandoc itself is not mutated.
    const after = await plansBook.get(plan.id);
    assert.deepEqual(after?.observations, observations);
    assert.equal('observationWritIds' in (after ?? {}), false);
  });

  it('grouped mode — threshold is 2: two observations produce a grouped output', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'first', body: 'b1' },
      { id: 'obs-2', title: 'second', body: 'b2' },
    ];

    const plan = makePlan({
      id: 'w-mandate-two',
      codex: 'c',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const postCalls: Array<Record<string, unknown>> = [];
    let counter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      counter += 1;
      const id = counter === 1 ? 'w-obs-group-2' : `w-obs-child-2-${counter - 1}`;
      return { id, title: p.title as string };
    };

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');

    // Exactly two observations → grouped output (threshold is 2).
    assert.equal(postCalls.length, 3, 'group parent + 2 children');
    assert.equal(postCalls[0].type, 'observation-set');
    assert.equal(postCalls[1].type, 'mandate');
    assert.equal(postCalls[1].parentId, 'w-obs-group-2');
    assert.equal(postCalls[2].type, 'mandate');
    assert.equal(postCalls[2].parentId, 'w-obs-group-2');

    // yields.writIds is only the child ids.
    const yields = (result as { status: 'completed'; yields: { writIds: string[] } }).yields;
    assert.deepEqual(yields.writIds, ['w-obs-child-2-1', 'w-obs-child-2-2']);
  });

  it('grouped mode — fails fast on group-parent clerk.post error before any child post or link', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'first', body: 'b1' },
      { id: 'obs-2', title: 'second', body: 'b2' },
    ];

    const plan = makePlan({
      id: 'w-mandate-group-post-fail',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const postCalls: Array<Record<string, unknown>> = [];
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      // First post is the group parent — fail it.
      throw new Error('simulated group-parent post failure');
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated group-parent post failure'));
        return true;
      },
    );

    // Exactly one post attempted — the group parent — and no link
    // attempts; children never ran.
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].type, 'observation-set');
    assert.equal(mockClerkLinkCalls.length, 0);
  });

  it('grouped mode — fails fast on child clerk.post error; coherent prefix persists', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'first', body: 'b1' },
      { id: 'obs-2', title: 'second — explodes', body: 'b2' },
      { id: 'obs-3', title: 'third — never reached', body: 'b3' },
    ];

    const plan = makePlan({
      id: 'w-mandate-grouped-child-fail',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const postCalls: Array<Record<string, unknown>> = [];
    let counter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      counter += 1;
      // Order: 1 = group parent, 2 = child1 (ok), 3 = child2 (fail).
      if (counter === 3) {
        throw new Error('simulated child clerk.post failure');
      }
      const id = counter === 1 ? 'w-obs-group-fail' : `w-obs-child-fail-${counter - 1}`;
      return { id, title: p.title as string };
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated child clerk.post failure'));
        return true;
      },
    );

    // Three post attempts — group parent, child 1, child 2 (throws).
    // Child 3 never executed because we failed fast.
    assert.equal(postCalls.length, 3);
    assert.equal(postCalls[0].type, 'observation-set');
    assert.equal(postCalls[1].title, 'first');
    assert.equal(postCalls[2].title, 'second — explodes');

    // Two links persisted — group parent lifted-from + child 1's
    // spider.follows. Child 2's post threw before its link was attempted.
    assert.equal(mockClerkLinkCalls.length, 2);
    assert.equal(mockClerkLinkCalls[0].kind, 'astrolabe.lifted-from');
    assert.equal(mockClerkLinkCalls[0].sourceId, 'w-obs-group-fail');
    assert.equal(mockClerkLinkCalls[1].kind, 'spider.follows');
    assert.equal(mockClerkLinkCalls[1].sourceId, 'w-obs-child-fail-1');
  });

  it('grouped mode — fails fast on mid-loop clerk.link error; preceding writs and edges persist', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'first', body: 'b1' },
      { id: 'obs-2', title: 'second — link explodes', body: 'b2' },
      { id: 'obs-3', title: 'third — never reached', body: 'b3' },
    ];

    const plan = makePlan({
      id: 'w-mandate-grouped-link-fail',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const postCalls: Array<Record<string, unknown>> = [];
    let postCounter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      postCounter += 1;
      const id = postCounter === 1
        ? 'w-obs-linkgroup'
        : `w-obs-linkchild-${postCounter - 1}`;
      return { id, title: p.title as string };
    };

    let linkCounter = 0;
    mockClerkLink = async () => {
      linkCounter += 1;
      // Order: 1 = group lifted-from, 2 = child1 spider.follows,
      // 3 = child2 spider.follows (throws).
      if (linkCounter === 3) {
        throw new Error('simulated mid-loop clerk.link failure');
      }
      return {};
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated mid-loop clerk.link failure'));
        return true;
      },
    );

    // Three posts went through — group parent, child 1, child 2. The
    // third observation never executed because child 2's link threw.
    assert.equal(postCalls.length, 3);
    assert.equal(postCalls[0].type, 'observation-set');
    assert.equal(postCalls[1].title, 'first');
    assert.equal(postCalls[2].title, 'second — link explodes');

    // Three link attempts: group lifted-from (ok), child 1 spider.follows
    // (ok), child 2 spider.follows (threw).
    assert.equal(mockClerkLinkCalls.length, 3);
    assert.equal(mockClerkLinkCalls[0].kind, 'astrolabe.lifted-from');
    assert.equal(mockClerkLinkCalls[0].sourceId, 'w-obs-linkgroup');
    assert.equal(mockClerkLinkCalls[0].targetId, 'w-mandate-grouped-link-fail');

    assert.equal(mockClerkLinkCalls[1].kind, 'spider.follows');
    assert.equal(mockClerkLinkCalls[1].sourceId, 'w-obs-linkchild-1');
    assert.equal(mockClerkLinkCalls[1].targetId, 'w-mandate-grouped-link-fail');

    assert.equal(mockClerkLinkCalls[2].kind, 'spider.follows');
    assert.equal(mockClerkLinkCalls[2].sourceId, 'w-obs-linkchild-2');
    assert.equal(mockClerkLinkCalls[2].targetId, 'w-mandate-grouped-link-fail');
  });

  it('grouped mode — fails fast on the group parent lifted-from link error before any child post', async () => {
    const engine = createObservationLiftEngine(() => plansBook);
    const observations: Observation[] = [
      { id: 'obs-1', title: 'first', body: 'b1' },
      { id: 'obs-2', title: 'second', body: 'b2' },
    ];

    const plan = makePlan({
      id: 'w-mandate-group-linkfail-first',
      status: 'completed',
      observations,
    });
    await plansBook.put(plan);

    const postCalls: Array<Record<string, unknown>> = [];
    let postCounter = 0;
    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      postCounter += 1;
      return { id: `w-obs-glf-${postCounter}`, title: p.title as string };
    };
    mockClerkLink = async () => {
      throw new Error('simulated group lifted-from link failure');
    };

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('simulated group lifted-from link failure'));
        return true;
      },
    );

    // Only the group parent was posted; children never ran.
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].type, 'observation-set');
    // One link attempt — the group-parent lifted-from edge.
    assert.equal(mockClerkLinkCalls.length, 1);
    assert.equal(mockClerkLinkCalls[0].kind, 'astrolabe.lifted-from');
    assert.equal(mockClerkLinkCalls[0].sourceId, 'w-obs-glf-1');
    assert.equal(mockClerkLinkCalls[0].targetId, 'w-mandate-group-linkfail-first');
  });
});
