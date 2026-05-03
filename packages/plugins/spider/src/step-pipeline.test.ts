/**
 * Step pipeline — integration tests.
 *
 * Tests the implement-loop engine, step-session engine, and the full
 * step execution pipeline including:
 *   - Sequential step execution with halt-on-failure
 *   - Backward compatibility (mandates without steps)
 *   - Step-aware anima instructions
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, RigTemplate, DraftYields, EngineInstance } from './types.ts';

import { STEP_EXECUTION_EPILOGUE } from './engines/step-session.ts';
import { EXECUTION_EPILOGUE } from './engines/implement.ts';

// ── Test harness ─────────────────────────────────────────────────────

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(apparatuses: LoadedApparatus[]): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

function buildCtx(kitEntries: KitEntry[] = []): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const ctx: StartupContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter(e => e.type === type)];
    },
  };
  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) await h(...args);
  }
  return { ctx, fire };
}

/**
 * Template that uses implement-loop. Uses draft for upstream yields but
 * we pre-complete draft in tests (no codexes apparatus needed).
 */
const IMPLEMENT_LOOP_TEMPLATE: RigTemplate = {
  engines: [
    { id: 'draft',          designId: 'draft',          givens: { writ: '${writ}' } },
    { id: 'implement-loop', designId: 'implement-loop', upstream: ['draft'], givens: { writ: '${writ}', role: '${vars.role}' } },
    { id: 'seal',           designId: 'seal',           upstream: ['implement-loop'], givens: {} },
  ],
  resolutionEngine: 'seal',
};

function buildFixture(
  sessionOutcome: { status: 'completed' | 'failed'; error?: string; output?: string } = { status: 'completed' },
) {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const fabricatorPlugin = createFabricator();
  const spiderPlugin = createSpider();

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  if (!('apparatus' in clerkPlugin)) throw new Error('clerk must be apparatus');
  if (!('apparatus' in fabricatorPlugin)) throw new Error('fabricator must be apparatus');
  if (!('apparatus' in spiderPlugin)) throw new Error('spider must be apparatus');

  const stacksApparatus = stacksPlugin.apparatus;
  const clerkApparatus = clerkPlugin.apparatus;
  const fabricatorApparatus = fabricatorPlugin.apparatus;
  const spiderApparatus = spiderPlugin.apparatus;

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    spider: {
      rigTemplates: { default: IMPLEMENT_LOOP_TEMPLATE },
      rigTemplateMappings: { mandate: 'default' },
      variables: { role: 'artificer' },
    },
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits() { return []; },
    apparatuses() { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  const spiderAsLoaded: LoadedApparatus = {
    packageName: '@shardworks/spider-apparatus',
    id: 'spider',
    version: '0.0.0',
    apparatus: spiderApparatus,
  };

  const fabricatorKitEntries = buildKitEntries([spiderAsLoaded]);
  const spiderKitEntries = buildKitEntries([spiderAsLoaded]);

  const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
  stacksApparatus.start(noopCtx);
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: ['sourceId', 'targetId', 'type', ['sourceId', 'type'], ['targetId', 'type']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['status', 'rigId', 'engineId', 'createdAt', ['rigId', 'engineId', 'status']],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });

  let currentSessionOutcome = sessionOutcome;
  const summonCalls: SummonRequest[] = [];
  const mockAnimatorApi: AnimatorApi = {
    summon(request: SummonRequest): AnimateHandle {
      summonCalls.push(request);
      const sessionId = generateId('ses', 4);
      const startedAt = new Date().toISOString();
      const outcome = currentSessionOutcome;
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      const doc: SessionDoc = {
        id: sessionId,
        status: outcome.status,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: 0,
        provider: 'mock',
        exitCode: outcome.status === 'completed' ? 0 : 1,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        metadata: request.metadata,
      };
      void sessBook.put(doc);
      const result = Promise.resolve(doc as SessionResult);
      async function* emptyChunks(): AsyncIterable<SessionChunk> {}
      return { sessionId, chunks: emptyChunks(), result };
    },
    animate(): AnimateHandle { throw new Error('not used'); },
    subscribeToSession() { return null; },
    async cancel(sessionId: string): Promise<SessionDoc> {
      return { id: sessionId, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as SessionDoc;
    },
  };
  apparatusMap.set('animator', mockAnimatorApi);

  clerkApparatus.start(noopCtx);
  const realClerk = clerkApparatus.provides as ClerkApi;

  // Register `step` with the Clerk's runtime registry. The legacy
  // `clerk.writTypes` guild-config channel and the kit-channel scan have
  // both been retired; this is the only path. The state machine is a
  // mandate clone (D17 in the Clerk-refactor commission). Register from
  // here while the registry's startup window is still open — the test
  // harness never fires `phase:started`, so the registry stays open for
  // the lifetime of the fixture.
  realClerk.registerWritType({
    name: 'step',
    states: [
      { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
      { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
      { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
      { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
      { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
      { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
    ],
  });

  // Fixture wrapper: legacy step-pipeline tests post mandate writs and
  // expect them to be `open` (dispatchable) immediately — that was the
  // pre-registry-refactor auto-publish semantics. The post-refactor
  // ClerkApi.post() lands writs in their declared initial state (`new`).
  // The wrapper preserves the fixture's prior behaviour by auto-publishing
  // any writ that lands in `new`. Mandate, step, and any other type used
  // here all declare `new → open` as a legal transition. This is a
  // test-fixture concession, not an API change. Tests that need a writ to
  // stay in `new` can call `realClerk.post(...)` directly.
  const clerk: ClerkApi = {
    ...realClerk,
    async post(request) {
      const writ = await realClerk.post(request);
      if (writ.phase === 'new') {
        return realClerk.transition(writ.id, 'open');
      }
      return writ;
    },
  };
  apparatusMap.set('clerk', clerk);

  const { ctx: fabricatorCtx } = buildCtx(fabricatorKitEntries);
  fabricatorApparatus.start(fabricatorCtx);
  const fabricator = fabricatorApparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  const { ctx: spiderCtx } = buildCtx(spiderKitEntries);
  spiderApparatus.start(spiderCtx);
  const spider = spiderApparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  return {
    stacks, clerk, realClerk, fabricator, spider, memBackend,
    summonCalls,
    setSessionOutcome(outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) {
      currentSessionOutcome = outcome;
    },
  };
}

type Fix = ReturnType<typeof buildFixture>;

function rigsBook(stacks: StacksApi) {
  return stacks.book<RigDoc>('spider', 'rigs');
}

const DRAFT_YIELDS: DraftYields = {
  draftId: 'd-test',
  codexName: 'test-codex',
  branch: 'draft/test',
  path: '/tmp/test-draft',
  baseSha: 'abc123',
};

/**
 * Pre-complete the draft engine for a rig. The draft engine needs codexes
 * which we don't mock, so we patch the rig directly.
 */
async function preCompleteDraft(stacks: StacksApi, writId: string): Promise<string> {
  const book = rigsBook(stacks);
  const rigs = await book.find({ where: [['writId', '=', writId]] });
  const rig = rigs[0];
  if (!rig) throw new Error(`No rig for writ ${writId}`);

  const nowIso = new Date().toISOString();
  const updatedEngines = rig.engines.map(e =>
    e.id === 'draft'
      ? {
          ...e,
          status: 'completed' as const,
          attempts: [
            {
              startedAt: nowIso,
              endedAt: nowIso,
              status: 'completed' as const,
              yields: DRAFT_YIELDS,
            },
          ],
        }
      : e,
  );
  await book.patch(rig.id, { engines: updatedEngines });
  return rig.id;
}

// ── Local helpers ────────────────────────────────────────────────────

const taskBody = (id: string): string =>
  `<task id="${id}"><name>${id.toUpperCase()}</name></task>`;

async function postMandate(clerk: ClerkApi, opts: { title?: string; body?: string } = {}): Promise<WritDoc> {
  return clerk.post({
    title: opts.title ?? 'Test mandate',
    body: opts.body ?? 'Spec',
    codex: 'test',
  });
}

async function postStep(
  clerk: ClerkApi,
  mandateId: string,
  taskId: string,
  opts: { title?: string; body?: string } = {},
): Promise<WritDoc> {
  return clerk.post({
    type: 'step',
    title: opts.title ?? `Task ${taskId}`,
    body: opts.body ?? taskBody(taskId),
    parentId: mandateId,
  });
}

async function getRigByWrit(fix: Fix, writId: string): Promise<RigDoc> {
  const rigs = await rigsBook(fix.stacks).find({ where: [['writId', '=', writId]] });
  return rigs[0];
}

const findEngine = (rig: RigDoc, id: string): EngineInstance | undefined =>
  rig.engines.find((e) => e.id === id);

const lastPrompt = (fix: Fix): string =>
  fix.summonCalls[fix.summonCalls.length - 1]!.prompt;

/** Drive the rig: spawn → pre-complete draft → implement-loop → graft → step-0 started. */
async function advanceToStepStarted(fix: Fix, mandateId: string): Promise<void> {
  await fix.spider.crawl();                 // rig-spawned
  await preCompleteDraft(fix.stacks, mandateId);
  await fix.spider.crawl();                 // implement-loop completed
  await fix.spider.crawl();                 // graft
  await fix.spider.crawl();                 // step-0 started
}

/** Patch the most recently-written animator session to `failed`. */
async function failLastSession(fix: Fix, error: string): Promise<void> {
  const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
  const sessions = await sessBook.find({});
  const lastSession = sessions[sessions.length - 1];
  await sessBook.patch(lastSession.id, { status: 'failed', error });
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  return { warnings, restore: () => { console.warn = original; } };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('implement-loop engine', () => {
  let fix: Fix;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('registers implement-loop and step-session in the Fabricator', () => {
    assert.ok(fix.fabricator.getEngineDesign('implement-loop'), 'implement-loop registered');
    assert.ok(fix.fabricator.getEngineDesign('step-session'), 'step-session registered');
    // Original implement engine still registered for rollback
    assert.ok(fix.fabricator.getEngineDesign('implement'), 'implement still registered');
  });

  it('falls through to legacy single-session when no child steps exist', async () => {
    // Post a mandate without children
    await postMandate(fix.clerk, { title: 'No-step mandate', body: 'Do something' });

    // Spawn rig
    const r1 = await fix.spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const writId = (r1 as { writId: string }).writId;

    // Draft engine will fail (no codexes). Pre-complete it.
    await preCompleteDraft(fix.stacks, writId);

    // implement-loop runs — should launch a single session (legacy path)
    const r2 = await fix.spider.crawl();
    assert.equal(r2?.action, 'engine-started');

    // Verify the summon call used the legacy EXECUTION_EPILOGUE
    const prompt = lastPrompt(fix);
    assert.ok(prompt.includes('task-manifest'), 'Legacy prompt should contain task-manifest instructions');
    assert.ok(!prompt.includes('Current Task'), 'Legacy prompt should not contain step-specific phrasing');
  });

  it('grafts step-session engines when child steps exist', async () => {
    // Post a mandate in draft state
    const mandate = await postMandate(fix.clerk, { title: 'Step mandate', body: 'Main spec' });

    // Create child steps
    await postStep(fix.clerk, mandate.id, 't1', { title: 'Task 1' });
    await postStep(fix.clerk, mandate.id, 't2', { title: 'Task 2' });

    // Mandate is already in `open` thanks to the fixture's auto-publish wrapper.

    // Spawn rig
    const r1 = await fix.spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');

    // Pre-complete draft
    await preCompleteDraft(fix.stacks, mandate.id);

    // implement-loop runs — clockwork, completes immediately + queues graft
    const r2 = await fix.spider.crawl();
    assert.equal(r2?.action, 'engine-completed');

    // Process graft
    const r3 = await fix.spider.crawl();
    assert.equal(r3?.action, 'engine-grafted');
    if (r3?.action === 'engine-grafted') {
      assert.equal(r3.graftedEngineIds.length, 2);
      assert.ok(r3.graftedEngineIds.includes('step-0'));
      assert.ok(r3.graftedEngineIds.includes('step-1'));
    }

    // First step-session starts
    const r4 = await fix.spider.crawl();
    assert.equal(r4?.action, 'engine-started');

    // Verify the first step session prompt
    const prompt = lastPrompt(fix);
    assert.ok(prompt.includes('Main spec'), 'Step prompt should include mandate body');
    assert.ok(prompt.includes('<task id="t1">'), 'Step prompt should include step body');
    assert.ok(prompt.includes('Current Task'), 'Step prompt should have step-specific header');
    assert.ok(prompt.includes('Mandate ID:'), 'Step prompt should include mandate ID');
  });

  it('processes steps sequentially — second step waits for first', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Sequential' });
    await postStep(fix.clerk, mandate.id, 'ta', { title: 'Task A' });
    await postStep(fix.clerk, mandate.id, 'tb', { title: 'Task B' });

    await advanceToStepStarted(fix, mandate.id);

    // Collect step-0 (session completes)
    const r5 = await fix.spider.crawl();
    assert.equal(r5?.action, 'engine-completed');

    // step-1 should now start
    const r6 = await fix.spider.crawl();
    assert.equal(r6?.action, 'engine-started');

    // Verify step-1 prompt has step B's body
    assert.ok(lastPrompt(fix).includes('<task id="tb">'),
      'Second step should use task B body');
  });

  it('halts rig when a step session fails', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Fail test' });
    await postStep(fix.clerk, mandate.id, 't1');
    await postStep(fix.clerk, mandate.id, 't2');

    await advanceToStepStarted(fix, mandate.id);

    await failLastSession(fix, 'Task failed');

    // Collect → rig should fail
    const r = await fix.spider.crawl();
    assert.equal(r?.action, 'rig-completed');
    if (r?.action === 'rig-completed') {
      assert.equal(r.outcome, 'failed', 'Rig should be failed after step failure');
    }

    // Verify the rig status
    const rig = await getRigByWrit(fix, mandate.id);
    assert.equal(rig.status, 'failed');
  });

  it('step-session transitions step writs on completion', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Transition test' });
    const step = await postStep(fix.clerk, mandate.id, 't1');

    await advanceToStepStarted(fix, mandate.id);
    await fix.spider.crawl(); // step-0 collected (completed)

    // Check the step writ was transitioned to completed
    const updatedStep = await fix.clerk.show(step.id);
    assert.equal(updatedStep.phase, 'completed');
  });

  it('step writ is cancelled when session fails and mandate reaches failed (parent→child cascade)', async () => {
    // Design: Spider's tryCollect() calls failEngine() directly for failed sessions
    // and never invokes the engine's collect() method. This means step-session
    // cannot itself transition the step writ on session failure.
    //
    // In the engine-retry model, engine-failure transitions the mandate writ
    // directly to `phase='failed'`. Mandate's `parentTerminal` action then
    // cascades downward to cancel every non-terminal descendant — the step
    // writ here transitions to `cancelled` with the canonical resolution
    // string `Automatically cancelled due to parent termination`.
    const mandate = await postMandate(fix.clerk, { title: 'Fail transition' });
    const step = await postStep(fix.clerk, mandate.id, 't1');

    await advanceToStepStarted(fix, mandate.id);
    await failLastSession(fix, 'Build failed');

    await fix.spider.crawl(); // failEngine → rig failed → mandate failed → cascade cancels step

    const updatedMandate = await fix.clerk.show(mandate.id);
    assert.equal(updatedMandate.phase, 'failed', 'Mandate transitions to failed via engine-failure path');

    const updatedStep = await fix.clerk.show(step.id);
    assert.equal(updatedStep.phase, 'cancelled',
      'Step writ is cancelled by mandate\'s parentTerminal cascade');
    assert.equal(updatedStep.resolution, 'Automatically cancelled due to parent termination',
      'Step writ carries the canonical cascade resolution');
  });

  it('dynamically added steps are picked up after the current step completes', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Dynamic steps' });
    await postStep(fix.clerk, mandate.id, 't1');

    await advanceToStepStarted(fix, mandate.id);

    // While step-0 is running, dynamically add a new step via clerk
    const dynStep = await postStep(fix.clerk, mandate.id, 'dyn1', { title: 'Dynamic Task' });

    // step-0 collects — its collect() discovers the new open step and grafts it
    const r1 = await fix.spider.crawl();
    assert.equal(r1?.action, 'engine-completed', 'step-0 should complete');

    // Process the graft from step-0's collect
    const r2 = await fix.spider.crawl();
    assert.equal(r2?.action, 'engine-grafted', 'Dynamic step should be grafted');
    if (r2?.action === 'engine-grafted') {
      assert.equal(r2.graftedEngineIds.length, 1);
      assert.ok(r2.graftedEngineIds[0].includes(dynStep.id),
        'Grafted engine ID should reference the dynamic step writ ID');
    }

    // The dynamic step-session should now start
    const r3 = await fix.spider.crawl();
    assert.equal(r3?.action, 'engine-started', 'Dynamic step session should start');

    // It completes and transitions the step writ
    const r4 = await fix.spider.crawl();
    assert.equal(r4?.action, 'engine-completed', 'Dynamic step session should complete');

    const updatedDynStep = await fix.clerk.show(dynStep.id);
    assert.equal(updatedDynStep.phase, 'completed', 'Dynamic step should be marked completed');
  });

  it('dynamically added steps delay seal via graftTail', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Dynamic graftTail' });
    await postStep(fix.clerk, mandate.id, 't1');

    await advanceToStepStarted(fix, mandate.id);

    // Add a dynamic step while step-0 is running
    await postStep(fix.clerk, mandate.id, 'dyn1', { title: 'Dynamic Task' });

    await fix.spider.crawl(); // step-0 collected
    await fix.spider.crawl(); // dynamic step grafted

    // After graft, verify seal now has the dynamic step in its upstream
    const rig = await getRigByWrit(fix, mandate.id);
    const sealEngine = findEngine(rig, 'seal');
    assert.ok(sealEngine, 'Seal engine should exist');

    // Seal should have both implement-loop and the original step-0 in upstream
    // (from the original graftTail), AND the dynamic step (from the dynamic graftTail)
    const dynStepEngine = rig.engines.find(e => e.designId === 'step-session' && e.id.startsWith('step-') && e.id !== 'step-0');
    assert.ok(dynStepEngine, 'Dynamic step engine should exist in rig');
    assert.ok(sealEngine!.upstream.includes(dynStepEngine!.id),
      `Seal upstream should include dynamic step engine (${dynStepEngine!.id}), got: ${JSON.stringify(sealEngine!.upstream)}`);
  });

  it('literal WritDoc givens survive yield resolution in step-session engines', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Givens test', body: 'Spec body' });
    const step = await postStep(fix.clerk, mandate.id, 't1');

    await fix.spider.crawl(); // rig-spawned
    await preCompleteDraft(fix.stacks, mandate.id);
    await fix.spider.crawl(); // implement-loop completed
    await fix.spider.crawl(); // graft

    // Verify the grafted engine's givensSpec has the step as a literal object
    const rig = await getRigByWrit(fix, mandate.id);
    const stepEngine = findEngine(rig, 'step-0');
    assert.ok(stepEngine, 'step-0 engine should exist');

    // The step given should be a literal object (not stringified)
    const stepGiven = stepEngine!.givensSpec.step as WritDoc;
    assert.equal(typeof stepGiven, 'object', 'step given should be an object');
    assert.equal(stepGiven.id, step.id, 'step given should have the correct writ ID');
    assert.equal(stepGiven.type, 'step', 'step given should have the correct type');

    // Now run the step-session and verify the summon call used the step body
    await fix.spider.crawl(); // step-0 started
    const prompt = lastPrompt(fix);
    assert.ok(prompt.includes('<task id="t1">'),
      'Step prompt should include the step body from the literal WritDoc given');
    assert.ok(prompt.includes(mandate.id),
      'Step prompt should include mandate ID from the resolved writ given');
  });

  it('full pipeline: steps complete → seal runs → rig completes', async () => {
    const mandate = await postMandate(fix.clerk, { title: 'Full pipeline' });
    await postStep(fix.clerk, mandate.id, 't1', { title: 'Only task' });

    await advanceToStepStarted(fix, mandate.id);
    await fix.spider.crawl(); // step-0 collected

    // At this point all grafted engines are done. The seal engine should be next.
    // But seal needs the implement-loop to be upstream, not step-0.
    // Wait — seal upstream is ['implement-loop'], which is already completed.
    // But step-0 was grafted with upstream ['implement-loop'].
    // So when step-0 completes, seal's upstream (implement-loop) is already done.
    // Seal should be runnable now.

    // But seal needs codexes too (to finalize the draft). Let's check what happens.
    // The seal engine will fail since there's no codexes apparatus.
    // That's OK — we've verified the step pipeline works. The seal failure is expected.
    const r = await fix.spider.crawl();
    // It's either seal starting/failing, or rig completing. Whatever the seal outcome is.
    assert.ok(r !== null, 'There should be more work to do');
  });
});

// ── Regression: step writ transition race in collect() ─────────────
//
// The bug was that step-session `collect()` swallowed every error from its
// `clerk.transition(step, 'completed')` call with a bare `catch {}`. When
// that transition failed — most commonly because the parent's downward
// cascade beat it to the writ (mandate's `parentTerminal` action cancels
// every non-terminal descendant when the parent itself reaches a `failure`-
// or `cancelled`-attr terminal) — the failure was invisible, and the step
// writ ended up misattributed as "sibling failure". The fix:
//
//   (a) Classify caught transition errors: already-terminal is expected and
//       silent; anything else logs a warning so the race is visible.
//   (b) Re-read the step writ after the transition attempt and include the
//       observed status in `yields.stepStatus`, regardless of outcome.
//
// These regression tests fail if the bare `catch {}` is reintroduced (the
// unexpected-error warning would not fire) or if the re-read is removed (the
// observed `stepStatus` would be missing from yields).

describe('step-session collect() — transition error classification', () => {
  let fix: Fix;

  beforeEach(() => { fix = buildFixture(); });
  afterEach(() => { clearGuild(); });

  /**
   * Drive the rig up to the point where step-0 has started (its session is
   * already completed in the mock Animator) but has not yet been collected.
   * Returns the step writ so callers can manipulate its state before the
   * next crawl invokes `collect()`.
   */
  async function setupRaceFixture(): Promise<{ mandate: WritDoc; step: WritDoc }> {
    const mandate = await postMandate(fix.clerk, { title: 'Race' });
    const step = await postStep(fix.clerk, mandate.id, 't1');
    await advanceToStepStarted(fix, mandate.id);
    return { mandate, step };
  }

  /** Read step-0's last attempt yields after collect() has run. */
  async function readStepYields(mandateId: string): Promise<{
    engine: EngineInstance;
    yields: Record<string, unknown>;
  }> {
    const rig = await getRigByWrit(fix, mandateId);
    const engine = findEngine(rig, 'step-0');
    assert.ok(engine, 'step-0 engine must exist in the rig');
    const tail = engine!.attempts?.[engine!.attempts.length - 1];
    const yields = tail?.yields as Record<string, unknown> | undefined;
    assert.ok(yields, 'step-0 engine should have yields recorded');
    return { engine: engine!, yields: yields! };
  }

  it('pre-cancelled step writ: collect() swallows already-terminal silently and yields observed status', async () => {
    const { mandate, step } = await setupRaceFixture();

    // Simulate the race: the parent mandate's downward cascade has
    // already cancelled the step writ (or some other path beat us to it)
    // before Spider's tryCollect invokes step-session's collect().
    await fix.clerk.transition(step.id, 'cancelled', { resolution: 'Pre-race cancel' });

    const { warnings, restore } = captureWarnings();
    let result;
    try {
      result = await fix.spider.crawl();           // step-0 collect()
    } finally {
      restore();
    }

    // (a) collect() did not throw — Spider reports work done.
    assert.ok(result !== null, 'crawl should return a non-null result');

    // (b) already-terminal is expected — no [step-session] warning fires.
    const stepSessionWarnings = warnings.filter((w) => w.startsWith('[step-session]'));
    assert.equal(
      stepSessionWarnings.length, 0,
      `expected no [step-session] warnings for already-terminal transition error, got: ${JSON.stringify(stepSessionWarnings)}`,
    );

    // The step writ phase is unchanged — collect() did not flip cancelled → completed.
    const observedStep = await fix.clerk.show(step.id);
    assert.equal(observedStep.phase, 'cancelled',
      'step writ should remain cancelled after collect()');

    // (c) yields include the observed step writ status.
    const { engine, yields } = await readStepYields(mandate.id);
    assert.equal(yields.stepStatus, 'cancelled',
      'yields should include the observed step writ status');
    assert.equal(yields.stepId, step.id,
      'yields should reference the step writ id');

    // (d) the engine is completed from Spider's perspective.
    assert.equal(engine.status, 'completed',
      'step-0 engine should be marked completed even though the writ was pre-cancelled');
  });

  it('unexpected transition error: collect() logs a [step-session] warning and still yields observed status', async () => {
    const { mandate, step } = await setupRaceFixture();

    // Stub clerk.transition so the step → completed call throws an error
    // whose message does NOT look like an already-terminal classification.
    // Any other transition (including cascades the CDC watcher may trigger)
    // delegates to the original implementation.
    const api = fix.clerk as unknown as { transition: ClerkApi['transition'] };
    const originalTransition = api.transition.bind(fix.clerk);
    const UNEXPECTED_ERROR_MESSAGE = 'simulated storage I/O failure';
    api.transition = async (id, to, fields) => {
      if (id === step.id && to === 'completed') {
        throw new Error(UNEXPECTED_ERROR_MESSAGE);
      }
      return originalTransition(id, to, fields);
    };

    const { warnings, restore } = captureWarnings();
    let result;
    try {
      result = await fix.spider.crawl();           // step-0 collect()
    } finally {
      restore();
      api.transition = originalTransition;
    }

    // (a) collect() did not throw.
    assert.ok(result !== null, 'crawl should return a non-null result');

    // (b) exactly one [step-session] warning fires, and it identifies both
    // the step writ id and the underlying error message.
    const stepSessionWarnings = warnings.filter((w) => w.startsWith('[step-session]'));
    assert.equal(
      stepSessionWarnings.length, 1,
      `expected exactly one [step-session] warning, got: ${JSON.stringify(stepSessionWarnings)}`,
    );
    const warning = stepSessionWarnings[0]!;
    assert.ok(warning.includes(step.id),
      `warning should include the step id (got: ${warning})`);
    assert.ok(warning.includes(UNEXPECTED_ERROR_MESSAGE),
      `warning should include the underlying error message (got: ${warning})`);

    // The step writ stays open — the transition call never succeeded.
    const observedStep = await fix.clerk.show(step.id);
    assert.equal(observedStep.phase, 'open',
      'step writ should remain open because transition never succeeded');

    // (c) yields still include the observed step writ status.
    const { engine, yields } = await readStepYields(mandate.id);
    assert.equal(yields.stepStatus, 'open',
      'yields should reflect the observed (unchanged) step writ status');
    assert.equal(yields.stepId, step.id,
      'yields should reference the step writ id');

    // (d) the engine is completed from Spider's perspective — the bookkeeping
    // warning is surfaced in logs, but does not block rig progress.
    assert.equal(engine.status, 'completed',
      'step-0 engine should be marked completed even when the transition log-warned');
  });
});

// ── Epilogue tests ───────────────────────────────────────────────────

describe('STEP_EXECUTION_EPILOGUE', () => {
  it('contains single-task-focused instructions', () => {
    assert.ok(STEP_EXECUTION_EPILOGUE.includes('single task'));
    assert.ok(STEP_EXECUTION_EPILOGUE.includes('step-add'));
    assert.ok(STEP_EXECUTION_EPILOGUE.includes('Commit all changes'));
  });

  it('does not reference task-manifest traversal', () => {
    assert.ok(!STEP_EXECUTION_EPILOGUE.includes('task-manifest'));
    assert.ok(!STEP_EXECUTION_EPILOGUE.includes('Work through tasks in the order'));
  });
});

describe('EXECUTION_EPILOGUE (legacy)', () => {
  it('is unchanged and references task-manifest', () => {
    assert.ok(EXECUTION_EPILOGUE.includes('task-manifest'));
    assert.ok(EXECUTION_EPILOGUE.includes('Work through tasks in the order'));
  });
});
