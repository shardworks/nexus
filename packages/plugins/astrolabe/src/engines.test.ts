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

const mockClerkApi = {
  show: async (id: string) => ({
    id,
    type: 'brief',
    status: 'ready' as const,
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
  transition: async () => { throw new Error('not implemented'); },
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
    const writ = { id: 'w-abc', codex: 'my-codex', type: 'brief', status: 'ready', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-abc', codex: undefined, type: 'brief', status: 'ready', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-abc', codex: '   ', type: 'brief', status: 'ready', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
    const writ = { id: 'w-dup', codex: 'codex-a', type: 'brief', status: 'ready', title: 'Test', body: 'Body', createdAt: '', updatedAt: '' };

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
          err.message.includes('Unresolved decisions after patron review: D2'),
          `Expected message about D2, got: ${err.message}`,
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
          err.message.includes('Unresolved decisions after patron review: D1, D3'),
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
});
