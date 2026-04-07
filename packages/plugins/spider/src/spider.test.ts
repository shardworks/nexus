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
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, ReviewYields, MechanicalCheck, RigTemplate, BlockRecord, BlockType, CheckResult } from './types.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

// ── Test bootstrap ────────────────────────────────────────────────────

// Standard 5-engine template matching the original static pipeline behavior.
// Used as the default template in test fixtures.
const STANDARD_TEMPLATE: RigTemplate = {
  engines: [
    { id: 'draft',     designId: 'draft',     givens: { writ: '$writ' } },
    { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '$writ', role: '$vars.role' } },
    { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '$writ', role: 'reviewer', buildCommand: '$vars.buildCommand', testCommand: '$vars.testCommand' } },
    { id: 'revise',    designId: 'revise',    upstream: ['review'],    givens: { writ: '$writ', role: '$vars.role' } },
    { id: 'seal',      designId: 'seal',      upstream: ['revise'],    givens: {} },
  ],
  resolutionEngine: 'seal',
};

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[]): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
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

/**
 * Build a minimal StartupContext that captures and fires events.
 */
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
  extra: { kits?: LoadedKit[]; apparatuses?: LoadedApparatus[]; customEngines?: Record<string, unknown> } = {},
): {
  stacks: StacksApi;
  clerk: ClerkApi;
  fabricator: FabricatorApi;
  spider: SpiderApi;
  memBackend: InstanceType<typeof MemoryBackend>;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
  spiderFire: (event: string, ...args: unknown[]) => Promise<void>;
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
      variables: { role: 'artificer' },
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
    kits(): LoadedKit[] { return extra.kits ?? []; },
    apparatuses(): LoadedApparatus[] { return extra.apparatuses ?? []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  const spiderAsLoaded: LoadedApparatus = {
    packageName: '@shardworks/spider-apparatus',
    id: 'spider',
    version: '0.0.0',
    apparatus: spiderApparatus,
  };

  const customEngineApparatuses: LoadedApparatus[] = [];
  if (extra.customEngines && Object.keys(extra.customEngines).length > 0) {
    customEngineApparatuses.push({
      packageName: '@test/custom-engines',
      id: 'test-custom-engines',
      version: '0.0.0',
      apparatus: {
        requires: [],
        supportKit: { engines: extra.customEngines },
        provides: {},
        start() {},
      },
    });
  }

  const fabricatorKitEntries = buildKitEntries(
    extra.kits ?? [],
    [spiderAsLoaded, ...customEngineApparatuses, ...(extra.apparatuses ?? [])],
  );

  const spiderKitEntries = buildKitEntries(
    extra.kits ?? [],
    [spiderAsLoaded, ...(extra.apparatuses ?? [])],
  );

  // Start stacks with memory backend
  const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
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

  // Start fabricator with kit entries from Spider's engines
  const { ctx: fabricatorCtx, fire } = buildCtx(fabricatorKitEntries);
  fabricatorApparatus.start(fabricatorCtx);
  const fabricator = fabricatorApparatus.provides as FabricatorApi;
  apparatusMap.set('fabricator', fabricator);

  // Start spider with kit entries from Spider's supportKit
  const { ctx: spiderCtx, fire: spiderFire } = buildCtx(spiderKitEntries);
  spiderApparatus.start(spiderCtx);
  const spider = spiderApparatus.provides as SpiderApi;
  apparatusMap.set('spider', spider);

  return {
    stacks, clerk, fabricator, spider, memBackend, fire, spiderFire,
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
      // Register an engine design that returns non-JSON-serializable yields
      const badEngine: EngineDesign = {
        id: 'bad-engine',
        async run() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { status: 'completed' as const, yields: { fn: (() => {}) as any } };
        },
      };
      const { clerk, spider, stacks } = buildFixture({}, { status: 'completed' }, {
        customEngines: { 'bad-engine': badEngine },
      });

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
      const { clerk, spider, stacks, setSessionOutcome } = buildFixture({}, { status: 'completed' }, {
        customEngines: { seal: stubSealEngine },
      });

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
          variables: { buildCommand: 'echo "build output"', testCommand: 'exit 1' },
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
        spider: { variables: { buildCommand: 'python3 -c "print(\'x\' * 8192)"' } },
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
      spider: { rigTemplates: { mandate: mandateTemplate }, rigTemplateMappings: { mandate: 'mandate' } },
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
      spider: { rigTemplates: { mandate: mandateTemplate, default: defaultTemplate }, rigTemplateMappings: { mandate: 'mandate' } },
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

  it('$vars.<key> resolves to the value from spiderConfig.variables', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '$vars.buildCommand' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.cmd, 'make build');
  });

  it('$vars.<key> resolves non-string value types correctly', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { n: '$vars.count' } }],
    };
    const fix = buildFixture({ spider: { variables: { count: 42 }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.n, 42);
  });

  it('$vars.<key> omits the key when the variable is absent from variables dict', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '$vars.testCommand' } }],
    };
    const fix = buildFixture({ spider: { variables: {}, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when testCommand is not set');
  });

  it('$vars.<key> omits the key when the variables dict itself is absent from config', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '$vars.testCommand' } }],
    };
    // No variables key in spider config
    const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when no variables dict');
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
      engines: [{ id: 'only', designId: 'seal', givens: { writ: '$writ', role: 'reviewer', cmd: '$vars.buildCommand' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'pnpm build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mixed test', body: 'mixed body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    // $writ resolves to the WritDoc object
    assert.equal((givens.writ as { id: string }).id, writ.id, '$writ should resolve to WritDoc');
    // literal string "reviewer" passes through unchanged
    assert.equal(givens.role, 'reviewer', 'literal "reviewer" should pass through unchanged');
    // $vars.buildCommand resolves to the configured value
    assert.equal(givens.cmd, 'pnpm build', '$vars.buildCommand should resolve to configured value');
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

  it('${writ} and ${vars.<key>} resolve identically to their bare-form equivalents', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Curly brace test', body: 'test body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givensSpec = rigs[0].engines[0].givensSpec;
    // ${writ} resolves to the WritDoc object (same as $writ)
    assert.equal((givensSpec.w as { id: string }).id, writ.id, '${writ} should resolve to WritDoc');
    // ${vars.buildCommand} resolves to the configured value (same as $vars.buildCommand)
    assert.equal(givensSpec.cmd, 'make build', '${vars.buildCommand} should resolve to configured value');
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
                { id: 'b', designId: 'implement', upstream: ['a'], givens: { writ: '$writ', role: '$vars.role' } },
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

  it('throws [spider] error for $role variable (no longer valid)', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { r: '$role' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized variable "$role"'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for $spider.buildCommand (no longer valid)', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$spider.buildCommand' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized variable "$spider.buildCommand"'), err.message);
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

  it('throws [spider] error for nested $vars path ($vars.a.b)', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$vars.a.b' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized variable "$vars.a.b"'), err.message);
        return true;
      },
    );
  });

  it('accepts $vars.buildCommand as a valid variable', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '$vars.buildCommand' } }],
            },
          },
        },
      })
    );
  });

  it('accepts ${writ}, ${vars.<key>} curly-brace forms without throwing', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }],
            },
          },
        },
      })
    );
  });

  it('throws [spider] error for invalid curly-brace variable, error includes original ${...} form', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { x: '${badVar}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('"${badVar}"'), err.message);
        return true;
      },
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
        { id: 'implement', designId: 'implement', upstream: ['draft'], givens: { writ: '$writ', role: '$vars.role' } },
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

describe('Spider — STANDARD_TEMPLATE full pipeline givens', () => {
  afterEach(() => {
    clearGuild();
  });

  it('STANDARD_TEMPLATE spawns a 5-engine rig with correct givens (using $vars.role)', async () => {
    const fix = buildFixture(); // uses STANDARD_TEMPLATE with variables: { role: 'artificer' }
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'standard template produces 5 engines');

    const implement = rigs[0].engines.find((e: EngineInstance) => e.id === 'implement');
    const revise = rigs[0].engines.find((e: EngineInstance) => e.id === 'revise');
    const review = rigs[0].engines.find((e: EngineInstance) => e.id === 'review');

    assert.equal(implement?.givensSpec.role, 'artificer', 'implement $vars.role resolves to "artificer"');
    assert.equal(revise?.givensSpec.role, 'artificer', 'revise $vars.role resolves to "artificer"');
    assert.equal(review?.givensSpec.role, 'reviewer', 'review literal "reviewer" passes through');
    assert.ok(!('buildCommand' in (review?.givensSpec ?? {})), 'review buildCommand absent when not set in variables');
    assert.ok(!('testCommand' in (review?.givensSpec ?? {})), 'review testCommand absent when not set in variables');
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

    // Override builtin engines with stub clockwork implementations
    const step1Yields = { draftComplete: true };
    const step2Yields = { sealedCommit: 'custom-sha', strategy: 'fast-forward' as const, retries: 0, inscriptionsSealed: 1 };

    const fix = buildFixture(
      { spider: { rigTemplates: { default: twoEngineTemplate } } },
      { status: 'completed' },
      {
        customEngines: {
          draft: { id: 'draft', async run() { return { status: 'completed' as const, yields: step1Yields }; } },
          seal:  { id: 'seal',  async run() { return { status: 'completed' as const, yields: step2Yields }; } },
        },
      },
    );
    const { clerk, spider, stacks } = fix;

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
        { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '$writ', role: '$vars.role' } },
        { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '$writ' } },
      ],
      resolutionEngine: 'review',
    };
    // Override builtin engines with stub clockwork implementations
    const draftYields = { drafted: true };
    const implementYields = { implemented: true };
    const reviewYields = { passed: true, findings: '### Overall: PASS\nAll requirements met.', sessionId: 'rev-1', mechanicalChecks: [] };

    const fix = buildFixture(
      { spider: { rigTemplates: { default: template } } },
      { status: 'completed' },
      {
        customEngines: {
          draft:     { id: 'draft',     async run() { return { status: 'completed' as const, yields: draftYields }; } },
          implement: { id: 'implement', async run() { return { status: 'completed' as const, yields: implementYields }; } },
          review:    { id: 'review',    async run() { return { status: 'completed' as const, yields: reviewYields }; } },
        },
      },
    );
    const { clerk, spider, stacks } = fix;

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

// ── Engine Blocking on External Conditions ─────────────────────────────
//
// Tests for requirements R1–R29 (write w-mnnmd63t-b62234c456d3).
// Covers all validation cases (V1–V22) and all spec test cases.
//
// Uses buildBlockingFixture() — an extended fixture that gives Spider a
// real StartupContext with Wire-phase kit entries. Spider's own supportKit
// block types (writ-status, scheduled-time, book-updated) are delivered
// via ctx.kits('blockTypes') during start(), along with any custom block
// types passed as extra kit entries to the fixture.
// ──────────────────────────────────────────────────────────────────────

describe('Spider — engine blocking on external conditions', () => {

  // ── Extended fixture ──────────────────────────────────────────────────

  /**
   * Builds a test fixture like buildFixture() but gives Spider a real
   * StartupContext with Wire-phase kit entries so block types and engines
   * are delivered via ctx.kits() during start().
   *
   * @param customEngines  Engine designs registered in Fabricator before
   *                       Spider starts (so template validation passes).
   * @param customTemplate Optional override for the default rig template.
   *                       Must only reference built-in engine IDs or IDs
   *                       present in customEngines.
   */
  function buildBlockingFixture(
    customEngines: Record<string, EngineDesign> = {},
    customTemplate?: RigTemplate,
    customBlockTypes?: BlockType[],
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

    const template = customTemplate ?? STANDARD_TEMPLATE;
    const fakeGuildConfig: GuildConfig = {
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
      spider: { rigTemplates: { default: template } },
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
      startupWarnings() { return []; },
    };

    setGuild(fakeGuild);

    const spiderAsLoaded: LoadedApparatus = {
      packageName: '@shardworks/spider-apparatus',
      id: 'spider',
      version: '0.0.0',
      apparatus: spiderApparatus,
    };

    const customEngineApparatuses: LoadedApparatus[] = [];
    if (Object.keys(customEngines).length > 0) {
      customEngineApparatuses.push({
        packageName: '@test/custom-engines',
        id: 'test-custom-engines',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { engines: customEngines },
          provides: {},
          start() {},
        },
      });
    }

    const customBlockTypeApparatuses: LoadedApparatus[] = [];
    if (customBlockTypes && customBlockTypes.length > 0) {
      const blockTypesRecord: Record<string, BlockType> = {};
      for (const bt of customBlockTypes) {
        blockTypesRecord[bt.id] = bt;
      }
      customBlockTypeApparatuses.push({
        packageName: '@test/custom-block-types',
        id: 'test-custom-block-types',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { blockTypes: blockTypesRecord },
          provides: {},
          start() {},
        },
      });
    }

    const fabricatorKitEntries = buildKitEntries(
      [],
      [spiderAsLoaded, ...customEngineApparatuses],
    );
    const spiderKitEntries = buildKitEntries(
      [],
      [spiderAsLoaded, ...customBlockTypeApparatuses],
    );

    const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
    stacksApparatus.start(noopCtx);
    const stacks = stacksApparatus.provides as StacksApi;
    apparatusMap.set('stacks', stacks);

    memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
      indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
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

    let currentSessionOutcome: { status: 'completed' | 'failed'; error?: string; output?: string } = { status: 'completed' };
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

    clerkApparatus.start(noopCtx);
    const clerk = clerkApparatus.provides as ClerkApi;
    apparatusMap.set('clerk', clerk);

    // Both Fabricator and Spider get real ctxs with Wire-phase kit entries.
    const { ctx: fabricatorCtx, fire: fireFabricator } = buildCtx(fabricatorKitEntries);
    const { ctx: spiderCtx, fire: fireSpider } = buildCtx(spiderKitEntries);

    fabricatorApparatus.start(fabricatorCtx);
    const fabricator = fabricatorApparatus.provides as FabricatorApi;
    apparatusMap.set('fabricator', fabricator);

    spiderApparatus.start(spiderCtx);
    const spider = spiderApparatus.provides as SpiderApi;
    apparatusMap.set('spider', spider);

    return {
      stacks,
      clerk,
      fabricator,
      spider,
      memBackend,
      fire: fireFabricator,
      summonCalls,
      setSessionOutcome(outcome: { status: 'completed' | 'failed'; error?: string; output?: string }) {
        currentSessionOutcome = outcome;
      },
    };
  }

  afterEach(() => {
    clearGuild();
  });

  // ── Crawl phase ordering: checkBlocked before run (R4) ────────────────

  describe('Crawl phase ordering: checkBlocked before run (R4)', () => {
    it('engine-unblocked is returned before engine-started when both are possible in the same cycle', async () => {
      // Engine A is blocked and its checker immediately clears the block.
      // Engine B is an independent pending engine (no upstream) that is ready to run.
      // When both opportunities exist simultaneously, checkBlocked must take priority:
      // the first crawl() after blocking should yield engine-unblocked (not engine-started for B).
      const clearablePhaseA: EngineDesign = {
        id: 'phase-a-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'phase-hold', condition: { go: false } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const independentPhaseB: EngineDesign = {
        id: 'phase-b-engine',
        async run() { return { status: 'completed' as const, yields: {} }; },
      };
      const fix = buildBlockingFixture(
        { 'phase-a-engine': clearablePhaseA, 'phase-b-engine': independentPhaseB },
        {
          engines: [
            { id: 'a', designId: 'phase-a-engine', givens: {} },
            { id: 'b', designId: 'phase-b-engine', givens: {} }, // no upstream — runnable independently
          ],
          resolutionEngine: 'b',
        },
        [{
          id: 'phase-hold',
          conditionSchema: z.object({ go: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'cleared' }; }, // always clears — ensures unblock is immediately available
        }],
      );

      await fix.clerk.post({ title: 'Ordering Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      // Run engine a first → it blocks. Engine b is still pending.
      // (crawl picks the first pending engine; a is first in the list)
      const runResult = await fix.spider.crawl();
      assert.ok(runResult !== null);
      assert.equal(runResult.action, 'engine-blocked', 'a should block (b still pending → engine-blocked not rig-blocked)');
      assert.equal((runResult as { engineId: string }).engineId, 'a');

      // Now: a is blocked (checker will clear), b is still pending (can run).
      // The next crawl must checkBlocked before tryRun → returns engine-unblocked, NOT engine-started.
      const nextResult = await fix.spider.crawl();
      assert.ok(nextResult !== null);
      assert.equal(
        nextResult.action,
        'engine-unblocked',
        'checkBlocked phase must execute before run phase: expected engine-unblocked, not engine-started',
      );
      assert.equal((nextResult as { engineId: string }).engineId, 'a');

      // Subsequent crawl runs engine a (now pending after unblock)
      const afterUnblock = await fix.spider.crawl();
      assert.ok(afterUnblock !== null);
      // a or b may run next (both pending), but the point is that unblocked preceded run
      assert.ok(
        afterUnblock.action === 'engine-started' || afterUnblock.action === 'engine-completed',
        `expected engine-started or engine-completed, got: ${afterUnblock.action}`,
      );
    });
  });

  // ── Block type registry (V3, R5, R6) ──────────────────────────────────

  describe('Block type registry', () => {
    it('getBlockType returns the three built-in block types after startup (V3, R6)', () => {
      const { spider } = buildBlockingFixture();
      assert.ok(spider.getBlockType('writ-status') !== undefined, 'writ-status should be registered');
      assert.ok(spider.getBlockType('scheduled-time') !== undefined, 'scheduled-time should be registered');
      assert.ok(spider.getBlockType('book-updated') !== undefined, 'book-updated should be registered');
    });

    it('getBlockType returns undefined for an unknown block type id (R6)', () => {
      const { spider } = buildBlockingFixture();
      assert.equal(spider.getBlockType('nonexistent'), undefined);
    });

    it('registers a custom block type contributed via Wire-phase kit entry (R5)', async () => {
      const custom: BlockType = {
        id: 'my-custom-type',
        conditionSchema: z.object({ key: z.string() }),
        async check(): Promise<CheckResult> { return { status: 'pending' }; },
      };
      const { spider } = buildBlockingFixture({}, undefined, [custom]);
      assert.ok(spider.getBlockType('my-custom-type') !== undefined, 'custom block type should be registered');
    });

    it('listBlockTypes returns all built-in block types with correct info', () => {
      const { spider } = buildBlockingFixture();
      const result = spider.listBlockTypes();
      assert.ok(Array.isArray(result), 'listBlockTypes should return an array');

      const ids = result.map((bt) => bt.id);
      assert.ok(ids.includes('writ-status'), 'writ-status should be in list');
      assert.ok(ids.includes('scheduled-time'), 'scheduled-time should be in list');
      assert.ok(ids.includes('book-updated'), 'book-updated should be in list');
      assert.ok(ids.includes('patron-input'), 'patron-input should be in list');

      const writStatus = result.find((bt) => bt.id === 'writ-status');
      assert.ok(writStatus, 'writ-status should be found');
      assert.equal(typeof writStatus.pluginId, 'string', 'pluginId should be a string');
      assert.equal(writStatus.pollIntervalMs, 10_000, 'writ-status should have 10s poll interval');

      const scheduledTime = result.find((bt) => bt.id === 'scheduled-time');
      assert.ok(scheduledTime, 'scheduled-time should be found');
      assert.equal(scheduledTime.pollIntervalMs, 30_000, 'scheduled-time should have 30s poll interval');
    });

    it('listBlockTypes includes custom block type registered via Wire-phase kit entry', async () => {
      const custom: BlockType = {
        id: 'my-custom-type',
        conditionSchema: z.object({ key: z.string() }),
        pollIntervalMs: 5000,
        async check(): Promise<CheckResult> { return { status: 'pending' }; },
      };
      const { spider } = buildBlockingFixture({}, undefined, [custom]);

      const result = spider.listBlockTypes();
      const found = result.find((bt) => bt.id === 'my-custom-type');
      assert.ok(found, 'custom block type should appear in listBlockTypes');
      assert.equal(found.pollIntervalMs, 5000, 'pollIntervalMs should match');
    });

    it('listBlockTypes block type without pollIntervalMs has undefined pollIntervalMs', async () => {
      const noPollType: BlockType = {
        id: 'no-poll-type',
        conditionSchema: z.object({}),
        // No pollIntervalMs
        async check(): Promise<CheckResult> { return { status: 'pending' }; },
      };
      const { spider } = buildBlockingFixture({}, undefined, [noPollType]);

      const result = spider.listBlockTypes();
      const found = result.find((bt) => bt.id === 'no-poll-type');
      assert.ok(found, 'no-poll-type should be in list');
      assert.equal(found.pollIntervalMs, undefined, 'pollIntervalMs should be undefined when not set');
    });
  });

  // ── Engine blocked result → blocked status and block record (V1, V2, R1–R3) ─

  describe('Engine blocked result → blocked status and block record (V1, V2)', () => {
    it('transitions engine to blocked and persists block record with all fields', async () => {
      const blockingEngine: EngineDesign = {
        id: 'blk-engine',
        async run() {
          return {
            status: 'blocked' as const,
            blockType: 'test-block',
            condition: { x: 1 },
            message: 'waiting',
          };
        },
      };
      const fix = buildBlockingFixture(
        { 'blk-engine': blockingEngine },
        { engines: [{ id: 'sole', designId: 'blk-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'test-block',
          conditionSchema: z.object({ x: z.number() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Blocking writ', body: 'Wait' });
      await fix.spider.crawl(); // spawn

      const result = await fix.spider.crawl(); // run → blocked → rig-blocked (sole engine, no other progress)
      assert.ok(result !== null);
      // Sole engine blocking with no other runnable → rig-blocked
      assert.equal(result.action, 'rig-blocked');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');

      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      assert.equal(engine.status, 'blocked');
      assert.ok(engine.block !== undefined, 'block record should be present');
      assert.equal(engine.block.type, 'test-block');
      assert.deepEqual(engine.block.condition, { x: 1 });
      assert.equal(engine.block.message, 'waiting');
      assert.ok(
        typeof engine.block.blockedAt === 'string' && engine.block.blockedAt.length > 0,
        'blockedAt should be a non-empty ISO string',
      );
    });
  });

  // ── Unregistered block type → immediate engine failure (V19, R26) ──────

  describe('Unregistered block type → immediate engine failure (V19, R26)', () => {
    it('fails engine with "Unknown block type" when blockType is not registered', async () => {
      const badEngine: EngineDesign = {
        id: 'bad-blk-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'does-not-exist', condition: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'bad-blk-engine': badEngine },
        { engines: [{ id: 'sole', designId: 'bad-blk-engine', givens: {} }], resolutionEngine: 'sole' },
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      const result = await fix.spider.crawl(); // run → unknown block type → failure

      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine?.error?.includes('Unknown block type'), `expected error to include "Unknown block type", got: ${engine?.error}`);
      assert.ok(engine?.error?.includes('does-not-exist'), `expected error to include block type name, got: ${engine?.error}`);
    });
  });

  // ── Zod validation failure → immediate engine failure (V20, R27) ───────

  describe('Zod validation failure → immediate engine failure (V20, R27)', () => {
    it('fails engine with Zod error details when condition shape is wrong', async () => {
      const badCondEngine: EngineDesign = {
        id: 'bad-cond-engine',
        async run() {
          return {
            status: 'blocked' as const,
            blockType: 'strict-type',
            condition: { wrong: 123 }, // schema expects { required: string }
          };
        },
      };
      const fix = buildBlockingFixture(
        { 'bad-cond-engine': badCondEngine },
        { engines: [{ id: 'sole', designId: 'bad-cond-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'strict-type',
          conditionSchema: z.object({ required: z.string() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      const result = await fix.spider.crawl(); // run → Zod failure → engine failed

      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(
        engine?.error?.includes('Block type "strict-type" rejected condition'),
        `expected Zod rejection message, got: ${engine?.error}`,
      );
    });
  });

  // ── CrawlResult variants (R15) ─────────────────────────────────────────

  describe('CrawlResult variants (R15)', () => {
    it('returns rig-blocked when engine blocks and no other progress is possible (V8, V10)', async () => {
      // Engine A blocks; Engine B depends on A (not runnable while A blocked).
      // No running engines → rig transitions to blocked.
      const blockingA: EngineDesign = {
        id: 'dep-blocking-a',
        async run() {
          return { status: 'blocked' as const, blockType: 'dep-hold', condition: { w: true } };
        },
      };
      const dependentB: EngineDesign = {
        id: 'dep-dependent-b',
        async run() {
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'dep-blocking-a': blockingA, 'dep-dependent-b': dependentB },
        {
          engines: [
            { id: 'a', designId: 'dep-blocking-a', givens: {} },
            { id: 'b', designId: 'dep-dependent-b', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [{
          id: 'dep-hold',
          conditionSchema: z.object({ w: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      const result = await fix.spider.crawl(); // run a → rig-blocked

      assert.ok(result !== null);
      assert.equal(result.action, 'rig-blocked', 'should escalate to rig-blocked');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');
    });

    it('returns engine-blocked when engine blocks but rig has other runnable engines (V11)', async () => {
      // Two independent engines. A blocks first. B is still pending and runnable.
      // isRigBlocked returns false (B is runnable) → engine-blocked, rig stays running.
      const indepBlockingA: EngineDesign = {
        id: 'indep-blocking-a',
        async run() {
          return { status: 'blocked' as const, blockType: 'indep-hold', condition: { w: true } };
        },
      };
      const indepPassingB: EngineDesign = {
        id: 'indep-passing-b',
        async run() {
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'indep-blocking-a': indepBlockingA, 'indep-passing-b': indepPassingB },
        {
          engines: [
            { id: 'a', designId: 'indep-blocking-a', givens: {} },
            { id: 'b', designId: 'indep-passing-b', givens: {} }, // independent — no upstream
          ],
          resolutionEngine: 'b',
        },
        [{
          id: 'indep-hold',
          conditionSchema: z.object({ w: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      const result = await fix.spider.crawl(); // run a (first in list) → engine-blocked (b is still runnable)

      assert.ok(result !== null);
      assert.equal(result.action, 'engine-blocked', 'should NOT escalate to rig-blocked');
      assert.equal((result as { engineId: string }).engineId, 'a');
      assert.equal((result as { blockType: string }).blockType, 'indep-hold');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig should remain running since b is still runnable');
    });

    it('returns engine-unblocked when checker clears condition (R9)', async () => {
      const ctrlEngine: EngineDesign = {
        id: 'ctrl-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'ctrl-block', condition: { go: false } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'ctrl-engine': ctrlEngine },
        { engines: [{ id: 'sole', designId: 'ctrl-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'ctrl-block',
          conditionSchema: z.object({ go: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'cleared' }; }, // immediately clears
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      const unblockResult = await fix.spider.crawl(); // checkBlocked → engine-unblocked
      assert.ok(unblockResult !== null);
      assert.equal(unblockResult.action, 'engine-unblocked');
      assert.equal((unblockResult as { engineId: string }).engineId, 'sole');
    });
  });

  // ── Checker returns false → lastCheckedAt persisted (V6, R10) ──────────

  describe('lastCheckedAt persisted when checker returns false (V6, R10)', () => {
    it('sets block.lastCheckedAt after checker returns false', async () => {
      const neverClearEngine: EngineDesign = {
        id: 'nc-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'nc-block', condition: { val: 'x' } };
        },
      };
      const fix = buildBlockingFixture(
        { 'nc-engine': neverClearEngine },
        { engines: [{ id: 'sole', designId: 'nc-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'nc-block',
          conditionSchema: z.object({ val: z.string() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
          // No pollIntervalMs → checked every cycle
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.block?.lastCheckedAt, undefined, 'lastCheckedAt should be unset initially');

      // Crawl → checkBlocked → checker returns false → lastCheckedAt updated
      await fix.spider.crawl();

      [rig] = await fix.spider.list();
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(
        typeof engine?.block?.lastCheckedAt === 'string' && engine.block.lastCheckedAt.length > 0,
        'lastCheckedAt should be set after checker returns false',
      );
    });
  });

  // ── Checker clears block → engine returns to pending (V5, R9) ──────────

  describe('Checker clears block → engine returns to pending (V5, R9)', () => {
    it('engine transitions to pending and block field is cleared when checker returns true', async () => {
      let checkerResult: CheckResult = { status: 'pending' };
      const ctrlEngine2: EngineDesign = {
        id: 'ctrl2-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'ctrl2-block', condition: { key: 'v' } };
          }
          return { status: 'completed' as const, yields: { done: true } };
        },
      };
      const fix = buildBlockingFixture(
        { 'ctrl2-engine': ctrlEngine2 },
        { engines: [{ id: 'sole', designId: 'ctrl2-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'ctrl2-block',
          conditionSchema: z.object({ key: z.string() }),
          async check(): Promise<CheckResult> { return checkerResult; },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      // Crawl with checker still false → engine stays blocked
      await fix.spider.crawl();
      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'blocked', 'engine should remain blocked');

      // Set checker to return cleared → next crawl unblocks
      checkerResult = { status: 'cleared' };
      const unblockResult = await fix.spider.crawl(); // checkBlocked → engine-unblocked
      assert.ok(unblockResult !== null);
      assert.equal(unblockResult.action, 'engine-unblocked');

      [rig] = await fix.spider.list();
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'pending', 'engine should be pending after unblock');
      assert.equal(engine?.block, undefined, 'block field should be cleared');
      assert.equal(rig.status, 'running', 'rig should be restored to running');
    });
  });

  // ── Checker throws → engine stays blocked (V7, R11) ────────────────────

  describe('Checker throws → engine stays blocked (V7, R11)', () => {
    it('engine remains blocked and is not failed when checker throws', async () => {
      const throwEngine: EngineDesign = {
        id: 'throw-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'throw-block', condition: { v: 1 } };
        },
      };
      const fix = buildBlockingFixture(
        { 'throw-engine': throwEngine },
        { engines: [{ id: 'sole', designId: 'throw-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'throw-block',
          conditionSchema: z.object({ v: z.number() }),
          async check() { throw new Error('network error'); },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      // Crawl → checkBlocked → checker throws → engine stays blocked, no failure
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'blocked', 'engine should remain blocked after checker throws');
      assert.equal(rig.status, 'blocked', 'rig should remain blocked');
    });
  });

  // ── Poll interval (V4, R8) ─────────────────────────────────────────────

  describe('Poll interval respected (V4, R8)', () => {
    it('skips checker within pollIntervalMs, runs it after interval elapsed', async () => {
      let checkCallCount = 0;
      const polledEngine: EngineDesign = {
        id: 'polled-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'polled-block', condition: { w: true } };
        },
      };
      const fix = buildBlockingFixture(
        { 'polled-engine': polledEngine },
        { engines: [{ id: 'sole', designId: 'polled-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'polled-block',
          conditionSchema: z.object({ w: z.boolean() }),
          pollIntervalMs: 60_000, // 60 seconds
          async check(): Promise<CheckResult> {
            checkCallCount++;
            return { status: 'pending' };
          },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      // First checkBlocked crawl: no lastCheckedAt → checker IS called
      await fix.spider.crawl();
      assert.equal(checkCallCount, 1, 'checker should run once (no lastCheckedAt yet)');

      // Second crawl immediately: lastCheckedAt is set and pollIntervalMs not elapsed → checker skipped
      await fix.spider.crawl();
      assert.equal(checkCallCount, 1, 'checker should NOT be called again within pollIntervalMs');

      // Manually set lastCheckedAt to 61 seconds ago to simulate elapsed poll interval
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const [rig] = await book.list();
      const pastTime = new Date(Date.now() - 61_000).toISOString();
      await book.patch(rig.id, {
        engines: rig.engines.map((e: EngineInstance) =>
          e.id === 'sole'
            ? { ...e, block: { ...e.block!, lastCheckedAt: pastTime } }
            : e,
        ),
      });

      // Crawl now: poll interval has elapsed → checker IS called
      await fix.spider.crawl();
      assert.equal(checkCallCount, 2, 'checker should be called after poll interval elapsed');
    });
  });

  // ── Rig restored to running when engine unblocked (V9, R14) ────────────

  describe('Rig restored to running when blocked engine is unblocked (V9, R14)', () => {
    it('rig transitions from blocked back to running after engine-unblocked', async () => {
      let shouldClear = false;
      const clearableEngine: EngineDesign = {
        id: 'clearable-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'clearable-block', condition: { go: false } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const dependentEngine: EngineDesign = {
        id: 'clearable-dep-engine',
        async run() { return { status: 'completed' as const, yields: {} }; },
      };
      const fix = buildBlockingFixture(
        { 'clearable-engine': clearableEngine, 'clearable-dep-engine': dependentEngine },
        {
          engines: [
            { id: 'a', designId: 'clearable-engine', givens: {} },
            { id: 'b', designId: 'clearable-dep-engine', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [{
          id: 'clearable-block',
          conditionSchema: z.object({ go: z.boolean() }),
          async check(): Promise<CheckResult> { return shouldClear ? { status: 'cleared' } : { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run a → rig-blocked

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');

      // Trigger clear
      shouldClear = true;
      const unblockResult = await fix.spider.crawl(); // checkBlocked → engine-unblocked
      assert.equal(unblockResult?.action, 'engine-unblocked');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig should be restored to running after unblock');
      const engineA = rig.engines.find((e: EngineInstance) => e.id === 'a');
      assert.equal(engineA?.status, 'pending', 'engine a should be pending after unblock');
      assert.equal(engineA?.block, undefined, 'block field should be cleared');
    });
  });

  // ── resume() API (V12, R16, R17) ───────────────────────────────────────

  describe('resume() API (V12, R16, R17)', () => {
    it('clears block manually: engine becomes pending, rig becomes running', async () => {
      const holdEngine: EngineDesign = {
        id: 'hold-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'hold-block', condition: { hold: true } };
          }
          return { status: 'completed' as const, yields: { resumed: true } };
        },
      };
      const fix = buildBlockingFixture(
        { 'hold-engine': holdEngine },
        { engines: [{ id: 'sole', designId: 'hold-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'hold-block',
          conditionSchema: z.object({ hold: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; }, // never clears automatically
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → rig-blocked

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');
      const engineBefore = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engineBefore?.status, 'blocked');

      // Manual resume
      await fix.spider.resume(rig.id, 'sole');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig should be running after resume');
      const engineAfter = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engineAfter?.status, 'pending', 'engine should be pending after resume');
      assert.equal(engineAfter?.block, undefined, 'block field should be cleared');
    });

    it('throws the correct error when engine is not blocked (V12)', async () => {
      const fix = buildBlockingFixture();

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      const [rig] = await fix.spider.list();
      // The first engine in STANDARD_TEMPLATE is 'draft', status is 'pending'
      const pendingEngine = rig.engines.find((e: EngineInstance) => e.status === 'pending');
      assert.ok(pendingEngine !== undefined, 'should have a pending engine');

      await assert.rejects(
        () => fix.spider.resume(rig.id, pendingEngine!.id),
        (err: Error) => {
          assert.ok(err.message.includes('is not blocked'), `error should include "is not blocked", got: ${err.message}`);
          assert.ok(err.message.includes('pending'), `error should include current status, got: ${err.message}`);
          return true;
        },
      );
    });
  });

  // ── Prior block context on restart (V5, R20) ───────────────────────────

  describe('Prior block context on restart (V5, R20)', () => {
    it('priorBlock is passed to engine context on restart after unblocking', async () => {
      let callCount = 0;
      let capturedPriorBlock: unknown = undefined;

      const priorCapture: EngineDesign = {
        id: 'prior-capture-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          callCount++;
          capturedPriorBlock = ctx.priorBlock;
          if (callCount === 1) {
            return { status: 'blocked' as const, blockType: 'prior-block', condition: { val: 'test' } };
          }
          return { status: 'completed' as const, yields: { done: true } };
        },
      };
      const fix = buildBlockingFixture(
        { 'prior-capture-engine': priorCapture },
        { engines: [{ id: 'sole', designId: 'prior-capture-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'prior-block',
          conditionSchema: z.object({ val: z.string() }),
          async check(): Promise<CheckResult> { return { status: 'cleared' }; }, // always clears immediately
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run (call 1) → blocked

      assert.equal(callCount, 1);
      assert.equal(capturedPriorBlock, undefined, 'priorBlock should be undefined on first run');

      await fix.spider.crawl(); // checkBlocked → engine-unblocked (checker returns true)
      await fix.spider.crawl(); // run (call 2) → completed, priorBlock set

      assert.equal(callCount, 2, 'engine should have been called twice');
      assert.ok(capturedPriorBlock !== undefined, 'priorBlock should be set on second run');
      const prior = capturedPriorBlock as { type: string; condition: unknown; blockedAt: string };
      assert.equal(prior.type, 'prior-block');
      assert.deepEqual(prior.condition, { val: 'test' });
      assert.ok(typeof prior.blockedAt === 'string' && prior.blockedAt.length > 0);
    });

    it('priorBlock is undefined when engine has never been blocked', async () => {
      let capturedPriorBlock: unknown = 'not-set';
      const simpleEngine: EngineDesign = {
        id: 'simple-noblk-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          capturedPriorBlock = ctx.priorBlock;
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'simple-noblk-engine': simpleEngine },
        { engines: [{ id: 'sole', designId: 'simple-noblk-engine', givens: {} }], resolutionEngine: 'sole' },
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → completed

      assert.equal(capturedPriorBlock, undefined, 'priorBlock should be undefined when never blocked');
    });

    it('priorBlock is passed to engine after manual resume()', async () => {
      let callCount = 0;
      let capturedPriorBlock: unknown = undefined;
      const resumeCapture: EngineDesign = {
        id: 'resume-capture-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          callCount++;
          capturedPriorBlock = ctx.priorBlock;
          if (callCount === 1) {
            return { status: 'blocked' as const, blockType: 'resume-block', condition: { go: false } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'resume-capture-engine': resumeCapture },
        { engines: [{ id: 'sole', designId: 'resume-capture-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'resume-block',
          conditionSchema: z.object({ go: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; }, // never auto-clears
        }],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run (call 1) → blocked

      const [rig] = await fix.spider.list();
      await fix.spider.resume(rig.id, 'sole'); // manual clear → stores priorBlock in memory

      await fix.spider.crawl(); // run (call 2) → priorBlock set

      assert.equal(callCount, 2);
      assert.ok(capturedPriorBlock !== undefined, 'priorBlock should be set after manual resume');
      const prior = capturedPriorBlock as { type: string };
      assert.equal(prior.type, 'resume-block');
    });
  });

  // ── failEngine cancels blocked engines (V15, R21) ──────────────────────

  describe('failEngine cancels blocked engines alongside pending ones (V15, R21)', () => {
    it('blocked engines are cancelled (with block cleared) when rig fails', async () => {
      const fix = buildBlockingFixture();

      // Create a real writ so the CDC handler can transition it when the rig fails.
      const writ = await fix.clerk.post({ title: 'Fail test writ', body: 'Body' });
      // Transition to active so it can transition to failed (ready → active → failed)
      await fix.clerk.transition(writ.id, 'active');

      // Directly insert a rig with one blocked engine and one pending engine.
      // A third engine (running) will fail via its session, triggering failEngine.
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const rigId = generateId('rig', 4);
      const now = new Date().toISOString();
      const fakeSessionId = generateId('ses', 4);
      const blockRecord: BlockRecord = {
        type: 'some-block',
        condition: { x: 1 },
        blockedAt: now,
      };
      await book.put({
        id: rigId,
        writId: writ.id,
        status: 'running',
        engines: [
          {
            id: 'eng-blocked',
            designId: 'dummy',
            status: 'blocked',
            upstream: [],
            givensSpec: {},
            block: blockRecord,
          },
          {
            id: 'eng-pending',
            designId: 'dummy',
            status: 'pending',
            upstream: [],
            givensSpec: {},
          },
          {
            id: 'eng-running',
            designId: 'dummy',
            status: 'running',
            upstream: [],
            givensSpec: {},
            sessionId: fakeSessionId,
          },
        ],
        createdAt: now,
      });

      // Insert a failed session for eng-running
      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'failed',
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        provider: 'test',
        exitCode: 1,
        error: 'intentional failure',
        metadata: {},
      });

      // Crawl: tryCollect finds the failed session → failEngine called → CDC fires
      await fix.spider.crawl();

      const updatedRig = await book.get(rigId);
      assert.ok(updatedRig !== null, 'rig should still exist');
      assert.equal(updatedRig!.status, 'failed', 'rig should be failed');

      const engBlocked = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-blocked');
      const engPending = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-pending');
      const engRunning = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-running');

      assert.equal(engBlocked?.status, 'cancelled', 'blocked engine should be cancelled');
      assert.equal(engBlocked?.block, undefined, 'block field should be cleared on cancelled engine');
      assert.equal(engPending?.status, 'cancelled', 'pending engine should be cancelled');
      assert.equal(engRunning?.status, 'failed', 'running engine should be failed');
    });
  });

  // ── CDC handler ignores blocked status (V22, R29) ──────────────────────

  describe('CDC handler does not fire for blocked rig status (V22, R29)', () => {
    it('writ remains active when rig transitions to blocked — no CDC writ transition', async () => {
      const cdcBlockEngine: EngineDesign = {
        id: 'cdc-blk-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'cdc-hold', condition: { w: true } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'cdc-blk-engine': cdcBlockEngine },
        { engines: [{ id: 'sole', designId: 'cdc-blk-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'cdc-hold',
          conditionSchema: z.object({ w: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      const writ = await fix.clerk.post({ title: 'CDC Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn (writ → active)
      await fix.spider.crawl(); // run → rig-blocked

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');

      // Writ should remain 'active' — CDC ignores 'blocked' status
      const currentWrit = await fix.clerk.show(writ.id);
      assert.equal(
        currentWrit.status,
        'active',
        'writ should remain active when rig is blocked; CDC must not fire for blocked status',
      );
    });
  });

  // ── rig-list blocked filter (V13, R18) ─────────────────────────────────

  describe('rig-list — blocked status filter (V13, R18)', () => {
    it('returns blocked rigs when filtering by blocked status', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const rigId = generateId('rig', 4);
      await book.put({
        id: rigId,
        writId: generateId('wrt', 4),
        status: 'blocked',
        engines: [],
        createdAt: new Date().toISOString(),
      });

      const blocked = await fix.spider.list({ status: 'blocked' });
      assert.equal(blocked.length, 1, 'should return exactly one blocked rig');
      assert.equal(blocked[0].id, rigId);
      assert.equal(blocked[0].status, 'blocked');
    });

    it('does not return blocked rig when filtering by running status', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      await book.put({
        id: generateId('rig', 4),
        writId: generateId('wrt', 4),
        status: 'blocked',
        engines: [],
        createdAt: new Date().toISOString(),
      });

      const running = await fix.spider.list({ status: 'running' });
      assert.equal(running.length, 0, 'should not return blocked rig when filtering by running');
    });

    it('rig-list tool accepts "blocked" as a valid status parameter', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      await book.put({
        id: generateId('rig', 4),
        writId: generateId('wrt', 4),
        status: 'blocked',
        engines: [],
        createdAt: new Date().toISOString(),
      });

      // Call the tool handler directly with status: 'blocked'
      // TypeScript will catch invalid enum values at compile time
      const result = await rigListTool.handler({ status: 'blocked' }) as RigDoc[];
      assert.equal(result.length, 1);
      assert.equal(result[0].status, 'blocked');
    });
  });

  // ── rig-resume tool — handler delegation (R16, P1) ────────────────────

  describe('rig-resume tool — handler delegation (R16)', () => {
    it('handler calls spider.resume() and returns { ok: true } when engine is blocked', async () => {
      const holdEngine2: EngineDesign = {
        id: 'hold2-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          if (!ctx.priorBlock) {
            return { status: 'blocked' as const, blockType: 'hold2-block', condition: { hold: true } };
          }
          return { status: 'completed' as const, yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'hold2-engine': holdEngine2 },
        { engines: [{ id: 'sole', designId: 'hold2-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'hold2-block',
          conditionSchema: z.object({ hold: z.boolean() }),
          async check(): Promise<CheckResult> { return { status: 'pending' }; },
        }],
      );

      await fix.clerk.post({ title: 'Resume Tool Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');

      // Call the tool handler directly — it should delegate to spider.resume()
      const result = await rigResumeTool.handler({ rigId: rig.id, engineId: 'sole' });
      assert.deepEqual(result, { ok: true }, 'rig-resume handler should return { ok: true }');

      // Verify the block was cleared
      const [updatedRig] = await fix.spider.list();
      assert.equal(updatedRig.status, 'running', 'rig should be running after resume');
      const engine = updatedRig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'pending', 'engine should be pending after resume');
      assert.equal(engine?.block, undefined, 'block field should be cleared');
    });

    it('handler propagates error when engine is not blocked', async () => {
      const fix = buildBlockingFixture();
      await fix.clerk.post({ title: 'Resume Error Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      const [rig] = await fix.spider.list();
      const pendingEngine = rig.engines.find((e: EngineInstance) => e.status === 'pending');
      assert.ok(pendingEngine !== undefined, 'should have a pending engine');

      // Calling resume on a non-blocked engine should reject
      await assert.rejects(
        () => rigResumeTool.handler({ rigId: rig.id, engineId: pendingEngine!.id }),
        (err: Error) => {
          assert.ok(err.message.includes('is not blocked'), `error should include "is not blocked", got: ${err.message}`);
          return true;
        },
      );
    });
  });

  // ── rig-show instructions mention blocked (R19) ────────────────────────

  describe('rig-show instructions mention blocked engines and block metadata (R19)', () => {
    it('instructions text contains blocked engine and block record references', () => {
      // ToolDefinition exposes `instructions` as a first-class property — no cast needed.
      const instructions = rigShowTool.instructions ?? '';
      assert.ok(
        instructions.toLowerCase().includes('block'),
        `rig-show instructions should mention block/blocked, got: "${instructions}"`,
      );
      // Verify specific metadata fields are mentioned
      assert.ok(
        instructions.includes('blockedAt') || instructions.includes('lastCheckedAt'),
        `rig-show instructions should mention block timestamp fields, got: "${instructions}"`,
      );
    });
  });

  // ── Re-exports from index (R28) ────────────────────────────────────────

  describe('BlockRecord and BlockType re-exported from spider index (R28)', () => {
    it('BlockRecord and BlockType types are exported from the package index', async () => {
      // Dynamic import to verify the index exports these at runtime
      const idx = await import('./index.ts');
      // The types BlockRecord and BlockType are type-only exports; no runtime assertion is
      // possible. Instead confirm the correct module loaded by asserting the default export
      // is a spider apparatus plugin object with the expected apparatus shape.
      assert.ok(idx !== null && typeof idx === 'object', 'spider index should export without error');
      assert.ok('default' in idx, 'spider index should have a default export');
      const plugin = idx.default as unknown;
      assert.ok(typeof plugin === 'object' && plugin !== null, 'default export should be an object');
      assert.ok('apparatus' in (plugin as object), 'default export should have an apparatus property (spider apparatus plugin)');
    });
  });

  // ── Checker failure path (R4, R5, R8, R9) ────────────────────────────────

  describe('Checker failure path — permanent block failure', () => {
    it('checker returns { status: "failed" } with no reason — engine/rig failed permanently', async () => {
      const failingEngine: EngineDesign = {
        id: 'fail-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'perm-fail-block', condition: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'fail-engine': failingEngine },
        { engines: [{ id: 'sole', designId: 'fail-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'perm-fail-block',
          conditionSchema: z.object({}),
          async check(): Promise<CheckResult> { return { status: 'failed' }; },
        }],
      );

      await fix.clerk.post({ title: 'Failing Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      const result = await fix.spider.crawl(); // checkBlocked → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      assert.equal(engine.status, 'failed');
      assert.ok(
        engine.error?.includes('failed permanently'),
        `expected error to include "failed permanently", got: ${engine.error}`,
      );
      assert.ok(
        engine.error?.includes('perm-fail-block'),
        `expected error to include block type name, got: ${engine.error}`,
      );
    });

    it('checker returns { status: "failed", reason: "resource deleted" } — error includes reason', async () => {
      const failReasonEngine: EngineDesign = {
        id: 'fail-reason-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'reason-fail-block', condition: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'fail-reason-engine': failReasonEngine },
        { engines: [{ id: 'sole', designId: 'fail-reason-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'reason-fail-block',
          conditionSchema: z.object({}),
          async check(): Promise<CheckResult> { return { status: 'failed', reason: 'resource deleted' }; },
        }],
      );

      await fix.clerk.post({ title: 'Reason Fail Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      const result = await fix.spider.crawl(); // checkBlocked → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      assert.ok(
        engine.error?.includes('failed: resource deleted'),
        `expected error to include "failed: resource deleted", got: ${engine.error}`,
      );
    });

    it('checker failure with multiple engines — sibling cancelled', async () => {
      const blockingA: EngineDesign = {
        id: 'sib-blocking-a',
        async run() {
          return { status: 'blocked' as const, blockType: 'sib-fail-block', condition: {} };
        },
      };
      const dependentB: EngineDesign = {
        id: 'sib-dependent-b',
        async run() { return { status: 'completed' as const, yields: {} }; },
      };
      const fix = buildBlockingFixture(
        { 'sib-blocking-a': blockingA, 'sib-dependent-b': dependentB },
        {
          engines: [
            { id: 'a', designId: 'sib-blocking-a', givens: {} },
            { id: 'b', designId: 'sib-dependent-b', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [{
          id: 'sib-fail-block',
          conditionSchema: z.object({}),
          async check(): Promise<CheckResult> { return { status: 'failed' }; },
        }],
      );

      await fix.clerk.post({ title: 'Sibling Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run a → rig-blocked (b depends on a)

      const result = await fix.spider.crawl(); // checkBlocked → a fails → rig failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      const engineA = rig.engines.find((e: EngineInstance) => e.id === 'a');
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'b');
      assert.equal(engineA?.status, 'failed');
      assert.equal(engineB?.status, 'cancelled');
    });

    it('checker failure does not update lastCheckedAt (R8)', async () => {
      const noLastCheckedEngine: EngineDesign = {
        id: 'no-lc-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'no-lc-block', condition: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'no-lc-engine': noLastCheckedEngine },
        { engines: [{ id: 'sole', designId: 'no-lc-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'no-lc-block',
          conditionSchema: z.object({}),
          async check(): Promise<CheckResult> { return { status: 'failed' }; },
        }],
      );

      await fix.clerk.post({ title: 'No LC Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → blocked

      // Verify no lastCheckedAt before failure crawl
      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.block?.lastCheckedAt, undefined, 'lastCheckedAt should be unset before check');

      await fix.spider.crawl(); // checkBlocked → failed

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      // Engine is now failed; the block record should be gone (failEngine cleared it)
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'failed');
      // lastCheckedAt was never set (failure path skips it)
    });

    it('checker failure on rig with blocked status — rig transitions to failed', async () => {
      const blockedThenFailEngine: EngineDesign = {
        id: 'btf-engine',
        async run() {
          return { status: 'blocked' as const, blockType: 'btf-block', condition: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'btf-engine': blockedThenFailEngine },
        { engines: [{ id: 'sole', designId: 'btf-engine', givens: {} }], resolutionEngine: 'sole' },
        [{
          id: 'btf-block',
          conditionSchema: z.object({}),
          async check(): Promise<CheckResult> { return { status: 'failed', reason: 'gone' }; },
        }],
      );

      await fix.clerk.post({ title: 'BTF Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → rig-blocked (sole engine)

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked', 'rig should be blocked before failure crawl');

      const result = await fix.spider.crawl(); // checkBlocked → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed', 'rig should transition from blocked to failed');
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine?.error?.includes('gone'), `expected error to include "gone", got: ${engine?.error}`);
    });
  });

  // ── writ-status checker additional cases (R12–R16) ─────────────────────

  describe('writ-status checker — additional failure cases', () => {
    it('returns failed with terminal-mismatch reason when writ is failed but target is completed', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'active');
      await fix.clerk.transition(writ.id, 'failed');

      const blockType = fix.spider.getBlockType('writ-status');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetStatus: 'completed' });
      assert.deepEqual(result, {
        status: 'failed',
        reason: 'Writ reached terminal status "failed" instead of "completed"',
      });
    });

    it('returns cleared when writ is at failed status and target is failed (target match wins)', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'active');
      await fix.clerk.transition(writ.id, 'failed');

      const blockType = fix.spider.getBlockType('writ-status');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetStatus: 'failed' });
      assert.deepEqual(result, { status: 'cleared' }, 'target match takes priority over terminal-mismatch');
    });

    it('returns failed with terminal-mismatch reason when writ is cancelled but target is completed', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'cancelled');

      const blockType = fix.spider.getBlockType('writ-status');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetStatus: 'completed' });
      assert.deepEqual(result, {
        status: 'failed',
        reason: 'Writ reached terminal status "cancelled" instead of "completed"',
      });
    });

    it('returns pending when writ is at non-terminal, non-target status', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      // writ starts at 'ready' status, which is neither completed nor a terminal mismatch for 'completed' target

      const blockType = fix.spider.getBlockType('writ-status');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetStatus: 'completed' });
      assert.deepEqual(result, { status: 'pending' }, 'non-terminal non-target status should return pending');
    });
  });

  // ── Built-in block types (R22–R25, V16–V18) ───────────────────────────

  describe('Built-in block types', () => {

    // ── writ-status (R23, V16) ───────────────────────────────────────────

    describe('writ-status block type (R23, V16)', () => {
      it('checker returns pending when writ is not at target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });

        const blockType = fix.spider.getBlockType('writ-status');
        assert.ok(blockType !== undefined, 'writ-status block type should be registered');

        const result = await blockType.check({ writId: writ.id, targetStatus: 'completed' });
        assert.deepEqual(result, { status: 'pending' }, 'checker should return pending when writ is not completed');
      });

      it('checker returns cleared when writ reaches target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
        await fix.clerk.transition(writ.id, 'active');
        await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

        const blockType = fix.spider.getBlockType('writ-status');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: writ.id, targetStatus: 'completed' });
        assert.deepEqual(result, { status: 'cleared' }, 'checker should return cleared when writ is completed');
      });

      it('checker returns failed when writ does not exist', async () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-status');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: 'nonexistent-writ-99', targetStatus: 'completed' });
        assert.deepEqual(result, { status: 'failed', reason: 'Writ not found' }, 'checker should return failed when writ not found');
      });

      it('writ-status has pollIntervalMs of 10000 (R23)', () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-status');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 10_000, 'writ-status should have 10s poll interval');
      });
    });

    // ── scheduled-time (R24, V17) ───────────────────────────────────────

    describe('scheduled-time block type (R24, V17)', () => {
      it('checker returns pending for a future timestamp', async () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);

        const futureTime = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
        const result = await blockType.check({ resumeAt: futureTime });
        assert.deepEqual(result, { status: 'pending' }, 'checker should return pending for future timestamp');
      });

      it('checker returns cleared for a past timestamp', async () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);

        const pastTime = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago
        const result = await blockType.check({ resumeAt: pastTime });
        assert.deepEqual(result, { status: 'cleared' }, 'checker should return cleared for past timestamp');
      });

      it('scheduled-time has pollIntervalMs of 30000 (R24)', () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 30_000, 'scheduled-time should have 30s poll interval');
      });
    });

    // ── book-updated (R25, V18) ─────────────────────────────────────────

    describe('book-updated block type (R25, V18)', () => {
      it('checker returns pending when book is empty', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'empty-data' }, {});

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'empty-data' });
        assert.deepEqual(result, { status: 'pending' }, 'checker should return pending when book is empty');
      });

      it('checker returns cleared when book has at least one document', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'nonempty-data' }, {});
        const book = fix.stacks.book<{ id: string; value: string }>('test-owner', 'nonempty-data');
        await book.put({ id: 'doc-1', value: 'hello' });

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'nonempty-data' });
        assert.deepEqual(result, { status: 'cleared' }, 'checker should return cleared when book has documents');
      });

      it('checker returns pending when specific documentId is not found', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'doc-data' }, {});

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({
          ownerId: 'test-owner',
          book: 'doc-data',
          documentId: 'nonexistent-doc',
        });
        assert.deepEqual(result, { status: 'pending' }, 'checker should return pending when document not found');
      });

      it('checker returns cleared when specific documentId is found', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'doc-data-2' }, {});
        const book = fix.stacks.book<{ id: string; content: string }>('test-owner', 'doc-data-2');
        await book.put({ id: 'target-doc', content: 'data' });

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({
          ownerId: 'test-owner',
          book: 'doc-data-2',
          documentId: 'target-doc',
        });
        assert.deepEqual(result, { status: 'cleared' }, 'checker should return cleared when document exists');
      });

      it('book-updated has pollIntervalMs of 10000 (R25)', () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 10_000, 'book-updated should have 10s poll interval');
      });
    });

  }); // Built-in block types

}); // Spider — engine blocking on external conditions

// ── Kit contributions — rig templates and mappings ─────────────────

describe('Kit contributions — rig templates and mappings', () => {
  // Helper to make a LoadedKit with the given kit contributions
  function makeKit(id: string, kit: Record<string, unknown>): LoadedKit {
    return { packageName: `@test/${id}`, id, version: '0.0.0', kit };
  }

  // Helper to collect console.warn calls
  function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    return { warnings, restore: () => { console.warn = original; } };
  }

  // Simple 1-engine template using the built-in 'draft' designId
  const SIMPLE_TEMPLATE: RigTemplate = {
    engines: [{ id: 'step1', designId: 'draft', givens: { writ: '$writ' } }],
  };

  afterEach(() => {
    clearGuild();
  });

  describe('V1 — kit template registered under qualified name', () => {
    it('registers kit template under pluginId.templateName', async () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const fix = buildFixture({}, { status: 'completed' }, { kits: [kit] });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines.length, 1);
      assert.equal(rig!.engines[0].id, 'step1');
      assert.equal(rig!.engines[0].designId, 'draft');
    });

    it('skips kit contribution when config defines the qualified name', async () => {
      const differentTemplate: RigTemplate = {
        engines: [{ id: 'config-step', designId: 'draft', givens: {} }],
      };
      // Config defines 'quality-tools.audit' directly
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const fix = buildFixture({
        spider: {
          rigTemplates: { 'quality-tools.audit': differentTemplate },
          rigTemplateMappings: { mandate: 'quality-tools.audit' },
        },
      }, { status: 'completed' }, { kits: [kit] });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      // Should use config template (1 engine named 'config-step'), not kit template
      assert.equal(rig!.engines[0].id, 'config-step');
    });
  });

  describe('V2 — dependency-scoped designId validation', () => {
    it('rejects kit template referencing designId from undeclared plugin', () => {
      const { warnings, restore } = captureWarnings();
      try {
        // Kit has no requires, but references a non-builtin engine from 'fabricator'
        const customEngineKit = makeKit('fabricator', {
          engines: {
            custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) },
          },
        });
        const badKit = makeKit('quality-tools', {
          rigTemplates: {
            audit: {
              engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }],
            },
          },
        });
        // quality-tools has no requires: ['fabricator'], so custom-engine is disallowed
        buildFixture({}, { status: 'completed' }, { kits: [customEngineKit, badKit] });
        assert.ok(
          warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
          `Expected warning about quality-tools audit, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('allows designId from declared dependency', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const customEngineKit = makeKit('fabricator', {
          engines: {
            custom: { id: 'custom-engine', run: async () => ({ status: 'completed', yields: {} }) },
          },
        });
        const goodKit = makeKit('quality-tools', {
          requires: ['fabricator'],
          rigTemplates: {
            audit: {
              engines: [{ id: 'step1', designId: 'custom-engine', givens: {} }],
            },
          },
          rigTemplateMappings: { mandate: 'quality-tools.audit' },
        });
        buildFixture({}, { status: 'completed' }, { kits: [customEngineKit, goodKit] });
        assert.ok(
          !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates.audit')),
          `Unexpected warning: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('allows built-in Spider engine designIds without any requires', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('quality-tools', {
          // No requires — but uses built-in 'draft' engine
          rigTemplates: { audit: SIMPLE_TEMPLATE },
          rigTemplateMappings: { mandate: 'quality-tools.audit' },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          !warnings.some(w => w.includes('quality-tools') && w.includes('rigTemplates')),
          `Unexpected warning: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });
  });

  describe('V4 — kit mapping routes writ type to template', () => {
    it('uses kit-contributed mapping when spawning', async () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const fix = buildFixture(
        { spider: { variables: { role: 'artificer' } } },
        { status: 'completed' },
        { kits: [kit] }
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines.length, 1);
      assert.equal(rig!.engines[0].id, 'step1');
    });

    it('config mapping overrides kit mapping for same writ type', async () => {
      const kit = makeKit('quality-tools', {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      });
      const configTemplate: RigTemplate = {
        engines: [{ id: 'config-engine', designId: 'draft', givens: {} }],
      };
      const fix = buildFixture(
        {
          spider: {
            rigTemplates: { 'my-template': configTemplate },
            rigTemplateMappings: { mandate: 'my-template' },
          },
        },
        { status: 'completed' },
        { kits: [kit] }
      );

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      // Should use config template (engine named 'config-engine')
      assert.equal(rig!.engines[0].id, 'config-engine');
    });

    it('emits warning when two kits map same writ type (first wins)', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kitA = makeKit('kit-a', {
          rigTemplates: { tmpl: SIMPLE_TEMPLATE },
          rigTemplateMappings: { mandate: 'kit-a.tmpl' },
        });
        const kitB = makeKit('kit-b', {
          rigTemplates: { tmpl: SIMPLE_TEMPLATE },
          rigTemplateMappings: { mandate: 'kit-b.tmpl' },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kitA, kitB] });
        assert.ok(
          warnings.some(w => w.includes('kit-b') && w.includes('mandate')),
          `Expected warning about kit-b duplicate mandate mapping, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });
  });

  describe('V5, V6 — lookup chain (mappings and default template)', () => {
    it('config rigTemplateMappings routes writ type (R10)', async () => {
      const configTemplate: RigTemplate = {
        engines: [{ id: 'standard-engine', designId: 'draft', givens: {} }],
      };
      const fix = buildFixture({
        spider: {
          rigTemplates: { standard: configTemplate },
          rigTemplateMappings: { mandate: 'standard' },
        },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'standard-engine');
    });

    it('default mapping serves as fallback for unmatched writ type (R11)', async () => {
      const fix = buildFixture({
        spider: {
          rigTemplates: { standard: { engines: [{ id: 'std', designId: 'draft', givens: {} }] } },
          rigTemplateMappings: { default: 'standard' },
          variables: {},
        },
        clerk: { writTypes: [{ name: 'custom-type' }] },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'custom-type' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'std');
    });

    it('uses default template when no mappings defined (R9 step 3)', async () => {
      const fix = buildFixture({
        spider: {
          rigTemplates: { default: { engines: [{ id: 'fallback', designId: 'draft', givens: {} }] } },
          variables: {},
        },
        clerk: { writTypes: [{ name: 'any-type' }] },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'any-type' });
      await fix.spider.crawl();
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'fallback');
    });
  });

  describe('V7 — dangling mapping references', () => {
    it('warns and removes kit mapping pointing to nonexistent template', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('kit-a', {
          // No rigTemplates contributed, but mapping points to kit-a.nonexistent
          rigTemplateMappings: { mandate: 'kit-a.nonexistent' },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('kit-a.nonexistent') || w.includes('template not found')),
          `Expected dangling mapping warning, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('throws when config mapping points to nonexistent template', () => {
      assert.throws(() => {
        buildFixture({
          spider: {
            rigTemplateMappings: { mandate: 'nonexistent-template' },
          },
        });
      }, /nonexistent-template/);
    });
  });

  describe('V8 — Spider consumes declaration', () => {
    it('declares consumes with blockTypes, rigTemplates, rigTemplateMappings', () => {
      const plugin = createSpider();
      assert.ok('apparatus' in plugin);
      const apparatus = (plugin as { apparatus: { consumes?: string[] } }).apparatus;
      assert.ok(Array.isArray(apparatus.consumes));
      assert.ok(apparatus.consumes!.includes('blockTypes'));
      assert.ok(apparatus.consumes!.includes('rigTemplates'));
      assert.ok(apparatus.consumes!.includes('rigTemplateMappings'));
    });
  });

  describe('V10 — Phase 1b and Phase 2 scanning', () => {
    it('Phase 1b: picks up apparatus supportKit rigTemplates at startup', async () => {
      const supportKit = {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'quality-tools.audit' },
      };
      const app: LoadedApparatus = {
        packageName: '@test/quality-tools',
        id: 'quality-tools',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit,
        },
      };
      const fix = buildFixture({}, { status: 'completed' }, { apparatuses: [app] });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });

    it('apparatus supportKit contributes rig templates and mappings (via Wire phase)', async () => {
      const supportKit = {
        rigTemplates: { audit: SIMPLE_TEMPLATE },
        rigTemplateMappings: { mandate: 'late-app.audit' },
      };
      const lateApp: LoadedApparatus = {
        packageName: '@test/late-app',
        id: 'late-app',
        version: '0.0.0',
        apparatus: {
          requires: [],
          start: () => {},
          supportKit,
        },
      };

      const fix = buildFixture({}, { status: 'completed' }, { apparatuses: [lateApp] });

      const writ = await fix.clerk.post({ title: 'Late test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });
  });

  describe('V12 — malformed kit contributions', () => {
    it('warns when kit rigTemplates is not an object', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('bad-kit', { rigTemplates: 'invalid' });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates')),
          `Expected warning about bad-kit rigTemplates, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('warns when kit template is missing engines array', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('bad-kit', {
          rigTemplates: { broken: { notEngines: [] } },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('bad-kit') && w.includes('rigTemplates.broken')),
          `Expected warning about bad-kit rigTemplates.broken, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });
  });

  describe('Cross-kit mapping reference (test 14)', () => {
    it('kit B can reference a template contributed by kit A', async () => {
      const kitA = makeKit('kit-a', {
        rigTemplates: { pipeline: SIMPLE_TEMPLATE },
      });
      const kitB = makeKit('kit-b', {
        rigTemplateMappings: { mandate: 'kit-a.pipeline' },
      });
      const fix = buildFixture({}, { status: 'completed' }, { kits: [kitA, kitB] });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'mandate' });
      const result = await fix.spider.crawl();
      assert.equal(result?.action, 'rig-spawned');
      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig);
      assert.equal(rig!.engines[0].id, 'step1');
    });
  });

  describe('No template and no mapping (test 17)', () => {
    it('throws with descriptive error when no template found', async () => {
      // Config has no templates, no mappings, no default
      // Set rigTemplates to undefined to override the buildFixture default
      const fix = buildFixture({
        spider: { rigTemplates: undefined, variables: {} },
        clerk: { writTypes: [{ name: 'orphan-type' }] },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'orphan-type' });
      await assert.rejects(
        () => fix.spider.crawl(),
        /orphan-type/,
      );
    });
  });
});

// ── $yields.* reference tests ─────────────────────────────────────────

describe('$yields.* reference support', () => {
  // Helper to make a LoadedKit with the given kit contributions
  function makeKit(id: string, kit: Record<string, unknown>): LoadedKit {
    return { packageName: `@test/${id}`, id, version: '0.0.0', kit };
  }

  // Helper to collect console.warn calls
  function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    return { warnings, restore: () => { console.warn = original; } };
  }

  afterEach(() => {
    clearGuild();
  });

  // ── Validation — config templates (throw) ─────────────────────────

  describe('Validation — config templates', () => {
    it('V3/R3/R5 — unknown engine_id throws with "[spider]" prefix and "not an engine in this template"', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'step1', designId: 'seal', givens: { x: '$yields.nonexistent.foo' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.startsWith('[spider]'), err.message);
          assert.ok(err.message.includes('nonexistent'), err.message);
          assert.ok(err.message.includes('not an engine in this template'), err.message);
          return true;
        },
      );
    });

    it('V4/R4/R6 — non-upstream engine_id throws "not upstream of"', () => {
      // engine a references yields from b, but b is downstream of a (a → b, not b → a)
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'a', designId: 'seal', givens: { x: '$yields.b.foo' } },
                  { id: 'b', designId: 'draft', upstream: ['a'], givens: { writ: '$writ' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.startsWith('[spider]'), err.message);
          assert.ok(err.message.includes('"b" is not upstream of "a"'), err.message);
          return true;
        },
      );
    });

    it('V5/R4 — transitive upstream reference is valid (does not throw)', () => {
      // a → b → c; c references $yields.a.foo (a is transitively upstream of c)
      assert.doesNotThrow(() =>
        buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'a', designId: 'seal', givens: {} },
                  { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
                  { id: 'c', designId: 'seal', upstream: ['b'], givens: { x: '$yields.a.foo' } },
                ],
              },
            },
          },
        })
      );
    });

    it('self-reference fails upstream reachability check', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'solo', designId: 'seal', givens: { x: '$yields.solo.foo' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('"solo" is not upstream of "solo"'), err.message);
          return true;
        },
      );
    });

    it('curly-brace form ${yields.ghost.foo} also fails with unknown engine error', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'only', designId: 'seal', givens: { x: '${yields.ghost.foo}' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.startsWith('[spider]'), err.message);
          assert.ok(err.message.includes('not an engine in this template'), err.message);
          return true;
        },
      );
    });

    it('invalid syntax $yields.draft (missing property segment) is rejected as unrecognized variable', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'a', designId: 'seal', givens: {} },
                  { id: 'b', designId: 'seal', upstream: ['a'], givens: { x: '$yields.a' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('unrecognized variable'), err.message);
          return true;
        },
      );
    });

    it('valid $yields reference passes validation without throwing', () => {
      assert.doesNotThrow(() =>
        buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'first', designId: 'seal', givens: {} },
                  { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '$yields.first.path' } },
                ],
              },
            },
          },
        })
      );
    });

    it('curly-brace ${yields.*.*} form passes validation when engine is upstream', () => {
      assert.doesNotThrow(() =>
        buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'first', designId: 'seal', givens: {} },
                  { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '${yields.first.path}' } },
                ],
              },
            },
          },
        })
      );
    });
  });

  // ── Validation — kit templates (warn and skip) ─────────────────────

  describe('Validation — kit templates (warn and skip)', () => {
    it('V6/R7 — kit template with unknown engine_id warns and skips template', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('my-kit', {
          rigTemplates: {
            pipeline: {
              engines: [
                { id: 'step1', designId: 'draft', givens: { writ: '$writ' } },
                // References $yields.nonexistent.foo where 'nonexistent' is not an engine
                { id: 'step2', designId: 'seal', upstream: ['step1'], givens: { x: '$yields.nonexistent.foo' } },
              ],
            },
          },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        // Template should be skipped: a warning is emitted
        assert.ok(
          warnings.some(w => w.includes('my-kit') && w.includes('not an engine in this template')),
          `Expected warning about unknown engine, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('kit template with non-upstream engine_id warns "not upstream of" and skips', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('my-kit', {
          rigTemplates: {
            pipeline: {
              engines: [
                // 'a' references 'b' but 'b' is downstream of 'a'
                { id: 'a', designId: 'draft', givens: { writ: '$writ', x: '$yields.b.foo' } },
                { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
              ],
            },
          },
        });
        buildFixture({}, { status: 'completed' }, { kits: [kit] });
        assert.ok(
          warnings.some(w => w.includes('my-kit') && w.includes('not upstream of')),
          `Expected "not upstream of" warning, got: ${JSON.stringify(warnings)}`
        );
      } finally {
        restore();
      }
    });

    it('kit template with valid yield reference is registered without warnings', () => {
      const { warnings, restore } = captureWarnings();
      try {
        const kit = makeKit('my-kit', {
          rigTemplates: {
            pipeline: {
              engines: [
                { id: 'step1', designId: 'draft', givens: { writ: '$writ' } },
                { id: 'step2', designId: 'seal', upstream: ['step1'], givens: { p: '$yields.step1.path' } },
              ],
            },
          },
          rigTemplateMappings: { task: 'my-kit.pipeline' },
        });
        const fix = buildFixture({}, { status: 'completed' }, { kits: [kit] });
        // No warnings from yield validation
        const yieldWarnings = warnings.filter(w => w.includes('not an engine') || w.includes('not upstream'));
        assert.equal(yieldWarnings.length, 0, `Unexpected yield warnings: ${JSON.stringify(yieldWarnings)}`);
        // Template should be registered — listTemplates includes it
        const templates = fix.spider.listTemplates();
        assert.ok(templates.some(t => t.name === 'my-kit.pipeline'), 'Template should be registered');
      } finally {
        restore();
      }
    });
  });

  // ── Spawn-time pass-through (R8) ──────────────────────────────────

  describe('Spawn-time pass-through (R8)', () => {
    it('V7/R8 — yield reference strings survive spawn time in givensSpec', async () => {
      const fix = buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'first', designId: 'seal', givens: {} },
                { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '$yields.first.path' } },
              ],
            },
          },
          variables: {},
        },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body' });
      await fix.spider.crawl(); // spawn

      const rig = await fix.spider.forWrit(writ.id);
      assert.ok(rig, 'rig should exist');
      const secondEngine = rig!.engines.find(e => e.id === 'second');
      assert.ok(secondEngine, 'second engine should exist');
      // The yield ref string must be preserved as-is in givensSpec
      assert.equal(
        secondEngine!.givensSpec.p,
        '$yields.first.path',
        'yield ref should be stored as literal string in givensSpec',
      );
    });

    it('curly-brace form ${yields.*.*} is also preserved as-is in givensSpec', async () => {
      const fix = buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [
                { id: 'first', designId: 'seal', givens: {} },
                { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '${yields.first.path}' } },
              ],
            },
          },
          variables: {},
        },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body' });
      await fix.spider.crawl(); // spawn

      const rig = await fix.spider.forWrit(writ.id);
      const secondEngine = rig!.engines.find(e => e.id === 'second');
      assert.ok(secondEngine, 'second engine should exist');
      // Curly-brace form is preserved literally too
      assert.equal(
        secondEngine!.givensSpec.p,
        '${yields.first.path}',
        'curly-brace yield ref should be preserved as-is in givensSpec',
      );
    });
  });

  // ── Run-time resolution (R1, R2) ──────────────────────────────────

  describe('Run-time resolution (R1, R2)', () => {
    /**
     * Build a minimal fixture for yield-ref runtime tests.
     *
     * Custom engine designs must be registered in the Fabricator BEFORE Spider
     * starts (Spider's validateTemplates() runs at start time and checks the
     * Fabricator for known designIds). This mirrors the pattern used by
     * buildBlockingFixture() in the blocking tests.
     */
    function buildYieldFixture(
      customEngines: Record<string, EngineDesign>,
      template: RigTemplate,
    ): { stacks: StacksApi; clerk: ClerkApi; spider: SpiderApi } {
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
        spider: { rigTemplates: { default: template }, variables: {} },
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
        startupWarnings() { return []; },
      };

      setGuild(fakeGuild);

      const noopCtx = { on: () => {} };
      stacksApparatus.start(noopCtx);
      const stacks = stacksApparatus.provides as StacksApi;
      apparatusMap.set('stacks', stacks);

      memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
        indexes: ['status', 'type', 'createdAt', ['status', 'type'], ['status', 'createdAt']],
      });
      memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
        indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
      });
      memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
        indexes: ['startedAt', 'status'],
      });

      // Minimal mock animator — just enough to satisfy the Spider's session lookup
      const mockAnimatorApi: AnimatorApi = {
        summon(): AnimateHandle {
          throw new Error('summon() not expected in yield-ref tests');
        },
        animate(): AnimateHandle {
          throw new Error('animate() not expected in yield-ref tests');
        },
      };
      apparatusMap.set('animator', mockAnimatorApi);

      clerkApparatus.start(noopCtx);
      const clerk = clerkApparatus.provides as ClerkApi;
      apparatusMap.set('clerk', clerk);

      const { ctx: fabricatorCtx, fire: fireFabricator } = buildCtx();
      fabricatorApparatus.start(fabricatorCtx);
      const fabricator = fabricatorApparatus.provides as FabricatorApi;
      apparatusMap.set('fabricator', fabricator);

      // Register custom engines in Fabricator BEFORE Spider starts so that
      // validateTemplates() (which runs during spider.start()) sees them.
      const customEnginePlugin: LoadedApparatus = {
        packageName: '@test/custom-engines',
        id: 'test-custom-engines',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { engines: customEngines },
          provides: {},
          start() {},
        },
      };
      void fireFabricator('plugin:initialized', customEnginePlugin);

      // Also fire the Spider's own designs so they're registered
      const spiderLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus',
        id: 'spider',
        version: '0.0.0',
        apparatus: spiderApparatus,
      };
      void fireFabricator('plugin:initialized', spiderLoaded);

      spiderApparatus.start(noopCtx);
      const spider = spiderApparatus.provides as SpiderApi;
      apparatusMap.set('spider', spider);

      return { stacks, clerk, spider };
    }

    it('V1/R1 — second engine receives resolved yield value in run()', async () => {
      let capturedGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'yr-first',
        label: 'YR First',
        run: async () => ({ status: 'completed' as const, yields: { path: '/tmp/workdir' } }),
      };
      const secondDesign: EngineDesign = {
        id: 'yr-second',
        label: 'YR Second',
        run: async (givens: Record<string, unknown>) => {
          capturedGivens = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };

      const { clerk, spider } = buildYieldFixture(
        { 'yr-first': firstDesign, 'yr-second': secondDesign },
        {
          engines: [
            { id: 'first', designId: 'yr-first', givens: {} },
            { id: 'second', designId: 'yr-second', upstream: ['first'], givens: { dir: '$yields.first.path' } },
          ],
        },
      );

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first (clockwork → completed)
      await spider.crawl(); // run second

      assert.ok(capturedGivens !== null, 'second engine run() should have been called');
      assert.equal(capturedGivens!.dir, '/tmp/workdir', 'yield ref should resolve to first engine path');
    });

    it('V2/R1 — curly-brace form ${yields.*.*} resolves identically', async () => {
      let capturedGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'cb-first',
        label: 'CB First',
        run: async () => ({ status: 'completed' as const, yields: { path: '/curly/path' } }),
      };
      const secondDesign: EngineDesign = {
        id: 'cb-second',
        label: 'CB Second',
        run: async (givens: Record<string, unknown>) => {
          capturedGivens = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };

      const { clerk, spider } = buildYieldFixture(
        { 'cb-first': firstDesign, 'cb-second': secondDesign },
        {
          engines: [
            { id: 'first', designId: 'cb-first', givens: {} },
            { id: 'second', designId: 'cb-second', upstream: ['first'], givens: { dir: '${yields.first.path}' } },
          ],
        },
      );

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(capturedGivens !== null, 'second engine run() should have been called');
      assert.equal((capturedGivens as Record<string, unknown>).dir, '/curly/path');
    });

    it('V1 (multiple refs) — multiple yield refs in one engine all resolve', async () => {
      let capturedGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'mr-first',
        label: 'MR First',
        run: async () => ({ status: 'completed' as const, yields: { foo: 'hello', bar: 42 } }),
      };
      const secondDesign: EngineDesign = {
        id: 'mr-second',
        label: 'MR Second',
        run: async (givens: Record<string, unknown>) => {
          capturedGivens = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };

      const { clerk, spider } = buildYieldFixture(
        { 'mr-first': firstDesign, 'mr-second': secondDesign },
        {
          engines: [
            { id: 'first', designId: 'mr-first', givens: {} },
            {
              id: 'second',
              designId: 'mr-second',
              upstream: ['first'],
              givens: { x: '$yields.first.foo', y: '$yields.first.bar', z: 'literal' },
            },
          ],
        },
      );

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(capturedGivens !== null, 'second engine should have been called');
      const g = capturedGivens as Record<string, unknown>;
      assert.equal(g.x, 'hello', 'x should resolve to first.foo');
      assert.equal(g.y, 42, 'y should resolve to first.bar');
      assert.equal(g.z, 'literal', 'z literal should pass through');
    });

    it('R2 — yield property missing from upstream yields causes key omission', async () => {
      let capturedGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'mp-first',
        label: 'MP First',
        // yields does NOT contain 'nonExistentProp'
        run: async () => ({ status: 'completed' as const, yields: { someProp: 'value' } }),
      };
      const secondDesign: EngineDesign = {
        id: 'mp-second',
        label: 'MP Second',
        run: async (givens: Record<string, unknown>) => {
          capturedGivens = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };

      const { clerk, spider } = buildYieldFixture(
        { 'mp-first': firstDesign, 'mp-second': secondDesign },
        {
          engines: [
            { id: 'first', designId: 'mp-first', givens: {} },
            { id: 'second', designId: 'mp-second', upstream: ['first'], givens: { p: '$yields.first.nonExistentProp' } },
          ],
        },
      );

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(capturedGivens !== null, 'second engine should have been called');
      assert.ok(!('p' in (capturedGivens as Record<string, unknown>)), 'missing prop should cause key omission');
    });

    it('R9 — collect() also receives resolved yield values, not raw strings', async () => {
      let capturedCollectGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'col-first',
        label: 'Col First',
        run: async () => ({ status: 'completed' as const, yields: { result: 'done' } }),
      };

      // Second engine is a quick engine (returns 'launched') with a collect() method.
      // It returns a fixed sessionId so we can pre-write the completed session doc.
      const secondDesign: EngineDesign = {
        id: 'col-second',
        label: 'Col Second',
        run: async () => ({ status: 'launched' as const, sessionId: 'col-mock-session' }),
        collect: async (
          sessionId: string,
          givens: Record<string, unknown>,
        ) => {
          capturedCollectGivens = { ...givens };
          return { sessionId, sessionStatus: 'completed' as const };
        },
      };

      const { stacks, clerk, spider } = buildYieldFixture(
        { 'col-first': firstDesign, 'col-second': secondDesign },
        {
          engines: [
            { id: 'first', designId: 'col-first', givens: {} },
            { id: 'second', designId: 'col-second', upstream: ['first'], givens: { r: '$yields.first.result' } },
          ],
        },
      );

      const sessionsBook = stacks.book<SessionDoc>('animator', 'sessions');

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first (clockwork → completed)
      // Pre-write the completed session doc so collect can find it
      await sessionsBook.put({
        id: 'col-mock-session',
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        provider: 'mock',
        exitCode: 0,
      } as SessionDoc);
      await spider.crawl(); // run second → engine-started (stores sessionId)
      await spider.crawl(); // collect → calls collect()

      assert.ok(capturedCollectGivens !== null, 'collect() should have been called');
      assert.equal(
        (capturedCollectGivens as Record<string, unknown>).r,
        'done',
        'collect() should receive resolved yield value, not raw string',
      );
    });

    it('transitive upstream resolution — third engine resolves from first (a → b → c)', async () => {
      let capturedGivens: Record<string, unknown> | null = null;

      const designA: EngineDesign = {
        id: 'tr-a',
        label: 'TR A',
        run: async () => ({ status: 'completed' as const, yields: { someProp: 'from-a' } }),
      };
      const designB: EngineDesign = {
        id: 'tr-b',
        label: 'TR B',
        run: async () => ({ status: 'completed' as const, yields: {} }),
      };
      const designC: EngineDesign = {
        id: 'tr-c',
        label: 'TR C',
        run: async (givens: Record<string, unknown>) => {
          capturedGivens = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };

      const { clerk, spider } = buildYieldFixture(
        { 'tr-a': designA, 'tr-b': designB, 'tr-c': designC },
        {
          engines: [
            { id: 'a', designId: 'tr-a', givens: {} },
            { id: 'b', designId: 'tr-b', upstream: ['a'], givens: {} },
            { id: 'c', designId: 'tr-c', upstream: ['b'], givens: { val: '$yields.a.someProp' } },
          ],
        },
      );

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run a
      await spider.crawl(); // run b
      await spider.crawl(); // run c

      assert.ok(capturedGivens !== null, 'c engine should have been called');
      assert.equal((capturedGivens as Record<string, unknown>).val, 'from-a');
    });
  });
});
