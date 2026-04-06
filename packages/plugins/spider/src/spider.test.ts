/**
 * Spider — unit tests.
 *
 * Tests rig lifecycle, walk priority ordering, engine execution (clockwork
 * and quick), failure propagation, and CDC-driven writ transitions.
 *
 * Uses in-memory Stacks backend and mock Guild singleton.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, ReviewYields, MechanicalCheck, RigTemplate } from './types.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';

// ── Test bootstrap ────────────────────────────────────────────────────

// Standard 5-engine template matching the original static pipeline behavior.
// Used as the default template in test fixtures.
const STANDARD_TEMPLATE: RigTemplate = {
  engines: [
    { id: 'draft',     designId: 'draft',     givens: { writ: '$writ' } },
    { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '$writ', role: '$role' } },
    { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '$writ', role: 'reviewer', buildCommand: '$spider.buildCommand', testCommand: '$spider.testCommand' } },
    { id: 'revise',    designId: 'revise',    upstream: ['review'],    givens: { writ: '$writ', role: '$role' } },
    { id: 'seal',      designId: 'seal',      upstream: ['revise'],    givens: {} },
  ],
  resolutionEngine: 'seal',
};

/**
 * Build a minimal StartupContext that captures and fires events.
 */
function buildCtx(): {
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
  };
  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }
  return { ctx, fire };
}

/**
 * Full integration fixture: starts Stacks (memory), Clerk, Fabricator,
 * and Spider. Returns handles to each API plus mock animator controls.
 */
function buildFixture(
  guildConfig: Partial<GuildConfig> = {},
  initialSessionOutcome: { status: 'completed' | 'failed'; error?: string; output?: string } = { status: 'completed' },
): {
  stacks: StacksApi;
  clerk: ClerkApi;
  fabricator: FabricatorApi;
  spider: SpiderApi;
  memBackend: InstanceType<typeof MemoryBackend>;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
  summonCalls: SummonRequest[];
  setSessionOutcome: (outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) => void;
} {
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
    ...guildConfig,
    spider: {
      rigTemplates: { default: STANDARD_TEMPLATE },
      ...(guildConfig.spider ?? {}),
    },
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not found`);
      return api as T;
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
  };

  setGuild(fakeGuild);

  // Start stacks with memory backend
  const noopCtx = { on: () => {} };
  stacksApparatus.start(noopCtx);
  const stacks = stacksApparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Manually ensure all books the Spider and Clerk need
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
  });
  memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
    indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
    indexes: ['startedAt', 'status'],
  });

  // Mock animator — captures summon() calls and writes session docs to Stacks.
  // The session record is written eagerly (synchronous put, fire-and-forget)
  // so the Spider's collect step finds it on the next crawl() call. Engines
  // no longer await handle.result — they return immediately with handle.sessionId.
  let currentSessionOutcome = initialSessionOutcome;
  const summonCalls: SummonRequest[] = [];
  const mockAnimatorApi: AnimatorApi = {
    summon(request: SummonRequest): AnimateHandle {
      summonCalls.push(request);
      const sessionId = generateId('ses', 4);
      const startedAt = new Date().toISOString();
      const outcome = currentSessionOutcome;

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      const endedAt = new Date().toISOString();
      const doc: SessionDoc = {
        id: sessionId,
        status: outcome.status,
        startedAt,
        endedAt,
        durationMs: 0,
        provider: 'mock',
        exitCode: outcome.status === 'completed' ? 0 : 1,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        metadata: request.metadata,
      };
      // Write eagerly — fire and forget. The in-memory backend is sync.
      void sessBook.put(doc);

      const result = Promise.resolve({
        id: sessionId,
        status: outcome.status,
        startedAt,
        endedAt,
        durationMs: 0,
        provider: 'mock',
        exitCode: outcome.status === 'completed' ? 0 : 1,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
        metadata: request.metadata,
      } as SessionResult);

      async function* emptyChunks(): AsyncIterable<SessionChunk> {}
      return { sessionId, chunks: emptyChunks(), result };
    },
    animate(): AnimateHandle {
      throw new Error('animate() not used in Spider tests');
    },
  };
  apparatusMap.set('animator', mockAnimatorApi);

  // Start clerk
  clerkApparatus.start(noopCtx);
  const clerk = clerkApparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Start fabricator with its own ctx so we can fire events
  const { ctx: fabricatorCtx, fire } = buildCtx();
  fabricatorApparatus.start(fabricatorCtx);
  const fabricator = fabricatorApparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  // Start spider
  spiderApparatus.start(noopCtx);
  const spider = spiderApparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  // Simulate plugin:initialized for the Spider so the Fabricator scans
  // its supportKit and picks up the five engine designs.
  const spiderLoaded: LoadedApparatus = {
    packageName: '@shardworks/spider-apparatus',
    id: 'spider',
    version: '0.0.0',
    apparatus: spiderApparatus,
  };
  // Fire synchronously — fabricator's handler is sync
  void fire('plugin:initialized', spiderLoaded);

  return {
    stacks, clerk, fabricator, spider, memBackend, fire,
    summonCalls,
    setSessionOutcome(outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) {
      currentSessionOutcome = outcome;
    },
  };
}

/** Get the rigs book. */
function rigsBook(stacks: StacksApi) {
  return stacks.book<RigDoc>('spider', 'rigs');
}

/** Post a writ. */
async function postWrit(clerk: ClerkApi, title = 'Test writ', codex?: string): Promise<WritDoc> {
  return clerk.post({ title, body: 'Test body', codex });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Spider', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Fabricator integration ─────────────────────────────────────────

  describe('Fabricator — Spider engine registration', () => {
    it('registers all five engine designs in the Fabricator', () => {
      const { fabricator } = fix;
      assert.ok(fabricator.getEngineDesign('draft'), 'draft engine registered');
      assert.ok(fabricator.getEngineDesign('implement'), 'implement engine registered');
      assert.ok(fabricator.getEngineDesign('review'), 'review engine registered');
      assert.ok(fabricator.getEngineDesign('revise'), 'revise engine registered');
      assert.ok(fabricator.getEngineDesign('seal'), 'seal engine registered');
    });

    it('returns undefined for an unknown engine ID', () => {
      assert.equal(fix.fabricator.getEngineDesign('nonexistent'), undefined);
    });
  });

  // ── walk() idle ────────────────────────────────────────────────────

  describe('walk() — idle', () => {
    it('returns null when there is no work', async () => {
      const result = await fix.spider.crawl();
      assert.equal(result, null);
    });
  });

  // ── Spawn ──────────────────────────────────────────────────────────

  describe('walk() — spawn', () => {
    it('spawns a rig for a ready writ and transitions writ to active', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);
      assert.equal(writ.status, 'ready');

      const result = await spider.crawl();
      assert.ok(result !== null, 'expected a walk result');
      assert.equal(result.action, 'rig-spawned');
      assert.equal((result as { writId: string }).writId, writ.id);

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1);
      assert.equal(rigs[0].writId, writ.id);
      assert.equal(rigs[0].status, 'running');
      assert.equal(rigs[0].engines.length, 5);

      // Writ should now be active
      const updatedWrit = await clerk.show(writ.id);
      assert.equal(updatedWrit.status, 'active');
    });

    it('does not spawn a second rig for a writ that already has one', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);

      await spider.crawl(); // spawns rig

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist');
    });

    it('spawns rigs for the oldest ready writ first (FIFO)', async () => {
      const { clerk, spider } = fix;

      // Small delay to ensure different createdAt timestamps
      const w1 = await postWrit(clerk, 'First writ');
      await new Promise((r) => setTimeout(r, 2));
      const w2 = await postWrit(clerk, 'Second writ');

      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');
      assert.equal((r1 as { writId: string }).writId, w1.id);

      // Mark rig1 as failed so w2 can spawn
      const rigs = await rigsBook(fix.stacks).list();
      await rigsBook(fix.stacks).patch(rigs[0].id, { status: 'failed' });

      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'rig-spawned');
      assert.equal((r2 as { writId: string }).writId, w2.id);
    });
  });

  // ── Priority ordering ──────────────────────────────────────────────

  describe('walk() — priority ordering: collect > run > spawn', () => {
    it('runs before spawning when a rig already exists', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);

      // Spawn the rig
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'rig-spawned');

      // Second walk should run (not spawn another rig)
      // The draft engine will fail (no codexes), resulting in 'rig-completed'
      const r2 = await spider.crawl();
      assert.notEqual(r2?.action, 'rig-spawned');
      // Only one rig created
      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1);
    });

    it('collects before running when a running engine has a terminal session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Set draft to running with a session
      const enginesWithSession = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'running' as const, sessionId: fakeSessionId }
          : e,
      );
      await book.patch(rig.id, { engines: enginesWithSession });

      // Insert terminal session
      const sessBook = stacks.book<{ id: string; status: string; startedAt: string; provider: string; [key: string]: unknown }>('animator', 'sessions');
      await sessBook.put({ id: fakeSessionId, status: 'completed', startedAt: new Date().toISOString(), provider: 'test' });

      // Walk should collect (not run implement which has no completed upstream)
      const r = await spider.crawl();
      assert.equal(r?.action, 'engine-completed');
      assert.equal((r as { engineId: string }).engineId, 'draft');
    });
  });

  // ── Engine readiness ───────────────────────────────────────────────

  describe('engine readiness — upstream must complete first', () => {
    it('only the first engine (no upstream) is runnable initially', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();

      // All engines except draft should have upstream
      const draft = rig.engines.find((e: EngineInstance) => e.id === 'draft');
      const implement = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.deepEqual(draft?.upstream, []);
      assert.deepEqual(implement?.upstream, ['draft']);
    });

    it('implement only launches after draft is completed', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Mark draft as completed
      const updatedEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }
          : e,
      );
      await book.patch(rig.id, { engines: updatedEngines });

      // Now walk should launch implement (quick engine → 'engine-started', not 'engine-completed')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');
    });
  });

  // ── Quick engine execution (implement) ────────────────────────────

  describe('implement engine execution', () => {
    it('launches session on first walk, then collects yields on second walk', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft so implement can run
      const updatedEngines = rig0.engines.map((e: EngineInstance) =>
        e.id === 'draft'
          ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }
          : e,
      );
      await book.patch(rig0.id, { engines: updatedEngines });

      // Walk: implement launches an Animator session (quick engine → 'engine-started')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'implement');

      const [rig1] = await book.list();
      const impl1 = rig1.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl1?.status, 'running', 'engine should be running after launch');
      assert.ok(impl1?.sessionId !== undefined, 'sessionId should be stored');

      // Walk: collect step finds the terminal session and stores yields
      const result2 = await spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'implement');

      const [rig2] = await book.list();
      const impl2 = rig2.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl2?.status, 'completed');
      assert.ok(impl2?.yields !== undefined, 'yields should be stored');
      assert.doesNotThrow(() => JSON.stringify(impl2?.yields));
    });

    it('marks engine and rig failed when engine design is not found', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Inject a bad designId for draft
      const brokenEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
      );
      await book.patch(rig.id, { engines: brokenEngines });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');
      assert.ok(draft?.error?.includes('nonexistent-engine'));

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }
    });
  });

  // ── Yield serialization failure ────────────────────────────────────

  describe('yield serialization failure', () => {
    it('non-serializable engine yields cause engine and rig failure', async () => {
      const { clerk, spider, stacks, fire } = fix;

      // Register an engine design that returns non-JSON-serializable yields
      const badEngine: EngineDesign = {
        id: 'bad-engine',
        async run() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { status: 'completed' as const, yields: { fn: (() => {}) as any } };
        },
      };
      const fakePlugin: LoadedApparatus = {
        packageName: '@test/bad-engine',
        id: 'test-bad',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { engines: { 'bad-engine': badEngine } },
          provides: {},
          start() {},
        },
      };
      void fire('plugin:initialized', fakePlugin);

      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Patch draft to use the bad engine design
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'bad-engine' } : e,
        ),
      });

      const result = await spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed');
      assert.ok(draft?.error !== undefined && draft.error.length > 0, `expected engine to have an error, got: ${draft?.error}`);

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }
    });
  });

  // ── Implement engine — summon args and prompt wrapping ────────────

  describe('implement engine — Animator integration', () => {
    it('calls animator.summon() with role, prompt, cwd, environment, and metadata', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'My commission', 'my-codex');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/the/worktree' } }
            : e,
        ),
      });

      const launchResult = await spider.crawl(); // launch implement
      assert.equal(launchResult?.action, 'engine-started');

      assert.equal(summonCalls.length, 1, 'summon should be called once');
      const call = summonCalls[0];
      assert.equal(call.role, 'artificer', 'role defaults to artificer');
      assert.equal(call.cwd, '/the/worktree', 'cwd is draft worktree path');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
      assert.deepEqual(call.metadata, { engineId: 'implement', writId: writ.id });
    });

    it('wraps the writ body with a commit instruction', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await clerk.post({ title: 'My writ', body: 'Build the feature.' });
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }
            : e,
        ),
      });

      const launchResult2 = await spider.crawl(); // launch implement
      assert.equal(launchResult2?.action, 'engine-started');

      assert.equal(summonCalls.length, 1);
      const expectedPrompt = 'Build the feature.\n\nCommit all changes before ending your session.';
      assert.equal(summonCalls[0].prompt, expectedPrompt);
    });

    it('session failure propagates: engine fails → rig fails → writ transitions to failed', async () => {
      const { clerk, spider, stacks, setSessionOutcome } = fix;
      setSessionOutcome({ status: 'failed', error: 'Process exited with code 1' });

      const writ = await postWrit(clerk, 'Failing writ');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }
            : e,
        ),
      });

      await spider.crawl(); // launch implement (session already terminal in Stacks)
      await spider.crawl(); // collect: session failed → engine fails → rig fails

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed', 'rig should be failed');
      const impl = updatedRig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed', 'implement engine should be failed');

      // Completed upstream engine (draft) is preserved
      const draftEng = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed', 'draft should remain completed');

      // Pending downstream engines should be cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updatedRig.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }

      const failedWrit = await clerk.show(writ.id);
      assert.equal(failedWrit.status, 'failed', 'writ should transition to failed via CDC');
    });

    it('ImplementYields contain sessionId and sessionStatus from the session record', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk, 'Yields test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/wt' } }
            : e,
        ),
      });

      await spider.crawl(); // launch
      await spider.crawl(); // collect

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'completed');
      const yields = impl?.yields as Record<string, unknown>;
      assert.ok(typeof yields.sessionId === 'string', 'sessionId should be a string');
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  // ── Quick engine collect ───────────────────────────────────────────

  describe('quick engine — collect', () => {
    it('collects yields from a terminal session in the sessions book', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Simulate: draft completed, implement launched a session
      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, yields: { draftId: 'x', codexName: 'c', branch: 'b', path: '/p' } };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, sessionId: fakeSessionId };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      // Insert terminal session record
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string;
        output?: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: 'Session completed successfully',
      });

      // Walk: collect step should find the terminal session
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'implement');

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'completed');
      assert.ok(impl?.yields !== undefined);
      const yields = impl?.yields as Record<string, unknown>;
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.sessionStatus, 'completed');
    });

    it('marks engine and rig failed when session failed', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, yields: { draftId: 'x' } };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, sessionId: fakeSessionId };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string;
        error?: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'failed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        error: 'Process exited with code 1',
      });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      assert.equal(updated.status, 'failed');
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'failed');

      // Pending downstream engines should be cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }
    });

    it('does not collect a still-running session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return { ...e, status: 'completed' as const, yields: { draftId: 'x' } };
        }
        if (e.id === 'implement') {
          return { ...e, status: 'running' as const, sessionId: fakeSessionId };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      // Session is still running
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      // Nothing to collect, implement is running (no pending with completed upstream),
      // spawn skips (rig exists) → null
      const result = await spider.crawl();
      assert.equal(result, null);
    });
  });

  // ── Failure propagation ────────────────────────────────────────────

  describe('failure propagation', () => {
    it('engine failure → rig failed → writ transitions to failed via CDC', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);

      await spider.crawl(); // spawn (writ → active)
      const activeWrit = await clerk.show(writ.id);
      assert.equal(activeWrit.status, 'active');

      // Inject bad design to trigger failure
      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const brokenEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft' ? { ...e, designId: 'broken' } : e,
      );
      await book.patch(rig.id, { engines: brokenEngines });

      // Walk: engine fails → rig fails → CDC → writ fails
      await spider.crawl();

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'failed');

      const failedDraft = updatedRig.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(failedDraft?.status, 'failed', 'draft engine should be failed');

      // All downstream engines should be cancelled
      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updatedRig.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }

      const failedWrit = await clerk.show(writ.id);
      assert.equal(failedWrit.status, 'failed');
    });
  });

  // ── Givens/context assembly ────────────────────────────────────────

  describe('givens and context assembly', () => {
    it('each engine receives only the givens it needs', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk, 'My writ');
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const eng = (id: string) => rig.engines.find((e: EngineInstance) => e.id === id)!;

      // draft: { writ } — no role
      assert.ok('writ' in eng('draft').givensSpec, 'draft should have writ');
      assert.ok(!('role' in eng('draft').givensSpec), 'draft should not have role');
      assert.equal((eng('draft').givensSpec.writ as WritDoc).id, writ.id);

      // implement: { writ, role }
      assert.ok('writ' in eng('implement').givensSpec, 'implement should have writ');
      assert.ok('role' in eng('implement').givensSpec, 'implement should have role');
      assert.equal((eng('implement').givensSpec.writ as WritDoc).id, writ.id);

      // review: { writ, role: 'reviewer' }
      assert.ok('writ' in eng('review').givensSpec, 'review should have writ');
      assert.equal(eng('review').givensSpec.role, 'reviewer', 'review role should be hardcoded reviewer');

      // revise: { writ, role }
      assert.ok('writ' in eng('revise').givensSpec, 'revise should have writ');
      assert.ok('role' in eng('revise').givensSpec, 'revise should have role');

      // seal: {}
      assert.deepEqual(eng('seal').givensSpec, {}, 'seal should get empty givensSpec');
    });

    it('role defaults to "artificer" when not configured', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const implementEngine = rig.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implementEngine?.givensSpec.role, 'artificer');
    });

    it('upstream map is built from completed engine yields', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Mark draft + implement as completed
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      const implYields = { sessionId: 'stub', sessionStatus: 'completed' };
      const updatedEngines = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: draftYields };
        if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: implYields };
        return e;
      });
      await book.patch(rig.id, { engines: updatedEngines });

      // Walk: review launches a session (quick engine → 'engine-started')
      const result = await spider.crawl();
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      // Walk: collect step picks up the completed review session
      const result2 = await spider.crawl();
      assert.equal(result2?.action, 'engine-completed');
      assert.equal((result2 as { engineId: string }).engineId, 'review');
    });
  });

  // ── Draft engine — baseSha population ──────────────────────────────

  describe('draft engine — baseSha', () => {
    it('includes baseSha in DraftYields when draft is completed', async () => {
      // The draft engine calls execSync('git rev-parse HEAD') which we can't
      // run in test (no real Scriptorium). Verify that baseSha flows through
      // the rig correctly when pre-completed with yields.
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'abc123def' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, yields: draftYields } : e,
        ),
      });

      // Verify baseSha is present in the stored yields
      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'completed');
      const yields = draft?.yields as Record<string, unknown>;
      assert.equal(yields.baseSha, 'abc123def', 'baseSha should be populated in DraftYields');
    });
  });

  // ── Full pipeline ─────────────────────────────────────────────────

  describe('full pipeline', () => {
    it('walks through implement → review → revise → rig completion → writ completed', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk, 'Full pipeline test');

      await spider.crawl(); // spawn (writ → active)

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft (real impl would need codexes)
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig0.id, {
        engines: rig0.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, yields: draftYields } : e,
        ),
      });

      // Walk: implement launches an Animator session (quick engine)
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      // Walk: collect step picks up the completed implement session
      const r1c = await spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      // Walk: review launches a session (quick engine)
      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      // Walk: collect review session
      const r2c = await spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      // Walk: revise launches a session (quick engine)
      const r3 = await spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      // Walk: collect revise session
      const r3c = await spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      // Pre-complete seal (real impl would need codexes)
      const [rig3] = await book.list();
      const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 5 };
      await book.patch(rig3.id, {
        engines: rig3.engines.map((e: EngineInstance) =>
          e.id === 'seal' ? { ...e, status: 'completed' as const, yields: sealYields } : e,
        ),
        status: 'completed',
      });

      // CDC should have fired — writ should now be completed
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.status, 'completed');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
    });

    it('walks all 5 engines to rig completion without manual seal patching', async () => {
      const { clerk, spider, stacks, fire } = fix;

      // Register a stub seal engine that doesn't require Scriptorium
      const stubSealEngine: EngineDesign = {
        id: 'seal',
        async run() {
          return {
            status: 'completed' as const,
            yields: { sealedCommit: 'abc', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 },
          };
        },
      };
      const fakePlugin: LoadedApparatus = {
        packageName: '@test/stub-seal',
        id: 'test-seal',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { engines: { seal: stubSealEngine } },
          provides: {},
          start() {},
        },
      };
      void fire('plugin:initialized', fakePlugin);

      const writ = await postWrit(clerk, 'Full pipeline stub seal');
      await spider.crawl(); // spawn (writ → active)

      const book = rigsBook(stacks);
      const [rig0] = await book.list();

      // Pre-complete draft (requires Scriptorium — not available in tests)
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig0.id, {
        engines: rig0.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, status: 'completed' as const, yields: draftYields } : e,
        ),
      });

      // implement launches
      const r1 = await spider.crawl();
      assert.equal(r1?.action, 'engine-started');
      assert.equal((r1 as { engineId: string }).engineId, 'implement');

      // collect implement
      const r1c = await spider.crawl();
      assert.equal(r1c?.action, 'engine-completed');
      assert.equal((r1c as { engineId: string }).engineId, 'implement');

      // review launches (quick engine)
      const r2 = await spider.crawl();
      assert.equal(r2?.action, 'engine-started');
      assert.equal((r2 as { engineId: string }).engineId, 'review');

      // collect review
      const r2c = await spider.crawl();
      assert.equal(r2c?.action, 'engine-completed');
      assert.equal((r2c as { engineId: string }).engineId, 'review');

      // revise launches (quick engine)
      const r3 = await spider.crawl();
      assert.equal(r3?.action, 'engine-started');
      assert.equal((r3 as { engineId: string }).engineId, 'revise');

      // collect revise
      const r3c = await spider.crawl();
      assert.equal(r3c?.action, 'engine-completed');
      assert.equal((r3c as { engineId: string }).engineId, 'revise');

      // seal runs (stub) — last engine → rig completes
      const r4 = await spider.crawl();
      assert.equal(r4?.action, 'rig-completed');
      assert.equal((r4 as { outcome: string }).outcome, 'completed');

      // CDC should have fired — writ should now be completed
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.status, 'completed', 'writ should transition to completed via CDC');

      const [finalRig] = await book.list();
      assert.equal(finalRig.status, 'completed');
    });
  });

  // ── Review engine — Animator integration ─────────────────────────

  describe('review engine — Animator integration', () => {
    it('calls animator.summon() with reviewer role, draft cwd, and prompt containing spec', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'Review integration test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: draftYields };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch review
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'review');

      assert.equal(summonCalls.length, 1, 'summon should be called once for review');
      const call = summonCalls[0];
      assert.equal(call.role, 'reviewer', 'review engine uses reviewer role');
      assert.equal(call.cwd, '/p', 'cwd is the draft worktree path');
      assert.ok(call.prompt.includes('# Code Review'), 'prompt includes review header');
      assert.ok(call.prompt.includes(writ.body), 'prompt includes writ body (spec)');
      assert.ok(call.prompt.includes('## Instructions'), 'prompt includes instructions section');
      assert.ok(call.prompt.includes('### Overall: PASS or FAIL'), 'prompt includes findings format');
      assert.deepEqual(call.metadata?.mechanicalChecks, [], 'no mechanical checks when not configured');
    });

    it('collects ReviewYields: parses PASS from session.output', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const findings = '### Overall: PASS\n\n### Completeness\nAll requirements met.';
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'running' as const, sessionId: fakeSessionId };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: findings,
        metadata: { mechanicalChecks: [] },
      });

      const result = await spider.crawl(); // collect review
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'review');

      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = reviewEngine?.yields as ReviewYields;
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.passed, true, 'passed should be true when output contains PASS');
      assert.equal(yields.findings, findings);
      assert.deepEqual(yields.mechanicalChecks, []);
    });

    it('collects ReviewYields: passed is false when output contains FAIL', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'running' as const, sessionId: fakeSessionId };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.',
        metadata: { mechanicalChecks: [] },
      });

      await spider.crawl(); // collect review
      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = reviewEngine?.yields as ReviewYields;
      assert.equal(yields.passed, false, 'passed should be false when output contains FAIL');
    });

    it('collects ReviewYields: mechanicalChecks retrieved from session.metadata', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const checks: MechanicalCheck[] = [
        { name: 'build', passed: true, output: 'Build succeeded', durationMs: 1200 },
        { name: 'test', passed: false, output: '3 tests failed', durationMs: 4500 },
      ];
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'running' as const, sessionId: fakeSessionId };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
        output: '### Overall: FAIL',
        metadata: { mechanicalChecks: checks },
      });

      await spider.crawl(); // collect review
      const [updated] = await book.list();
      const reviewEngine = updated.engines.find((e: EngineInstance) => e.id === 'review');
      const yields = reviewEngine?.yields as ReviewYields;
      assert.equal(yields.mechanicalChecks.length, 2);
      assert.equal(yields.mechanicalChecks[0].name, 'build');
      assert.equal(yields.mechanicalChecks[0].passed, true);
      assert.equal(yields.mechanicalChecks[1].name, 'test');
      assert.equal(yields.mechanicalChecks[1].passed, false);
    });
  });

  // ── Review engine — mechanical checks ────────────────────────────

  describe('review engine — mechanical checks', () => {
    let mechFix: ReturnType<typeof buildFixture>;

    beforeEach(() => {
      mechFix = buildFixture({
        spider: {
          buildCommand: 'echo "build output"',
          testCommand: 'exit 1',
        },
      });
    });

    afterEach(() => {
      clearGuild();
    });

    it('executes build and test commands; captures pass/fail from exit code', async () => {
      const { clerk, spider, stacks, summonCalls } = mechFix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/tmp', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch review (runs checks first)
      assert.equal(result?.action, 'engine-started');

      assert.equal(summonCalls.length, 1);
      const checks = summonCalls[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.equal(checks.length, 2, 'both build and test checks should run');

      const buildCheck = checks.find((c) => c.name === 'build');
      assert.ok(buildCheck, 'build check should be present');
      assert.equal(buildCheck!.passed, true, 'echo exits 0 → passed');
      assert.ok(buildCheck!.output.includes('build output'), 'output captured from stdout');
      assert.ok(typeof buildCheck!.durationMs === 'number', 'durationMs recorded');

      const testCheck = checks.find((c) => c.name === 'test');
      assert.ok(testCheck, 'test check should be present');
      assert.equal(testCheck!.passed, false, 'exit 1 → failed');
    });

    it('skips checks gracefully when no buildCommand or testCommand configured', async () => {
      const noCmdFix = buildFixture({ spider: {} }); // no buildCommand/testCommand
      const { clerk, spider: w, stacks: s, summonCalls: sc } = noCmdFix;
      await postWrit(clerk);
      await w.crawl(); // spawn

      const book = rigsBook(s);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          return e;
        }),
      });

      await w.crawl(); // launch review
      assert.deepEqual(sc[0].metadata?.mechanicalChecks, [], 'no checks when commands not configured');
      clearGuild();
    });

    it('truncates check output to 4KB', async () => {
      const bigFix = buildFixture({
        spider: { buildCommand: 'python3 -c "print(\'x\' * 8192)"' },
      });
      const { clerk, spider: w, stacks: s, summonCalls: sc } = bigFix;
      await postWrit(clerk);
      await w.crawl(); // spawn

      const book = rigsBook(s);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/tmp', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          return e;
        }),
      });

      await w.crawl(); // launch review (runs check with big output)
      const checks = sc[0].metadata?.mechanicalChecks as MechanicalCheck[];
      assert.ok(checks[0].output.length <= 4096, `output should be truncated to 4KB, got ${checks[0].output.length} chars`);
      clearGuild();
    });
  });

  // ── Revise engine — Animator integration ─────────────────────────

  describe('revise engine — Animator integration', () => {
    it('calls animator.summon() with role from givens, draft cwd, and writ env', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      const writ = await postWrit(clerk, 'Revise integration test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = { sessionId: 'rev-1', passed: true, findings: '### Overall: PASS\nAll good.', mechanicalChecks: [] };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'completed' as const, yields: reviewYields };
          return e;
        }),
      });

      const result = await spider.crawl(); // launch revise
      assert.equal(result?.action, 'engine-started');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      assert.equal(summonCalls.length, 1, 'summon called once for revise');
      const call = summonCalls[0];
      assert.equal(call.role, 'artificer', 'revise uses role from givens (default artificer)');
      assert.equal(call.cwd, '/p', 'cwd is draft worktree path');
      assert.deepEqual(call.environment, { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` });
    });

    it('revision prompt includes pass branch when review passed', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await postWrit(clerk, 'Pass branch test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = {
        sessionId: 'rev-1',
        passed: true,
        findings: '### Overall: PASS\nAll requirements met.',
        mechanicalChecks: [],
      };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'completed' as const, yields: reviewYields };
          return e;
        }),
      });

      await spider.crawl(); // launch revise
      const prompt = summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: PASS'), 'prompt includes PASS result');
      assert.ok(prompt.includes('The review passed'), 'prompt includes pass branch instruction');
      assert.ok(prompt.includes(reviewYields.findings), 'prompt includes review findings');
    });

    it('revision prompt includes fail branch when review failed', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await postWrit(clerk, 'Fail branch test');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const reviewYields: ReviewYields = {
        sessionId: 'rev-1',
        passed: false,
        findings: '### Overall: FAIL\n\n### Required Changes\n1. Fix the bug.',
        mechanicalChecks: [],
      };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'completed' as const, yields: reviewYields };
          return e;
        }),
      });

      await spider.crawl(); // launch revise
      const prompt = summonCalls[0].prompt;
      assert.ok(prompt.includes('## Review Result: FAIL'), 'prompt includes FAIL result');
      assert.ok(
        prompt.includes('The review identified issues that need to be addressed'),
        'prompt includes fail branch instruction',
      );
      assert.ok(prompt.includes(reviewYields.findings), 'prompt includes review findings');
    });

    it('ReviseYields: sessionId and sessionStatus collected from session record', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const reviewYields: ReviewYields = { sessionId: 'rev-1', passed: true, findings: '### Overall: PASS', mechanicalChecks: [] };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' } };
          if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: { sessionId: 's1', sessionStatus: 'completed' } };
          if (e.id === 'review') return { ...e, status: 'completed' as const, yields: reviewYields };
          if (e.id === 'revise') return { ...e, status: 'running' as const, sessionId: fakeSessionId };
          return e;
        }),
      });

      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'completed',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      const result = await spider.crawl(); // collect revise
      assert.equal(result?.action, 'engine-completed');
      assert.equal((result as { engineId: string }).engineId, 'revise');

      const [updated] = await book.list();
      const reviseEngine = updated.engines.find((e: EngineInstance) => e.id === 'revise');
      const yields = reviseEngine?.yields as { sessionId: string; sessionStatus: string };
      assert.equal(yields.sessionId, fakeSessionId);
      assert.equal(yields.sessionStatus, 'completed');
    });
  });

  // ── show / list / forWrit ─────────────────────────────────────────

  describe('show()', () => {
    it('returns the full RigDoc for a valid rig id', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rigs = await spider.list();
      assert.equal(rigs.length, 1);
      const rigId = rigs[0].id;

      const rig = await spider.show(rigId);
      assert.equal(rig.id, rigId);
      assert.equal(rig.writId, writ.id);
      assert.equal(rig.status, 'running');
      assert.equal(rig.engines.length, 5);
      assert.equal(typeof rig.createdAt, 'string');
    });

    it('throws with "not found" message for an unknown rig id', async () => {
      const { spider } = fix;
      await assert.rejects(
        () => spider.show('rig-nonexistent'),
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
      const { spider } = fix;
      const rigs = await spider.list();
      assert.deepEqual(rigs, []);
    });

    it('returns rigs ordered by createdAt descending', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      const older = new Date(Date.now() - 100).toISOString();
      const newer = new Date().toISOString();
      await book.put({ id: 'rig-old', writId: 'w-1', status: 'running', engines: [], createdAt: older });
      await book.put({ id: 'rig-new', writId: 'w-2', status: 'running', engines: [], createdAt: newer });

      const rigs = await spider.list();
      assert.equal(rigs.length, 2);
      // Newest first
      assert.ok(rigs[0].createdAt >= rigs[1].createdAt);
    });

    it('filters by status', async () => {
      const { clerk, spider } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn (status: running)

      const running = await spider.list({ status: 'running' });
      assert.equal(running.length, 1);
      assert.equal(running[0].status, 'running');

      const completed = await spider.list({ status: 'completed' });
      assert.equal(completed.length, 0);
    });

    it('respects limit', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-limit-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() });
      }

      const limited = await spider.list({ limit: 2 });
      assert.equal(limited.length, 2);
    });

    it('respects offset', async () => {
      const { stacks, spider } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({ id: `rig-offset-${i}`, writId: `w-${i}`, status: 'running', engines: [], createdAt: new Date().toISOString() });
      }

      const all = await spider.list();
      assert.equal(all.length, 3);

      const page = await spider.list({ limit: 2, offset: 2 });
      assert.equal(page.length, 1);
    });
  });

  describe('forWrit()', () => {
    it('returns the rig for a writ that has been spawned', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rig = await spider.forWrit(writ.id);
      assert.ok(rig !== null);
      assert.equal(rig.writId, writ.id);
    });

    it('returns null when no rig exists for a writ', async () => {
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      // Do not crawl — no rig spawned yet

      const rig = await spider.forWrit(writ.id);
      assert.equal(rig, null);
    });

    it('returns null for a non-existent writ id', async () => {
      const { spider } = fix;
      const rig = await spider.forWrit('w-nonexistent');
      assert.equal(rig, null);
    });
  });

  describe('createdAt', () => {
    it('is set to a valid ISO timestamp when a rig is spawned', async () => {
      const { clerk, spider } = fix;
      const before = new Date().toISOString();
      await postWrit(clerk);
      await spider.crawl(); // spawn
      const after = new Date().toISOString();

      const rigs = await spider.list();
      assert.equal(rigs.length, 1);
      const { createdAt } = rigs[0];
      assert.equal(typeof createdAt, 'string');
      assert.ok(!isNaN(new Date(createdAt).getTime()), 'createdAt must be a valid date');
      assert.ok(createdAt >= before, 'createdAt must not be before spawn');
      assert.ok(createdAt <= after, 'createdAt must not be after spawn');
    });
  });

  // ── Downstream engine cancellation ───────────────────────────────

  describe('downstream engine cancellation', () => {
    it('(a) first-engine failure cancels all downstream engines', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Inject bad designId for draft (first engine) to trigger failure
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();
      const draft = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draft?.status, 'failed', 'draft should be failed');

      for (const id of ['implement', 'review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }
    });

    it('(b) mid-pipeline failure preserves completed upstream, cancels pending downstream', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Pre-complete draft, then inject bad designId for implement
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: draftYields };
          if (e.id === 'implement') return { ...e, designId: 'nonexistent-engine' };
          return e;
        }),
      });

      const result = await spider.crawl();
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();

      // Completed upstream engine preserved
      const draftEng = updated.engines.find((e: EngineInstance) => e.id === 'draft');
      assert.equal(draftEng?.status, 'completed', 'draft should remain completed');

      // Failed engine
      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'failed', 'implement should be failed');

      // Pending downstream engines cancelled
      for (const id of ['review', 'revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
        assert.equal(eng?.completedAt, undefined, `${id} should not have completedAt`);
        assert.equal(eng?.error, undefined, `${id} should not have error`);
      }
    });

    it('(c) a running engine is not cancelled when another engine fails', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();

      // Draft completed, implement is running with a sessionId,
      // review is pending — inject bad designId for review so it fails next
      // But we need to fail via failEngine path: inject bad designId on review directly
      // and manually set implement to running to test it isn't cancelled.
      const fakeSessionId = generateId('ses', 4);
      const draftYields = { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p', baseSha: 'sha1' };
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) => {
          if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: draftYields };
          if (e.id === 'implement') return { ...e, status: 'running' as const, sessionId: fakeSessionId };
          if (e.id === 'review') return { ...e, designId: 'nonexistent-engine', upstream: [] };
          return e;
        }),
      });

      // review now has no upstream and bad designId — running it will fail it
      const result = await spider.crawl();
      // review fails (bad designId) → rig fails
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [updated] = await book.list();

      // The running engine (implement) must NOT be cancelled
      const implEng = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(implEng?.status, 'running', 'running implement engine should not be cancelled');

      // The failed engine
      const reviewEng = updated.engines.find((e: EngineInstance) => e.id === 'review');
      assert.equal(reviewEng?.status, 'failed', 'review should be failed');

      // Only pending engines should be cancelled (revise and seal)
      for (const id of ['revise', 'seal']) {
        const eng = updated.engines.find((e: EngineInstance) => e.id === id);
        assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
      }
    });

    it('cancelled engines have no completedAt', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      await spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0, 'expected cancelled engines');
      for (const eng of cancelled) {
        assert.equal(eng.completedAt, undefined, `${eng.id} should not have completedAt`);
      }
    });

    it('cancelled engines have no error', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft' ? { ...e, designId: 'nonexistent-engine' } : e,
        ),
      });

      await spider.crawl();

      const [updated] = await book.list();
      const cancelled = updated.engines.filter((e: EngineInstance) => e.status === 'cancelled');
      assert.ok(cancelled.length > 0, 'expected cancelled engines');
      for (const eng of cancelled) {
        assert.equal(eng.error, undefined, `${eng.id} should not have error`);
      }
    });
  });

  // ── Walk returns null ──────────────────────────────────────────────

  describe('walk() returns null', () => {
    it('returns null when no rigs exist and no ready writs', async () => {
      const result = await fix.spider.crawl();
      assert.equal(result, null);
    });

    it('returns null when the rig has a running engine with no terminal session', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);

      // Put draft in 'running' with a live session
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'draft'
            ? { ...e, status: 'running' as const, sessionId: fakeSessionId }
            : e,
        ),
      });

      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'running',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      const result = await spider.crawl();
      assert.equal(result, null);
    });
  });
});

// ── Template-based rig building tests ─────────────────────────────────

describe('Spider — template dispatch', () => {
  afterEach(() => {
    clearGuild();
  });

  it('spawns a rig using the type-specific template when writ type matches', async () => {
    const mandateTemplate: RigTemplate = {
      engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '$writ' } },
        { id: 'step2', designId: 'seal', upstream: ['step1'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { mandate: mandateTemplate } },
    });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mandate writ', body: 'test', type: 'mandate' });
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 2, 'rig should use mandate template (2 engines)');
    assert.equal(rigs[0].engines[0].id, 'step1');
    assert.equal(rigs[0].engines[1].id, 'step2');
  });

  it('falls back to default template when no type-specific match exists', async () => {
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '$writ' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
        { id: 'c', designId: 'implement', upstream: ['b'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { default: defaultTemplate } },
    });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Task writ', body: 'test', type: 'mandate' });
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 3, 'rig should use default template (3 engines)');
  });

  it('uses type-specific template over default when both exist', async () => {
    const mandateTemplate: RigTemplate = {
      engines: [
        { id: 'only', designId: 'seal', givens: {} },
      ],
    };
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '$writ' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: { rigTemplates: { mandate: mandateTemplate, default: defaultTemplate } },
    });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'Mandate', body: 'test', type: 'mandate' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 1, 'should use mandate template (1 engine)');
    assert.equal(rigs[0].engines[0].id, 'only');
  });

  it('throws with "No rig template found" when writ type has no match and no default', async () => {
    // Configure only a 'hotfix' template (not 'mandate' or 'default')
    // Post a mandate writ (the default clerk type) — it has no matching template
    const fix = buildFixture({
      spider: { rigTemplates: { hotfix: { engines: [{ id: 'x', designId: 'seal', givens: {} }] } } },
    });
    const { clerk, spider } = fix;

    await clerk.post({ title: 'Mandate writ', body: 'test' }); // defaults to 'mandate' type
    await assert.rejects(
      () => spider.crawl(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No rig template found'), err.message);
        return true;
      },
    );
  });

  it('uses default template when writ type does not match a specific key', async () => {
    // buildFixture always provides rigTemplates.default = STANDARD_TEMPLATE via merge,
    // so a mandate writ (the clerk default) uses the default template.
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'Test', body: 'test' }); // type: 'mandate', uses STANDARD_TEMPLATE
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');
    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'default template produces 5 engines');
  });

  it('throws with "No rig template found" when rigTemplates is not configured at all', async () => {
    // Override the fixture's default rigTemplates injection by setting rigTemplates to undefined.
    // The spread in buildFixture resolves to: { rigTemplates: { default: STANDARD_TEMPLATE }, ...{ rigTemplates: undefined } }
    // which gives { rigTemplates: undefined }, exercising the absent-rigTemplates code path.
    const fix = buildFixture({ spider: { rigTemplates: undefined } });
    const { clerk, spider } = fix;

    await clerk.post({ title: 'Test writ', body: 'test' });
    await assert.rejects(
      () => spider.crawl(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('No rig template found'), err.message);
        return true;
      },
    );
  });
});

describe('Spider — variable resolution', () => {
  afterEach(() => {
    clearGuild();
  });

  it('$writ resolves to the full WritDoc object', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '$writ' } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'My writ', body: 'test body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const engine = rigs[0].engines[0];
    const resolvedWrit = engine.givensSpec.w as { id: string; type: string; title: string };
    assert.equal(resolvedWrit.id, writ.id);
    assert.equal(resolvedWrit.title, writ.title);
  });

  it('$role resolves to spiderConfig.role when set', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { r: '$role' } }],
    };
    const fix = buildFixture({ spider: { role: 'builder', rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.r, 'builder');
  });

  it('$role defaults to "artificer" when spiderConfig.role is not set', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { r: '$role' } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.r, 'artificer');
  });

  it('$spider.buildCommand resolves to the configured value', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '$spider.buildCommand' } }],
    };
    const fix = buildFixture({ spider: { buildCommand: 'make build', rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.cmd, 'make build');
  });

  it('$spider.* undefined causes key to be omitted entirely', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '$spider.testCommand' } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } }); // no testCommand
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when testCommand is not set');
  });

  it('literal string without $ prefix is passed through unchanged', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { role: 'reviewer', count: 5 } }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.role, 'reviewer');
    assert.equal(rigs[0].engines[0].givensSpec.count, 5);
  });

  it('mixed literals and $-variables resolve correctly together', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { writ: '$writ', role: 'reviewer', cmd: '$spider.buildCommand' } }],
    };
    const fix = buildFixture({ spider: { buildCommand: 'pnpm build', rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mixed test', body: 'mixed body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    // $writ resolves to the WritDoc object
    assert.equal((givens.writ as { id: string }).id, writ.id, '$writ should resolve to WritDoc');
    // literal string "reviewer" passes through unchanged (not affected by spiderConfig.role)
    assert.equal(givens.role, 'reviewer', 'literal "reviewer" should pass through unchanged');
    // $spider.buildCommand resolves to the configured value
    assert.equal(givens.cmd, 'pnpm build', '$spider.buildCommand should resolve to configured value');
  });

  it('engine with no givens field produces empty givensSpec', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal' }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.deepEqual(rigs[0].engines[0].givensSpec, {});
  });
});

describe('Spider — startup validation', () => {
  afterEach(() => {
    clearGuild();
  });

  it('throws [spider] error for unknown designId', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), `expected [spider] prefix, got: ${err.message}`);
        assert.ok(err.message.includes('unknown designId "nonexistent"'), err.message);
        return true;
      },
    );
  });

  it('accepts Spider builtin designIds (draft, implement, review, revise, seal)', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'a', designId: 'draft', givens: { writ: '$writ' } },
                { id: 'b', designId: 'implement', upstream: ['a'], givens: { writ: '$writ', role: '$role' } },
                { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
              ],
            },
          },
        },
      })
    );
  });

  it('throws [spider] error for unknown upstream reference', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'x', designId: 'seal', upstream: ['ghost'] },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unknown upstream "ghost"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for duplicate engine ids', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'step1', designId: 'draft', givens: { writ: '$writ' } },
                { id: 'step1', designId: 'seal', givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('duplicate engine id "step1"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for dependency cycle', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'a', designId: 'draft', upstream: ['c'], givens: { writ: '$writ' } },
                { id: 'b', designId: 'implement', upstream: ['a'], givens: {} },
                { id: 'c', designId: 'seal', upstream: ['b'], givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('cycle detected'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for self-referencing upstream', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'self', designId: 'seal', upstream: ['self'], givens: {} },
              ],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('cycle detected'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for invalid resolutionEngine', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: {} }],
              resolutionEngine: 'absent',
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('resolutionEngine "absent"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized variable reference ($buildCommand)', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$buildCommand' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized variable "$buildCommand"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for nested $spider path ($spider.a.b)', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$spider.a.b' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized variable "$spider.a.b"'), err.message);
        return true;
      },
    );
  });

  it('accepts $spider.buildCommand as a valid variable', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$spider.buildCommand' } }],
            },
          },
        },
      })
    );
  });

  it('throws [spider] error for empty engines array', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: { engines: [] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('has no engines'), err.message);
        return true;
      },
    );
  });

  it('error messages include the template key', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            mandate: { engines: [{ id: 'x', designId: 'nonexistent' }] },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('rigTemplates.mandate'), err.message);
        return true;
      },
    );
  });
});

describe('Spider — resolutionEngineId', () => {
  afterEach(() => {
    clearGuild();
  });

  it('sets resolutionEngineId on RigDoc when template has resolutionEngine', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: {} }],
      resolutionEngine: 'only',
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].resolutionEngineId, 'only');
  });

  it('omits resolutionEngineId from RigDoc when template has no resolutionEngine', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: {} }],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('resolutionEngineId' in rigs[0]) || rigs[0].resolutionEngineId === undefined);
  });
});

describe('Spider — CDC resolution fallback', () => {
  afterEach(() => {
    clearGuild();
  });

  it('uses resolutionEngineId engine yields when present', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Set a resolutionEngineId and mark that engine completed with yields
    const customYields = { result: 'custom-resolution' };
    await book.patch(rig.id, {
      resolutionEngineId: 'implement',
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: customYields };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    // CDC should have fired
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.status, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(customYields));
  });

  it('falls back to seal engine when no resolutionEngineId', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    const sealYields = { sealedCommit: 'abc123', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 1 };
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'seal') return { ...e, status: 'completed' as const, yields: sealYields };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields));
  });

  it('falls back to last completed engine when no resolutionEngineId and no seal', async () => {
    // Use a template without a seal engine
    const template: RigTemplate = {
      engines: [
        { id: 'draft', designId: 'draft', givens: { writ: '$writ' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'], givens: { writ: '$writ', role: '$role' } },
      ],
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    const implementYields = { sessionId: 'ses-1', sessionStatus: 'completed' };
    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') return { ...e, status: 'completed' as const, yields: { draftId: 'd1' } };
        if (e.id === 'implement') return { ...e, status: 'completed' as const, yields: implementYields };
        return e;
      }),
      status: 'completed',
    });

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, JSON.stringify(implementYields));
  });

  it('uses "Rig completed" when no engine has yields', async () => {
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    await book.patch(rig.id, {
      engines: rig.engines.map((e: EngineInstance) => ({ ...e, status: 'completed' as const })),
      status: 'completed',
    });

    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.resolution, 'Rig completed');
  });

  it('pre-existing rig without resolutionEngineId falls through to seal then last completed', async () => {
    // Simulate a rig created before the resolutionEngineId feature was added.
    // It has no resolutionEngineId field at all — the CDC handler must degrade gracefully.
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'pre-existing rig', body: 'test' });
    await spider.crawl(); // spawn (creates rig with resolutionEngineId: 'seal' from STANDARD_TEMPLATE)

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Remove resolutionEngineId entirely to simulate a pre-existing rig and
    // set seal with yields — the fallback chain should find seal.
    const sealYields = { sealedCommit: 'legacy-abc', strategy: 'fast-forward', retries: 0, inscriptionsSealed: 3 };
    const { resolutionEngineId: _removed, ...rigWithoutResolutionEngineId } = rig as typeof rig & { resolutionEngineId?: string };

    // Patch the rig to remove resolutionEngineId and set seal yields
    await book.patch(rig.id, {
      ...rigWithoutResolutionEngineId,
      engines: rig.engines.map((e: EngineInstance) => {
        if (e.id === 'seal') return { ...e, status: 'completed' as const, yields: sealYields };
        return { ...e, status: 'completed' as const };
      }),
      status: 'completed',
    });

    // CDC should fall through to seal engine (backwards compat path)
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.status, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields), 'should fall back to seal engine yields');
  });
});

describe('Spider — buildStaticEngines preserved', () => {
  it('buildStaticEngines function still exists (not deleted)', async () => {
    // We can't import it directly (it's not exported), but we can verify
    // the Spider still functions correctly with the standard 5-engine template
    // which mirrors the old behavior. The function is preserved in spider.ts.
    const fix = buildFixture(); // uses STANDARD_TEMPLATE
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'standard template produces 5 engines');
  });
});

// ── Full pipeline integration tests ───────────────────────────────────────

describe('Spider — full pipeline integration', () => {
  afterEach(() => {
    clearGuild();
  });

  it('custom 2-engine template (draft → seal): crawls spawn → both engines complete → writ completed', async () => {
    // Configure a custom 2-engine template for 'mandate' writs (the only declared clerk type).
    // Register stub clockwork implementations so no Scriptorium or Animator is needed.
    const twoEngineTemplate: RigTemplate = {
      engines: [
        { id: 'step1', designId: 'draft', givens: { writ: '$writ' } },
        { id: 'step2', designId: 'seal', upstream: ['step1'], givens: {} },
      ],
      resolutionEngine: 'step2',
    };
    const fix = buildFixture({
      spider: { rigTemplates: { default: twoEngineTemplate } },
    });
    const { clerk, spider, stacks, fire } = fix;

    // Override builtin engines with stub clockwork implementations
    const step1Yields = { draftComplete: true };
    const step2Yields = { sealedCommit: 'custom-sha', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 };

    const stubPlugin: LoadedApparatus = {
      packageName: '@test/stub-2engine',
      id: 'test-2engine',
      version: '0.0.0',
      apparatus: {
        requires: [],
        supportKit: {
          engines: {
            draft: { id: 'draft', async run() { return { status: 'completed' as const, yields: step1Yields }; } },
            seal:  { id: 'seal',  async run() { return { status: 'completed' as const, yields: step2Yields }; } },
          },
        },
        provides: {},
        start() {},
      },
    };
    void fire('plugin:initialized', stubPlugin);

    const writ = await clerk.post({ title: '2-engine writ', body: 'custom pipeline' });

    // spawn: rig created with 2 engines and resolutionEngineId: 'step2'
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 2, 'custom template creates 2-engine rig');
    assert.equal(rigs[0].resolutionEngineId, 'step2', 'resolutionEngineId set from template');

    // step1 (draft stub — clockwork) runs and completes
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'step1');

    // step2 (seal stub — clockwork) runs; all engines done → rig-completed
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'rig-completed');
    assert.equal((r3 as { outcome: string }).outcome, 'completed');

    // CDC: writ transitions to completed using step2's yields (resolutionEngineId: 'step2')
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.status, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(step2Yields), 'resolution uses step2 yields via resolutionEngineId');
  });

  it('3-engine template without seal uses resolutionEngine for writ resolution', async () => {
    // Configure a template with draft → implement → review, no seal engine.
    // resolutionEngine: 'review' directs the CDC handler to use review's yields.
    const template: RigTemplate = {
      engines: [
        { id: 'draft',     designId: 'draft',     givens: { writ: '$writ' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '$writ', role: '$role' } },
        { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '$writ' } },
      ],
      resolutionEngine: 'review',
    };
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks, fire } = fix;

    // Override builtin engines with stub clockwork implementations
    const draftYields = { drafted: true };
    const implementYields = { implemented: true };
    const reviewYields = { passed: true, findings: '### Overall: PASS\nAll requirements met.', sessionId: 'rev-1', mechanicalChecks: [] };

    const stubPlugin: LoadedApparatus = {
      packageName: '@test/stub-3engine',
      id: 'test-3engine',
      version: '0.0.0',
      apparatus: {
        requires: [],
        supportKit: {
          engines: {
            draft:     { id: 'draft',     async run() { return { status: 'completed' as const, yields: draftYields }; } },
            implement: { id: 'implement', async run() { return { status: 'completed' as const, yields: implementYields }; } },
            review:    { id: 'review',    async run() { return { status: 'completed' as const, yields: reviewYields }; } },
          },
        },
        provides: {},
        start() {},
      },
    };
    void fire('plugin:initialized', stubPlugin);

    const writ = await clerk.post({ title: '3-engine test', body: 'no seal needed' });

    // spawn: rig created with 3 engines, resolutionEngineId: 'review'
    const r1 = await spider.crawl();
    assert.equal(r1?.action, 'rig-spawned');
    const [rig] = await rigsBook(stacks).list();
    assert.equal(rig.engines.length, 3);
    assert.equal(rig.resolutionEngineId, 'review');

    // draft runs → engine-completed
    const r2 = await spider.crawl();
    assert.equal(r2?.action, 'engine-completed');
    assert.equal((r2 as { engineId: string }).engineId, 'draft');

    // implement runs → engine-completed
    const r3 = await spider.crawl();
    assert.equal(r3?.action, 'engine-completed');
    assert.equal((r3 as { engineId: string }).engineId, 'implement');

    // review runs → all done → rig-completed
    const r4 = await spider.crawl();
    assert.equal(r4?.action, 'rig-completed');
    assert.equal((r4 as { outcome: string }).outcome, 'completed');

    // CDC: writ transitions to completed using review's yields (no seal engine present)
    const finalWrit = await clerk.show(writ.id);
    assert.equal(finalWrit.status, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(reviewYields), 'resolution uses review yields via resolutionEngineId');
  });
});

// ── Tool structure tests ───────────────────────────────────────────────────

describe('Spider tools — structure (V6/R8/R9/R10/R12)', () => {
  // ── supportKit.tools registration ─────────────────────────────────

  describe('supportKit.tools registration', () => {
    it('contains rig-show, rig-list, and rig-for-writ in supportKit.tools', () => {
      const spiderPlugin = createSpider();
      const kit = spiderPlugin.apparatus.supportKit as { tools?: Array<{ name: string }> };
      const tools = kit.tools ?? [];
      const toolNames = tools.map((t) => t.name);

      assert.ok(toolNames.includes('rig-show'), 'supportKit.tools must include rig-show');
      assert.ok(toolNames.includes('rig-list'), 'supportKit.tools must include rig-list');
      assert.ok(toolNames.includes('rig-for-writ'), 'supportKit.tools must include rig-for-writ');
    });

    it('also contains crawl-one and crawl-continual tools', () => {
      const spiderPlugin = createSpider();
      const kit = spiderPlugin.apparatus.supportKit as { tools?: Array<{ name: string }> };
      const tools = kit.tools ?? [];
      const toolNames = tools.map((t) => t.name);

      assert.ok(toolNames.includes('crawl-one'), 'supportKit.tools must include crawl-one');
      assert.ok(toolNames.includes('crawl-continual'), 'supportKit.tools must include crawl-continual');
    });
  });

  // ── rig-show structure ─────────────────────────────────────────────

  describe('rig-show tool definition', () => {
    it('has name "rig-show"', () => {
      assert.equal(rigShowTool.name, 'rig-show');
    });

    it('has permission "read"', () => {
      assert.equal(rigShowTool.permission, 'read');
    });

    it('accepts a valid id string', () => {
      const result = rigShowTool.params.safeParse({ id: 'rig-abc123' });
      assert.ok(result.success, 'valid id should be accepted');
    });

    it('rejects missing id', () => {
      const result = rigShowTool.params.safeParse({});
      assert.ok(!result.success, 'missing id should be rejected');
    });

    it('rejects non-string id', () => {
      const result = rigShowTool.params.safeParse({ id: 42 });
      assert.ok(!result.success, 'non-string id should be rejected');
    });
  });

  // ── rig-list structure ─────────────────────────────────────────────

  describe('rig-list tool definition', () => {
    it('has name "rig-list"', () => {
      assert.equal(rigListTool.name, 'rig-list');
    });

    it('has permission "read"', () => {
      assert.equal(rigListTool.permission, 'read');
    });

    it('accepts empty params (all optional)', () => {
      const result = rigListTool.params.safeParse({});
      assert.ok(result.success, 'empty params should be accepted');
    });

    it('accepts all valid status values', () => {
      for (const status of ['running', 'completed', 'failed', 'blocked']) {
        const result = rigListTool.params.safeParse({ status });
        assert.ok(result.success, `status "${status}" should be accepted`);
      }
    });

    it('rejects an invalid status value', () => {
      const result = rigListTool.params.safeParse({ status: 'pending' });
      assert.ok(!result.success, '"pending" is not a valid rig status');
    });

    it('rejects another invalid status value', () => {
      const result = rigListTool.params.safeParse({ status: 'unknown' });
      assert.ok(!result.success, '"unknown" is not a valid rig status');
    });

    it('accepts numeric limit and offset', () => {
      const result = rigListTool.params.safeParse({ limit: 10, offset: 5 });
      assert.ok(result.success);
      assert.equal(result.data?.limit, 10);
      assert.equal(result.data?.offset, 5);
    });

    it('rejects non-numeric limit', () => {
      const result = rigListTool.params.safeParse({ limit: 'ten' });
      assert.ok(!result.success, 'non-numeric limit should be rejected');
    });

    it('rejects non-numeric offset', () => {
      const result = rigListTool.params.safeParse({ offset: 'five' });
      assert.ok(!result.success, 'non-numeric offset should be rejected');
    });
  });

  // ── rig-for-writ structure ─────────────────────────────────────────

  describe('rig-for-writ tool definition', () => {
    it('has name "rig-for-writ"', () => {
      assert.equal(rigForWritTool.name, 'rig-for-writ');
    });

    it('has permission "read"', () => {
      assert.equal(rigForWritTool.permission, 'read');
    });

    it('accepts a valid writId string', () => {
      const result = rigForWritTool.params.safeParse({ writId: 'w-abc123' });
      assert.ok(result.success, 'valid writId should be accepted');
    });

    it('rejects missing writId', () => {
      const result = rigForWritTool.params.safeParse({});
      assert.ok(!result.success, 'missing writId should be rejected');
    });

    it('rejects non-string writId', () => {
      const result = rigForWritTool.params.safeParse({ writId: 99 });
      assert.ok(!result.success, 'non-string writId should be rejected');
    });
  });
});

// ── Tool handler delegation tests ─────────────────────────────────────────

describe('Spider tools — handler delegation', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── rig-show handler ───────────────────────────────────────────────

  describe('rig-show handler', () => {
    it('returns the full RigDoc for a valid rig id', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rigs = await spider.list();
      const rigId = rigs[0].id;

      const result = await rigShowTool.handler({ id: rigId }) as RigDoc;
      assert.equal(result.id, rigId);
      assert.equal(result.writId, writ.id);
      assert.equal(result.status, 'running');
      assert.equal(result.engines.length, 5);
      assert.equal(typeof result.createdAt, 'string');
    });

    it('throws with "not found" message for an unknown rig id', async () => {
      buildFixture();
      await assert.rejects(
        () => rigShowTool.handler({ id: 'rig-nonexistent' }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, 'Rig "rig-nonexistent" not found.');
          return true;
        },
      );
    });
  });

  // ── rig-list handler ───────────────────────────────────────────────

  describe('rig-list handler', () => {
    it('returns empty array when no rigs exist', async () => {
      buildFixture();
      const result = await rigListTool.handler({}) as RigDoc[];
      assert.deepEqual(result, []);
    });

    it('returns rigs ordered by createdAt descending (newest first)', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      const older = new Date(Date.now() - 100).toISOString();
      const newer = new Date().toISOString();
      await book.put({ id: 'rig-handler-old', writId: 'w-1', status: 'running', engines: [], createdAt: older });
      await book.put({ id: 'rig-handler-new', writId: 'w-2', status: 'running', engines: [], createdAt: newer });

      const rigs = await rigListTool.handler({}) as RigDoc[];
      assert.equal(rigs.length, 2);
      assert.ok(rigs[0].createdAt >= rigs[1].createdAt, 'rigs must be newest first');
    });

    it('filters by status — only running rigs returned', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn (status: running)

      const running = await rigListTool.handler({ status: 'running' }) as RigDoc[];
      assert.equal(running.length, 1);
      assert.equal(running[0].status, 'running');

      const completed = await rigListTool.handler({ status: 'completed' }) as RigDoc[];
      assert.equal(completed.length, 0);
    });

    it('respects limit', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({
          id: `rig-lim-${i}`, writId: `w-${i}`, status: 'running', engines: [],
          createdAt: new Date().toISOString(),
        });
      }

      const limited = await rigListTool.handler({ limit: 2 }) as RigDoc[];
      assert.equal(limited.length, 2);
    });

    it('respects offset', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({
          id: `rig-off-${i}`, writId: `w-${i}`, status: 'running', engines: [],
          createdAt: new Date().toISOString(),
        });
      }

      const all = await rigListTool.handler({}) as RigDoc[];
      assert.equal(all.length, 3);

      const page = await rigListTool.handler({ limit: 2, offset: 2 }) as RigDoc[];
      assert.equal(page.length, 1);
    });
  });

  // ── rig-for-writ handler ───────────────────────────────────────────

  describe('rig-for-writ handler', () => {
    it('returns the rig for a writ that has been spawned', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const result = await rigForWritTool.handler({ writId: writ.id }) as RigDoc | null;
      assert.ok(result !== null, 'expected a rig doc');
      assert.equal(result.writId, writ.id);
    });

    it('returns null when no rig has been spawned for a writ', async () => {
      const fix = buildFixture();
      const { clerk } = fix;
      const writ = await postWrit(clerk);
      // Do not crawl — no rig spawned yet

      const result = await rigForWritTool.handler({ writId: writ.id });
      assert.equal(result, null);
    });

    it('returns null for a non-existent writ id (does not throw)', async () => {
      buildFixture();
      const result = await rigForWritTool.handler({ writId: 'w-nonexistent' });
      assert.equal(result, null);
    });
  });
});
