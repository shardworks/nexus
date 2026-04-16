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
  createSpecPublishEngine,
  parseTaskManifest,
} from './engines/index.ts';
import type { PlanDoc, Decision, ScopeItem } from './types.ts';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

// ── Test harness ─────────────────────────────────────────────────────

let stacks: StacksApi;
let plansBook: Book<PlanDoc>;
let inputRequestsBook: Book<InputRequestDoc>;
let memBackend: MemoryBackend;

// Mutable clerk overrides — tests can swap these out per-scenario
let mockClerkPost: (params: unknown) => Promise<{ id: string; title: string }> =
  async () => { throw new Error('clerk.post not implemented'); };
let mockClerkLink: (sourceId: string, targetId: string, type: string) => Promise<void> =
  async () => { throw new Error('clerk.link not implemented'); };
let mockClerkTransition: (id: string, to: string, fields?: unknown) => Promise<{ id: string }> =
  async () => { throw new Error('clerk.transition not implemented'); };

const mockClerkApi = {
  show: async (id: string) => ({
    id,
    type: 'brief',
    status: 'open' as const,
    title: `Brief for ${id}`,
    body: 'Body',
    codex: 'test-codex',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  post: async (params: unknown) => mockClerkPost(params),
  list: async () => [],
  count: async () => 0,
  link: async (sourceId: string, targetId: string, type: string) =>
    mockClerkLink(sourceId, targetId, type),
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
    const writ = { id: 'w-abc', codex: 'my-codex', type: 'brief', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-abc', codex: undefined, type: 'brief', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-abc', codex: '   ', type: 'brief', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-dup', codex: 'codex-a', type: 'brief', status: 'open', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    // Under the razor semantics an analyst-set `selected` means the decision
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

  // ── Analysis tags tests ──────────────────────────────────────────────

  it('decision with full analysis produces correct sorted tags', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Full analysis?',
        options: { A: 'Option A' },
        analysis: { category: 'product', observable: true, confidence: 'low', stakes: 'high' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { tags?: string[] };
    assert.deepEqual(q.tags, ['high-stakes', 'low-confidence', 'observable', 'product']);
  });

  it('decision without analysis produces no tags property', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'No analysis?',
        options: { A: 'Option A' },
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

  it('decision with partial analysis produces tags only for present fields', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Partial analysis?',
        options: { A: 'Option A' },
        analysis: { confidence: 'high' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { tags?: string[] };
    assert.deepEqual(q.tags, ['high-confidence']);
  });

  it('all analysis field-value combinations map correctly', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'All combos?',
        options: { A: 'Option A' },
        analysis: { category: 'api', observable: false, confidence: 'medium', stakes: 'low' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { tags?: string[] };
    assert.deepEqual(q.tags, ['api', 'internal', 'low-stakes', 'medium-confidence']);
  });

  it('category implementation maps to tag implementation', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Implementation?',
        options: { A: 'Option A' },
        analysis: { category: 'implementation' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);
    const q = inputReq?.questions['D1'] as { tags?: string[] };
    assert.deepEqual(q.tags, ['implementation']);
  });

  it('scope-item BooleanQuestionSpec has no tags', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: ['S1'],
        question: 'Q?',
        options: { A: 'Option A' },
        analysis: { category: 'product', confidence: 'high', stakes: 'high', observable: true },
      },
    ];
    const scope: ScopeItem[] = [
      { id: 'S1', description: 'Scope item', rationale: 'Reason', included: true },
    ];

    const plan = makePlan({ status: 'analyzing', decisions, scope });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);

    // Decision should have tags
    const dq = inputReq?.questions['D1'] as { tags?: string[] };
    assert.ok(dq.tags);

    // Scope question should NOT have tags
    const sq = inputReq?.questions['scope:S1'] as Record<string, unknown>;
    assert.equal('tags' in sq, false);
  });

  it('multiple decisions with varying analysis', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'With analysis?',
        options: { A: 'Option A' },
        analysis: { category: 'api', stakes: 'low' },
      },
      {
        id: 'D2',
        scope: [],
        question: 'Without analysis?',
        options: { X: 'Option X' },
      },
    ];

    const plan = makePlan({ status: 'analyzing', decisions });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    const blocked = result as { status: 'blocked'; condition: { requestId: string } };
    const inputReq = await inputRequestsBook.get(blocked.condition.requestId);

    const q1 = inputReq?.questions['D1'] as { tags?: string[] };
    assert.deepEqual(q1.tags, ['api', 'low-stakes']);

    const q2 = inputReq?.questions['D2'] as Record<string, unknown>;
    assert.equal('tags' in q2, false);
  });

  // ── Analyst pre-decision / fast-path tests (razor + three defaults) ─

  it('fast-path: all decisions pre-decided with no scope — skips gate', async () => {
    // D10(a): when the analyst has pre-filled `selected` on every decision
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
        selected: 'A', // analyst pre-decided
      },
      {
        id: 'D2',
        scope: [],
        question: 'Q2?',
        options: { X: 'X', Y: 'Y' },
        recommendation: 'Y',
        selected: 'Y', // analyst pre-decided
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
        selected: 'X', // analyst pre-decided — should NOT appear in InputRequestDoc
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
    // Scope inclusion flags are preserved exactly as the analyst set them
    assert.equal(updated?.scope?.[0].included, true);
    assert.equal(updated?.scope?.[1].included, false);

    // No InputRequestDoc was created
    const reqs = await inputRequestsBook.find({
      where: [['rigId', '=', 'rig-test-001'], ['engineId', '=', 'decision-review']],
      limit: 10,
    });
    assert.equal(reqs.length, 0);
  });

  it('reconcile preserves analyst-set `selected` through the round trip', async () => {
    // D10(d): a mixed plan goes through first-pass (reviewable + pre-decided)
    // and reconcile; the pre-decided decision's analyst-set `selected`
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
        selected: 'X', // analyst pre-decided
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
    // D2: analyst-set `selected` preserved unchanged
    assert.equal(finalPlan?.decisions?.[1].selected, 'X');
    assert.equal(finalPlan?.decisions?.[1].patronOverride, undefined);

    // The decisionSummary yields both entries identically (no auto vs. confirmed marker)
    const { decisionSummary } = (secondResult as { status: 'completed'; yields: { decisionSummary: string } }).yields;
    assert.ok(decisionSummary.includes('D1'));
    assert.ok(decisionSummary.includes('D2'));
    assert.ok(decisionSummary.includes('**Selected:** X'));
  });

  it('decision with empty analysis object produces no tags', async () => {
    const engine = createDecisionReviewEngine(() => plansBook);
    const decisions: Decision[] = [
      {
        id: 'D1',
        scope: [],
        question: 'Empty analysis?',
        options: { A: 'Option A' },
        analysis: {},
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
});

// ── spec-publish tests ────────────────────────────────────────────────

describe('spec-publish engine', () => {
  beforeEach(() => {
    setup();
    // Reset mocks to safe defaults
    mockClerkPost = async () => ({ id: 'writ-generated-001', title: 'Generated' });
    mockClerkLink = async () => {};
  });
  afterEach(() => { clearGuild(); });

  it('has id astrolabe.spec-publish and a run function', () => {
    const engine = createSpecPublishEngine(() => plansBook);
    assert.equal(engine.id, 'astrolabe.spec-publish');
    assert.equal(typeof engine.run, 'function');
  });

  it('happy path — posts writ, links, updates PlanDoc, returns completed', async () => {
    const engine = createSpecPublishEngine(() => plansBook);

    const postCalls: unknown[] = [];
    const linkCalls: [string, string, string][] = [];

    mockClerkPost = async (params) => {
      postCalls.push(params);
      return { id: 'writ-mandate-001', title: (params as { title: string }).title };
    };
    mockClerkLink = async (src, tgt, type) => {
      linkCalls.push([src, tgt, type]);
    };

    const plan = makePlan({
      id: 'w-brief-001',
      codex: 'my-codex',
      status: 'writing',
      spec: '# Spec\nContent here',
    });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    const yields = (result as { status: 'completed'; yields: { generatedWritId: string } }).yields;
    assert.equal(yields.generatedWritId, 'writ-mandate-001');

    // Verify clerk.post args
    assert.equal(postCalls.length, 1);
    const posted = postCalls[0] as { type: string; title: string; body: string; codex: string };
    assert.equal(posted.type, 'mandate');
    assert.equal(posted.title, `Brief for ${plan.id}`); // mockClerkApi.show returns this
    assert.equal(posted.body, '# Spec\nContent here');
    assert.equal(posted.codex, 'my-codex');

    // Verify clerk.link args
    assert.equal(linkCalls.length, 1);
    assert.deepEqual(linkCalls[0], ['writ-mandate-001', 'w-brief-001', 'refines']);

    // Verify PlanDoc update
    const updatedPlan = await plansBook.get(plan.id);
    assert.equal(updatedPlan?.generatedWritId, 'writ-mandate-001');
    assert.equal(updatedPlan?.status, 'completed');
    assert.ok(updatedPlan?.updatedAt);
  });

  it('uses custom generatedWritType from guild config', async () => {
    const postCalls: unknown[] = [];
    mockClerkPost = async (params) => {
      postCalls.push(params);
      return { id: 'writ-custom-001', title: 'T' };
    };
    mockClerkLink = async () => {};

    // Override guild with custom astrolabe config
    const apparatusMap2 = new Map<string, unknown>();
    apparatusMap2.set('stacks', stacks);
    apparatusMap2.set('clerk', mockClerkApi);

    const customGuildConfig: GuildConfig & { astrolabe?: { generatedWritType?: string } } = {
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
      settings: { model: 'sonnet' },
      astrolabe: { generatedWritType: 'reviewed-mandate' },
    };

    const customGuild: Guild = {
      home: '/tmp/fake-guild',
      apparatus<T>(name: string): T {
        const a = apparatusMap2.get(name);
        if (!a) throw new Error(`Apparatus "${name}" not installed`);
        return a as T;
      },
      config<T>(_pluginId: string): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return customGuildConfig as GuildConfig; },
      kits: () => [],
      apparatuses: () => [],
      failedPlugins: () => [],
      startupWarnings() { return []; },
    };
    setGuild(customGuild);

    const plan = makePlan({ id: 'w-custom-001', codex: 'c', status: 'writing', spec: '# Spec' });
    await plansBook.put(plan);

    const engine = createSpecPublishEngine(() => plansBook);
    await engine.run({ planId: plan.id }, buildCtx());

    assert.equal(postCalls.length, 1);
    const posted = postCalls[0] as { type: string };
    assert.equal(posted.type, 'reviewed-mandate');
  });

  it('throws when plan not found', async () => {
    const engine = createSpecPublishEngine(() => plansBook);

    await assert.rejects(
      () => engine.run({ planId: 'no-such-plan' }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('not found'), `Expected "not found" in: ${err.message}`);
        return true;
      },
    );
  });

  it('throws when plan status is not writing', async () => {
    const engine = createSpecPublishEngine(() => plansBook);
    const plan = makePlan({ status: 'analyzing', spec: '# Spec' });
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.includes('writing'), `Expected "writing" in: ${err.message}`);
        return true;
      },
    );
  });

  it('throws when plan spec is missing', async () => {
    const engine = createSpecPublishEngine(() => plansBook);
    const plan = makePlan({ status: 'writing' });
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('no spec'), `Expected "no spec" in: ${err.message}`);
        return true;
      },
    );
  });

  it('throws when plan spec is empty string', async () => {
    const engine = createSpecPublishEngine(() => plansBook);
    const plan = makePlan({ status: 'writing', spec: '' });
    await plansBook.put(plan);

    await assert.rejects(
      () => engine.run({ planId: plan.id }, buildCtx()),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('no spec'), `Expected "no spec" in: ${err.message}`);
        return true;
      },
    );
  });

  it('creates piece writs from task-manifest and strips manifest from body', async () => {
    const engine = createSpecPublishEngine(() => plansBook);

    const postCalls: Array<Record<string, unknown>> = [];
    const linkCalls: [string, string, string][] = [];
    const transitionCalls: Array<{ id: string; to: string }> = [];
    let postCounter = 0;

    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      postCounter++;
      return { id: `writ-${postCounter}`, title: p.title as string };
    };
    mockClerkLink = async (src, tgt, type) => {
      linkCalls.push([src, tgt, type]);
    };
    mockClerkTransition = async (id, to) => {
      transitionCalls.push({ id, to });
      return { id };
    };

    const specWithManifest = `# Implementation Spec

Some preamble text.

<task-manifest>
  <task id="t1">
    <name>First task</name>
    <action>Do the first thing</action>
  </task>
  <task id="t2">
    <name>Second task</name>
    <action>Do the second thing</action>
  </task>
</task-manifest>`;

    const plan = makePlan({
      id: 'w-manifest-001',
      codex: 'my-codex',
      status: 'writing',
      spec: specWithManifest,
    });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    const yields = (result as { status: 'completed'; yields: { generatedWritId: string } }).yields;
    assert.equal(yields.generatedWritId, 'writ-1');

    // First post: mandate in draft state
    assert.equal(postCalls.length, 3); // 1 mandate + 2 pieces
    assert.equal(postCalls[0].draft, true);
    assert.equal(postCalls[0].type, 'mandate');
    // Body should NOT contain the task-manifest block
    const mandateBody = postCalls[0].body as string;
    assert.ok(!mandateBody.includes('<task-manifest>'), 'Mandate body should not contain task-manifest');
    assert.ok(mandateBody.includes('# Implementation Spec'), 'Mandate body should contain preamble');

    // Piece posts
    assert.equal(postCalls[1].type, 'piece');
    assert.equal(postCalls[1].title, 'First task');
    assert.equal(postCalls[1].parentId, 'writ-1');
    assert.ok((postCalls[1].body as string).includes('<task id="t1">'));

    assert.equal(postCalls[2].type, 'piece');
    assert.equal(postCalls[2].title, 'Second task');
    assert.equal(postCalls[2].parentId, 'writ-1');
    assert.ok((postCalls[2].body as string).includes('<task id="t2">'));

    // Link created
    assert.equal(linkCalls.length, 1);
    assert.deepEqual(linkCalls[0], ['writ-1', 'w-manifest-001', 'refines']);

    // Mandate transitioned from draft to open
    assert.equal(transitionCalls.length, 1);
    assert.equal(transitionCalls[0].id, 'writ-1');
    assert.equal(transitionCalls[0].to, 'open');

    // PlanDoc updated
    const updatedPlan = await plansBook.get(plan.id);
    assert.equal(updatedPlan?.generatedWritId, 'writ-1');
    assert.equal(updatedPlan?.status, 'completed');
  });

  it('falls back to legacy path when spec has no task-manifest', async () => {
    const engine = createSpecPublishEngine(() => plansBook);

    const postCalls: Array<Record<string, unknown>> = [];
    const transitionCalls: Array<{ id: string; to: string }> = [];

    mockClerkPost = async (params) => {
      const p = params as Record<string, unknown>;
      postCalls.push(p);
      return { id: 'writ-legacy-001', title: p.title as string };
    };
    mockClerkLink = async () => {};
    mockClerkTransition = async (id, to) => {
      transitionCalls.push({ id, to });
      return { id };
    };

    const plan = makePlan({
      id: 'w-nomanifest-001',
      codex: 'my-codex',
      status: 'writing',
      spec: '# Spec\nPlain spec without manifest.',
    });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');

    // Only one post (the mandate), no draft, no pieces
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].draft, undefined);
    assert.equal(postCalls[0].body, '# Spec\nPlain spec without manifest.');

    // No transition call (legacy path doesn't use draft)
    assert.equal(transitionCalls.length, 0);
  });
});

// ── parseTaskManifest tests ─────────────────────────────────────────

describe('parseTaskManifest', () => {
  it('parses tasks from a spec with task-manifest block', () => {
    const spec = `# Spec

<task-manifest>
  <task id="t1">
    <name>First</name>
    <action>Do first</action>
  </task>
  <task id="t2">
    <name>Second</name>
    <action>Do second</action>
  </task>
</task-manifest>`;

    const result = parseTaskManifest(spec);
    assert.ok(result);
    assert.equal(result.tasks.length, 2);
    assert.ok(result.tasks[0].includes('<task id="t1">'));
    assert.ok(result.tasks[1].includes('<task id="t2">'));
    assert.ok(!result.strippedSpec.includes('<task-manifest>'));
    assert.ok(result.strippedSpec.includes('# Spec'));
  });

  it('returns null when no task-manifest block exists', () => {
    const spec = '# Spec\nJust regular content.';
    assert.equal(parseTaskManifest(spec), null);
  });

  it('returns null when task-manifest is empty', () => {
    const spec = '# Spec\n<task-manifest></task-manifest>';
    assert.equal(parseTaskManifest(spec), null);
  });

  it('preserves raw task XML fragments', () => {
    const spec = `Preamble
<task-manifest>
  <task id="t1">
    <name>Register piece writ type</name>
    <files>packages/plugins/astrolabe/src/astrolabe.ts</files>
    <action>Add piece as a writ type</action>
    <verify>pnpm -w typecheck</verify>
    <done>The piece writ type is registered</done>
  </task>
</task-manifest>`;

    const result = parseTaskManifest(spec);
    assert.ok(result);
    assert.equal(result.tasks.length, 1);
    assert.ok(result.tasks[0].includes('<files>'));
    assert.ok(result.tasks[0].includes('<verify>'));
    assert.ok(result.tasks[0].includes('<done>'));
  });
});
