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
} from './engines/index.ts';
import type { PlanDoc, Decision, ScopeItem } from './types.ts';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

// ── Test harness ─────────────────────────────────────────────────────

let stacks: StacksApi;
let plansBook: Book<PlanDoc>;
let inputRequestsBook: Book<InputRequestDoc>;
let memBackend: MemoryBackend;

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
  post: async () => { throw new Error('not implemented'); },
  list: async () => [],
  count: async () => 0,
  link: async () => { throw new Error('not implemented'); },
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

  it('completes when plan has a non-empty inventory', async () => {
    const engine = createInventoryCheckEngine(() => plansBook);
    const plan = makePlan({ inventory: 'src/app.ts — main entry point' });
    await plansBook.put(plan);

    const result = await engine.run({ planId: plan.id }, buildCtx());
    assert.equal(result.status, 'completed');
    assert.deepEqual((result as { status: 'completed'; yields: unknown }).yields, {});
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
});
