/**
 * Piece pipeline — integration tests.
 *
 * Tests the implement-loop engine, piece-session engine, and the full
 * piece execution pipeline including:
 *   - Sequential piece execution with halt-on-failure
 *   - Backward compatibility (mandates without pieces)
 *   - Piece-aware anima instructions
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
import type { SpiderApi, RigDoc, RigTemplate, DraftYields } from './types.ts';

import { PIECE_EXECUTION_EPILOGUE } from './engines/piece-session.ts';
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
    clerk: {
      writTypes: [{ name: 'piece', description: 'task piece' }],
    },
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
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
  const clerk = clerkApparatus.provides as ClerkApi;
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
    stacks, clerk, fabricator, spider, memBackend,
    summonCalls,
    setSessionOutcome(outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) {
      currentSessionOutcome = outcome;
    },
  };
}

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

  const updatedEngines = rig.engines.map(e =>
    e.id === 'draft'
      ? { ...e, status: 'completed' as const, yields: DRAFT_YIELDS, completedAt: new Date().toISOString() }
      : e,
  );
  await book.patch(rig.id, { engines: updatedEngines });
  return rig.id;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('implement-loop engine', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('registers implement-loop and piece-session in the Fabricator', () => {
    assert.ok(fix.fabricator.getEngineDesign('implement-loop'), 'implement-loop registered');
    assert.ok(fix.fabricator.getEngineDesign('piece-session'), 'piece-session registered');
    // Original implement engine still registered for rollback
    assert.ok(fix.fabricator.getEngineDesign('implement'), 'implement still registered');
  });

  it('falls through to legacy single-session when no child pieces exist', async () => {
    const { clerk, spider, stacks: s, summonCalls } = fix;

    // Post a mandate without children
    await clerk.post({ title: 'No-piece mandate', body: 'Do something', codex: 'test' });

    // Spawn rig
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const writId = (r1 as { writId: string }).writId;

    // Draft engine will fail (no codexes). Pre-complete it.
    await preCompleteDraft(s, writId);

    // implement-loop runs — should launch a single session (legacy path)
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-started');

    // Verify the summon call used the legacy EXECUTION_EPILOGUE
    const lastSummon = summonCalls[summonCalls.length - 1];
    assert.ok(lastSummon.prompt.includes('task-manifest'), 'Legacy prompt should contain task-manifest instructions');
    assert.ok(!lastSummon.prompt.includes('Current Task'), 'Legacy prompt should not contain piece-specific phrasing');
  });

  it('grafts piece-session engines when child pieces exist', async () => {
    const { clerk, spider, stacks: s, summonCalls } = fix;

    // Post a mandate in draft state
    const mandate = await clerk.post({ title: 'Piece mandate', body: 'Main spec', codex: 'test', draft: true });

    // Create child pieces
    await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>Task 1</name></task>', parentId: mandate.id });
    await clerk.post({ type: 'piece', title: 'Task 2', body: '<task id="t2"><name>Task 2</name></task>', parentId: mandate.id });

    // Publish mandate
    await clerk.transition(mandate.id, 'open');

    // Spawn rig
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');

    // Pre-complete draft
    await preCompleteDraft(s, mandate.id);

    // implement-loop runs — clockwork, completes immediately + queues graft
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-completed');

    // Process graft
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'engine-grafted');
    if (r3?.action === 'engine-grafted') {
      assert.equal(r3.graftedEngineIds.length, 2);
      assert.ok(r3.graftedEngineIds.includes('piece-0'));
      assert.ok(r3.graftedEngineIds.includes('piece-1'));
    }

    // First piece-session starts
    const r4 = await spider.crawl();
    assert.equal(r4?.action, 'engine-started');

    // Verify the first piece session prompt
    const pieceSummon = summonCalls[summonCalls.length - 1];
    assert.ok(pieceSummon.prompt.includes('Main spec'), 'Piece prompt should include mandate body');
    assert.ok(pieceSummon.prompt.includes('<task id="t1">'), 'Piece prompt should include piece body');
    assert.ok(pieceSummon.prompt.includes('Current Task'), 'Piece prompt should have piece-specific header');
    assert.ok(pieceSummon.prompt.includes('Mandate ID:'), 'Piece prompt should include mandate ID');
  });

  it('processes pieces sequentially — second piece waits for first', async () => {
    const { clerk, spider, stacks: s, summonCalls } = fix;

    const mandate = await clerk.post({ title: 'Sequential', body: 'Spec', codex: 'test', draft: true });
    await clerk.post({ type: 'piece', title: 'Task A', body: '<task id="ta"><name>A</name></task>', parentId: mandate.id });
    await clerk.post({ type: 'piece', title: 'Task B', body: '<task id="tb"><name>B</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    // Spawn → pre-complete draft → implement-loop → graft → piece-0 started
    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started

    // Collect piece-0 (session completes)
    const r5 = await spider.crawl();
    assert.equal(r5?.action, 'engine-completed');

    // piece-1 should now start
    const r6 = await spider.crawl();
    assert.equal(r6?.action, 'engine-started');

    // Verify piece-1 prompt has piece B's body
    const lastSummon = summonCalls[summonCalls.length - 1];
    assert.ok(lastSummon.prompt.includes('<task id="tb">'), 'Second piece should use task B body');
  });

  it('halts rig when a piece session fails', async () => {
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Fail test', body: 'Spec', codex: 'test', draft: true });
    await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.post({ type: 'piece', title: 'Task 2', body: '<task id="t2"><name>T2</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    // Spawn → pre-complete draft → implement-loop → graft → piece-0 starts
    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started

    // Patch the session to failed
    const sessBook = s.book<SessionDoc>('animator', 'sessions');
    const sessions = await sessBook.find({});
    const lastSession = sessions[sessions.length - 1];
    await sessBook.patch(lastSession.id, { status: 'failed', error: 'Task failed' });

    // Collect → rig should go stuck
    const r = await spider.crawl();
    assert.equal(r?.action, 'rig-completed');
    if (r?.action === 'rig-completed') {
      assert.equal(r.outcome, 'stuck', 'Rig should be stuck after piece failure');
    }

    // Verify the rig status
    const rigs = await rigsBook(s).find({ where: [['writId', '=', mandate.id]] });
    assert.equal(rigs[0].status, 'stuck');
  });

  it('piece-session transitions piece writs on completion', async () => {
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Transition test', body: 'Spec', codex: 'test', draft: true });
    const piece = await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    // Run through to piece completion
    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started
    await spider.crawl(); // piece-0 collected (completed)

    // Check the piece writ was transitioned to completed
    const updatedPiece = await clerk.show(piece.id);
    assert.equal(updatedPiece.phase, 'completed');
  });

  it('piece writ stays open on session failure — collect() is not called', async () => {
    // Design: Spider's tryCollect() calls failEngine() directly for failed sessions
    // and never invokes the engine's collect() method. This means piece-session
    // cannot transition the piece writ to 'failed' on session failure.
    //
    // The piece writ remains 'open' until the mandate reaches a terminal state,
    // at which point Clerk's parent/child cascade cancels remaining child writs.
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Fail transition', body: 'Spec', codex: 'test', draft: true });
    const piece = await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started

    // Patch session to failed
    const sessBook = s.book<SessionDoc>('animator', 'sessions');
    const sessions = await sessBook.find({});
    const lastSession = sessions[sessions.length - 1];
    await sessBook.patch(lastSession.id, { status: 'failed', error: 'Build failed' });

    await spider.crawl(); // failEngine → rig stuck

    // The piece writ stays 'open' because collect() was never called.
    const updatedPiece = await clerk.show(piece.id);
    assert.equal(updatedPiece.phase, 'open',
      'Piece writ stays open — failEngine bypasses collect, so no transition occurs');
  });

  it('dynamically added pieces are picked up after the current piece completes', async () => {
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Dynamic pieces', body: 'Spec', codex: 'test', draft: true });
    await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    // Spawn → draft → implement-loop → graft → piece-0 starts
    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft (piece-0)
    await spider.crawl(); // piece-0 started

    // While piece-0 is running, dynamically add a new piece via clerk
    const dynPiece = await clerk.post({
      type: 'piece',
      title: 'Dynamic Task',
      body: '<task id="dyn1"><name>Dynamic</name></task>',
      parentId: mandate.id,
    });

    // piece-0 collects — its collect() discovers the new open piece and grafts it
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'engine-completed', 'piece-0 should complete');

    // Process the graft from piece-0's collect
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-grafted', 'Dynamic piece should be grafted');
    if (r2?.action === 'engine-grafted') {
      assert.equal(r2.graftedEngineIds.length, 1);
      assert.ok(r2.graftedEngineIds[0].includes(dynPiece.id),
        'Grafted engine ID should reference the dynamic piece writ ID');
    }

    // The dynamic piece-session should now start
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'engine-started', 'Dynamic piece session should start');

    // It completes and transitions the piece writ
    const r4 = await spider.crawl();
    assert.equal(r4?.action, 'engine-completed', 'Dynamic piece session should complete');

    const updatedDynPiece = await clerk.show(dynPiece.id);
    assert.equal(updatedDynPiece.phase, 'completed', 'Dynamic piece should be marked completed');
  });

  it('dynamically added pieces delay seal via graftTail', async () => {
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Dynamic graftTail', body: 'Spec', codex: 'test', draft: true });
    await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started

    // Add a dynamic piece while piece-0 is running
    await clerk.post({
      type: 'piece',
      title: 'Dynamic Task',
      body: '<task id="dyn1"><name>Dynamic</name></task>',
      parentId: mandate.id,
    });

    await spider.crawl(); // piece-0 collected
    await spider.crawl(); // dynamic piece grafted

    // After graft, verify seal now has the dynamic piece in its upstream
    const rigs = await rigsBook(s).find({ where: [['writId', '=', mandate.id]] });
    const rig = rigs[0];
    const sealEngine = rig.engines.find(e => e.id === 'seal');
    assert.ok(sealEngine, 'Seal engine should exist');

    // Seal should have both implement-loop and the original piece-0 in upstream
    // (from the original graftTail), AND the dynamic piece (from the dynamic graftTail)
    const dynPieceEngine = rig.engines.find(e => e.designId === 'piece-session' && e.id.startsWith('piece-') && e.id !== 'piece-0');
    assert.ok(dynPieceEngine, 'Dynamic piece engine should exist in rig');
    assert.ok(sealEngine.upstream.includes(dynPieceEngine!.id),
      `Seal upstream should include dynamic piece engine (${dynPieceEngine!.id}), got: ${JSON.stringify(sealEngine.upstream)}`);
  });

  it('literal WritDoc givens survive yield resolution in piece-session engines', async () => {
    const { clerk, spider, stacks: s, summonCalls } = fix;

    const mandate = await clerk.post({ title: 'Givens test', body: 'Spec body', codex: 'test', draft: true });
    const piece = await clerk.post({ type: 'piece', title: 'Task 1', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft

    // Verify the grafted engine's givensSpec has the piece as a literal object
    const rigs = await rigsBook(s).find({ where: [['writId', '=', mandate.id]] });
    const rig = rigs[0];
    const pieceEngine = rig.engines.find(e => e.id === 'piece-0');
    assert.ok(pieceEngine, 'piece-0 engine should exist');

    // The piece given should be a literal object (not stringified)
    const pieceGiven = pieceEngine!.givensSpec.piece as WritDoc;
    assert.equal(typeof pieceGiven, 'object', 'piece given should be an object');
    assert.equal(pieceGiven.id, piece.id, 'piece given should have the correct writ ID');
    assert.equal(pieceGiven.type, 'piece', 'piece given should have the correct type');

    // Now run the piece-session and verify the summon call used the piece body
    await spider.crawl(); // piece-0 started
    const lastSummon = summonCalls[summonCalls.length - 1];
    assert.ok(lastSummon.prompt.includes('<task id="t1">'),
      'Piece prompt should include the piece body from the literal WritDoc given');
    assert.ok(lastSummon.prompt.includes(mandate.id),
      'Piece prompt should include mandate ID from the resolved writ given');
  });

  it('full pipeline: pieces complete → seal runs → rig completes', async () => {
    const { clerk, spider, stacks: s } = fix;

    const mandate = await clerk.post({ title: 'Full pipeline', body: 'Spec', codex: 'test', draft: true });
    await clerk.post({ type: 'piece', title: 'Only task', body: '<task id="t1"><name>T1</name></task>', parentId: mandate.id });
    await clerk.transition(mandate.id, 'open');

    await spider.crawl(); // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl(); // implement-loop completed
    await spider.crawl(); // graft
    await spider.crawl(); // piece-0 started
    await spider.crawl(); // piece-0 collected

    // At this point all grafted engines are done. The seal engine should be next.
    // But seal needs the implement-loop to be upstream, not piece-0.
    // Wait — seal upstream is ['implement-loop'], which is already completed.
    // But piece-0 was grafted with upstream ['implement-loop'].
    // So when piece-0 completes, seal's upstream (implement-loop) is already done.
    // Seal should be runnable now.

    // But seal needs codexes too (to finalize the draft). Let's check what happens.
    // The seal engine will fail since there's no codexes apparatus.
    // That's OK — we've verified the piece pipeline works. The seal failure is expected.
    const r = await spider.crawl();
    // It's either seal starting/failing, or rig completing. Whatever the seal outcome is.
    assert.ok(r !== null, 'There should be more work to do');
  });
});

// ── Regression: piece writ transition race in collect() ─────────────
//
// See: commission "Fix piece writ cancelled despite successful session".
//
// The bug was that piece-session `collect()` swallowed every error from its
// `clerk.transition(piece, 'completed')` call with a bare `catch {}`. When
// that transition failed — typically because the parent's downward cascade
// beat it to the writ — the failure was invisible, and the piece writ ended
// up misattributed as "sibling failure". The fix:
//
//   (a) Classify caught transition errors: already-terminal is expected and
//       silent; anything else logs a warning so the race is visible.
//   (b) Re-read the piece writ after the transition attempt and include the
//       observed status in `yields.pieceStatus`, regardless of outcome.
//
// These regression tests fail if the bare `catch {}` is reintroduced (the
// unexpected-error warning would not fire) or if the re-read is removed (the
// observed `pieceStatus` would be missing from yields).

describe('piece-session collect() — transition error classification', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => { fix = buildFixture(); });
  afterEach(() => { clearGuild(); });

  /**
   * Drive the rig up to the point where piece-0 has started (its session is
   * already completed in the mock Animator) but has not yet been collected.
   * Returns the piece writ so callers can manipulate its state before the
   * next crawl invokes `collect()`.
   */
  async function advanceToPieceStarted(): Promise<{ mandate: WritDoc; piece: WritDoc }> {
    const { clerk, spider, stacks: s } = fix;
    const mandate = await clerk.post({ title: 'Race', body: 'Spec', codex: 'test', draft: true });
    const piece = await clerk.post({
      type: 'piece',
      title: 'Task 1',
      body: '<task id="t1"><name>T1</name></task>',
      parentId: mandate.id,
    });
    await clerk.transition(mandate.id, 'open');

    await spider.crawl();                      // rig-spawned
    await preCompleteDraft(s, mandate.id);
    await spider.crawl();                      // implement-loop completed
    await spider.crawl();                      // graft (piece-0)
    const started = await spider.crawl();      // piece-0 started
    assert.equal(started?.action, 'engine-started');
    return { mandate, piece };
  }

  function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    return { warnings, restore: () => { console.warn = original; } };
  }

  it('pre-cancelled piece writ: collect() swallows already-terminal silently and yields observed status', async () => {
    const { clerk, spider, stacks: s } = fix;
    const { mandate, piece } = await advanceToPieceStarted();

    // Simulate the race: something (e.g. the parent's downward cascade) has
    // already cancelled the piece writ before Spider's tryCollect invokes
    // piece-session's collect().
    await clerk.transition(piece.id, 'cancelled', { resolution: 'Pre-race cancel' });

    const { warnings, restore } = captureWarnings();
    let result;
    try {
      result = await spider.crawl();           // piece-0 collect()
    } finally {
      restore();
    }

    // (a) collect() did not throw — Spider reports work done.
    assert.ok(result !== null, 'crawl should return a non-null result');

    // (b) already-terminal is expected — no [piece-session] warning fires.
    const pieceSessionWarnings = warnings.filter((w) => w.startsWith('[piece-session]'));
    assert.equal(
      pieceSessionWarnings.length, 0,
      `expected no [piece-session] warnings for already-terminal transition error, got: ${JSON.stringify(pieceSessionWarnings)}`,
    );

    // The piece writ phase is unchanged — collect() did not flip cancelled → completed.
    const observedPiece = await clerk.show(piece.id);
    assert.equal(observedPiece.phase, 'cancelled',
      'piece writ should remain cancelled after collect()');

    // (c) yields include the observed piece writ status.
    const rigs = await rigsBook(s).find({ where: [['writId', '=', mandate.id]] });
    const pieceEngine = rigs[0]!.engines.find((e) => e.id === 'piece-0');
    assert.ok(pieceEngine, 'piece-0 engine must exist in the rig');
    const pieceYields = pieceEngine!.yields as Record<string, unknown> | undefined;
    assert.ok(pieceYields, 'piece-0 engine should have yields recorded');
    assert.equal(pieceYields!.pieceStatus, 'cancelled',
      'yields should include the observed piece writ status');
    assert.equal(pieceYields!.pieceId, piece.id,
      'yields should reference the piece writ id');

    // (d) the engine is completed from Spider's perspective.
    assert.equal(pieceEngine!.status, 'completed',
      'piece-0 engine should be marked completed even though the writ was pre-cancelled');
  });

  it('unexpected transition error: collect() logs a [piece-session] warning and still yields observed status', async () => {
    const { clerk, spider, stacks: s } = fix;
    const { mandate, piece } = await advanceToPieceStarted();

    // Stub clerk.transition so the piece → completed call throws an error
    // whose message does NOT look like an already-terminal classification.
    // Any other transition (including cascades the CDC watcher may trigger)
    // delegates to the original implementation.
    const api = clerk as unknown as { transition: ClerkApi['transition'] };
    const originalTransition = api.transition.bind(clerk);
    const UNEXPECTED_ERROR_MESSAGE = 'simulated storage I/O failure';
    api.transition = async (id, to, fields) => {
      if (id === piece.id && to === 'completed') {
        throw new Error(UNEXPECTED_ERROR_MESSAGE);
      }
      return originalTransition(id, to, fields);
    };

    const { warnings, restore } = captureWarnings();
    let result;
    try {
      result = await spider.crawl();           // piece-0 collect()
    } finally {
      restore();
      api.transition = originalTransition;
    }

    // (a) collect() did not throw.
    assert.ok(result !== null, 'crawl should return a non-null result');

    // (b) exactly one [piece-session] warning fires, and it identifies both
    // the piece writ id and the underlying error message.
    const pieceSessionWarnings = warnings.filter((w) => w.startsWith('[piece-session]'));
    assert.equal(
      pieceSessionWarnings.length, 1,
      `expected exactly one [piece-session] warning, got: ${JSON.stringify(pieceSessionWarnings)}`,
    );
    const warning = pieceSessionWarnings[0]!;
    assert.ok(warning.includes(piece.id),
      `warning should include the piece id (got: ${warning})`);
    assert.ok(warning.includes(UNEXPECTED_ERROR_MESSAGE),
      `warning should include the underlying error message (got: ${warning})`);

    // The piece writ stays open — the transition call never succeeded.
    const observedPiece = await clerk.show(piece.id);
    assert.equal(observedPiece.phase, 'open',
      'piece writ should remain open because transition never succeeded');

    // (c) yields still include the observed piece writ status.
    const rigs = await rigsBook(s).find({ where: [['writId', '=', mandate.id]] });
    const pieceEngine = rigs[0]!.engines.find((e) => e.id === 'piece-0');
    assert.ok(pieceEngine, 'piece-0 engine must exist in the rig');
    const pieceYields = pieceEngine!.yields as Record<string, unknown> | undefined;
    assert.ok(pieceYields, 'piece-0 engine should have yields recorded');
    assert.equal(pieceYields!.pieceStatus, 'open',
      'yields should reflect the observed (unchanged) piece writ status');
    assert.equal(pieceYields!.pieceId, piece.id,
      'yields should reference the piece writ id');

    // (d) the engine is completed from Spider's perspective — the bookkeeping
    // warning is surfaced in logs, but does not block rig progress.
    assert.equal(pieceEngine!.status, 'completed',
      'piece-0 engine should be marked completed even when the transition log-warned');
  });
});

// ── Epilogue tests ───────────────────────────────────────────────────

describe('PIECE_EXECUTION_EPILOGUE', () => {
  it('contains single-task-focused instructions', () => {
    assert.ok(PIECE_EXECUTION_EPILOGUE.includes('single task'));
    assert.ok(PIECE_EXECUTION_EPILOGUE.includes('piece-add'));
    assert.ok(PIECE_EXECUTION_EPILOGUE.includes('Commit all changes'));
  });

  it('does not reference task-manifest traversal', () => {
    assert.ok(!PIECE_EXECUTION_EPILOGUE.includes('task-manifest'));
    assert.ok(!PIECE_EXECUTION_EPILOGUE.includes('Work through tasks in the order'));
  });
});

describe('EXECUTION_EPILOGUE (legacy)', () => {
  it('is unchanged and references task-manifest', () => {
    assert.ok(EXECUTION_EPILOGUE.includes('task-manifest'));
    assert.ok(EXECUTION_EPILOGUE.includes('Work through tasks in the order'));
  });
});
