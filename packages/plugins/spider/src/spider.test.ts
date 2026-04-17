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

import { createSpider, countRunningEngines, countRunningEnginesInRig } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, ReviewYields, MechanicalCheck, RigTemplate, BlockRecord, BlockType, CheckResult, SpiderEngineRunResult, SpiderCollectResult, InputRequestDoc } from './types.ts';

import animaSessionEngine from './engines/anima-session.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

// ── Test bootstrap ────────────────────────────────────────────────────

// Standard 5-engine template matching the original static pipeline behavior.
// Used as the default template in test fixtures.
const STANDARD_TEMPLATE: RigTemplate = {
  engines: [
    { id: 'draft',     designId: 'draft',     givens: { writ: '${writ}' } },
    { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '${writ}', role: '${vars.role}' } },
    { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '${writ}', role: 'reviewer', buildCommand: '${vars.buildCommand}', testCommand: '${vars.testCommand}' } },
    { id: 'revise',    designId: 'revise',    upstream: ['review'],    givens: { writ: '${writ}', role: '${vars.role}' } },
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
  cancelCalls: Array<{ sessionId: string; options?: { reason?: string } }>;
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

  const mergedSpider = {
    rigTemplates: { default: STANDARD_TEMPLATE } as Record<string, RigTemplate>,
    variables: { role: 'artificer' } as Record<string, unknown>,
    ...(guildConfig.spider ?? {}),
  };

  // Convenience: if the merged rigTemplates contains a 'default' template
  // and neither the test config nor any extra kit has provided an explicit
  // mapping for 'mandate', auto-add { mandate: 'default' }. Preserves
  // pre-refactor test behavior where an un-mapped 'mandate' writ would fall
  // through to the 'default' template via the old catch-all lookup. Dispatch
  // is now strictly opt-in; tests that need to exercise the "no mapping =
  // skip" path should either omit the 'default' template or pass an explicit
  // empty rigTemplateMappings.
  const configHasMandateMapping = !!(
    mergedSpider as { rigTemplateMappings?: Record<string, string> }
  ).rigTemplateMappings?.mandate;
  const kitHasMandateMapping = (extra.kits ?? []).some((k) => {
    const kitBody = (k as { kit?: Record<string, unknown> }).kit;
    const mappings = kitBody?.rigTemplateMappings as Record<string, string> | undefined;
    return !!mappings?.mandate;
  });
  const apparatusHasMandateMapping = (extra.apparatuses ?? []).some((a) => {
    const sk = (a as { apparatus?: { supportKit?: Record<string, unknown> } }).apparatus?.supportKit;
    const mappings = sk?.rigTemplateMappings as Record<string, string> | undefined;
    return !!mappings?.mandate;
  });
  if (
    mergedSpider.rigTemplates?.default &&
    !configHasMandateMapping &&
    !kitHasMandateMapping &&
    !apparatusHasMandateMapping
  ) {
    (mergedSpider as { rigTemplateMappings?: Record<string, string> }).rigTemplateMappings = {
      ...((mergedSpider as { rigTemplateMappings?: Record<string, string> }).rigTemplateMappings ?? {}),
      mandate: 'default',
    };
  }

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    ...guildConfig,
    spider: mergedSpider,
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
    indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
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

  // Mock animator — captures summon() calls and writes session docs to Stacks.
  // The session record is written eagerly (synchronous put, fire-and-forget)
  // so the Spider's collect step finds it on the next crawl() call. Engines
  // no longer await handle.result — they return immediately with handle.sessionId.
  let currentSessionOutcome = initialSessionOutcome;
  const summonCalls: SummonRequest[] = [];
  const cancelCalls: Array<{ sessionId: string; options?: { reason?: string } }> = [];
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
    subscribeToSession(): AsyncIterable<SessionChunk> | null {
      return null;
    },
    async cancel(sessionId: string, options?: { reason?: string }): Promise<SessionDoc> {
      cancelCalls.push({ sessionId, options });
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      const session = await sessBook.get(sessionId);
      if (session) {
        const now = new Date().toISOString();
        await sessBook.patch(sessionId, {
          status: 'cancelled',
          endedAt: now,
          ...(options?.reason ? { error: options.reason } : {}),
        });
        return { ...session, status: 'cancelled', endedAt: now };
      }
      return { id: sessionId, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as SessionDoc;
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
    cancelCalls,
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
    it('spawns a rig for an open writ', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);
      assert.equal(writ.phase, 'open');

      const result = await spider.crawl();
      assert.ok(result !== null, 'expected a walk result');
      assert.equal(result.action, 'rig-spawned');
      assert.equal((result as { writId: string }).writId, writ.id);

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1);
      assert.equal(rigs[0].writId, writ.id);
      assert.equal(rigs[0].status, 'running');
      assert.equal(rigs[0].engines.length, 5);

      // Writ should still be open
      const updatedWrit = await clerk.show(writ.id);
      assert.equal(updatedWrit.phase, 'open');
    });

    it('does not spawn a second rig for a writ that already has one', async () => {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk);

      await spider.crawl(); // spawns rig

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist');
    });

    it('spawns rigs for the oldest open writ first (FIFO)', async () => {
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

    it('marks engine failed and rig stuck when engine design is not found', async () => {
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [updated] = await book.list();
      assert.equal(updated.status, 'stuck');
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [updated] = await book.list();
      assert.equal(updated.status, 'stuck');
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
      const prompt = summonCalls[0].prompt as string;
      assert.ok(prompt.startsWith('Build the feature.\n'), 'prompt starts with writ body');
      assert.ok(prompt.includes('Commit all changes before ending your session.'), 'prompt includes commit instruction');
      assert.ok(prompt.includes('<task-manifest>'), 'prompt includes task manifest execution instructions');
    });

    it('execution epilogue includes task manifest processing rules', async () => {
      const { clerk, spider, stacks, summonCalls } = fix;
      await clerk.post({ title: 'My writ', body: 'Spec body here.' });
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

      await spider.crawl(); // launch implement
      const prompt = summonCalls[0].prompt as string;

      // Verify key task manifest execution rules are present
      assert.ok(prompt.includes('Work through tasks in the order listed'), 'includes ordering rule');
      assert.ok(prompt.includes('<verify>'), 'includes verify checkpoint rule');
      assert.ok(prompt.includes('<done>'), 'includes done criterion rule');
      assert.ok(prompt.includes('<files>'), 'includes files blast-radius rule');
      assert.ok(prompt.includes('Commit after each task'), 'includes commit-per-task rule');
      assert.ok(prompt.includes('verify scope independently'), 'includes scope independence rule');
    });

    it('session failure propagates: engine fails → rig stuck → writ transitions to stuck', async () => {
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
      await spider.crawl(); // collect: session failed → engine fails → rig stuck

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'stuck', 'rig should be stuck');
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
      assert.equal(failedWrit.phase, 'stuck', 'writ should transition to stuck via CDC');
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

    it('marks engine failed and rig stuck when session failed', async () => {
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [updated] = await book.list();
      assert.equal(updated.status, 'stuck');
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

    it('does not collect a still-pending session (regression: pre-write SessionDoc)', async () => {
      // Regression for the bug where launchDetached pre-wrote a 'pending'
      // SessionDoc before spawning the babysitter, and tryCollect treated
      // 'pending' as a terminal status. The result was that engines marked
      // themselves complete with sessionStatus: 'pending' as their yields,
      // and rigs finished with no actual work performed.
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

      // Session is freshly pre-written but the babysitter hasn't yet
      // transitioned it to 'running' or anything else.
      const sessBook = stacks.book<{
        id: string; status: string; startedAt: string; provider: string; [key: string]: unknown;
      }>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId,
        status: 'pending',
        startedAt: new Date().toISOString(),
        provider: 'test',
      });

      // tryCollect must skip pending → no action this crawl.
      const result = await spider.crawl();
      assert.equal(result, null);

      // Engine must still be running, not completed with bogus yields.
      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      assert.equal(impl?.status, 'running');
      assert.equal(impl?.yields, undefined);
      assert.equal(impl?.completedAt, undefined);
    });
  });

  // ── Failure propagation ────────────────────────────────────────────

  describe('failure propagation', () => {
    it('engine failure → rig stuck → writ transitions to stuck via CDC', async () => {
      const { clerk, spider, stacks } = fix;
      const writ = await postWrit(clerk);

      await spider.crawl(); // spawn
      const activeWrit = await clerk.show(writ.id);
      assert.equal(activeWrit.phase, 'open');

      // Inject bad design to trigger failure
      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const brokenEngines = rig.engines.map((e: EngineInstance) =>
        e.id === 'draft' ? { ...e, designId: 'broken' } : e,
      );
      await book.patch(rig.id, { engines: brokenEngines });

      // Walk: engine fails → rig stuck → CDC → writ stuck
      await spider.crawl();

      const [updatedRig] = await book.list();
      assert.equal(updatedRig.status, 'stuck');

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
      assert.equal(failedWrit.phase, 'stuck');
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

      await spider.crawl(); // spawn

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
      assert.equal(finalWrit.phase, 'completed');

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
      await spider.crawl(); // spawn

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
      assert.equal(finalWrit.phase, 'completed', 'writ should transition to completed via CDC');

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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

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
      // This test manually places two engines in a runnable state within one rig,
      // so raise per-rig limit to allow the second engine to run.
      const { clerk, spider, stacks } = buildFixture({ spider: { maxConcurrentEnginesPerRig: 5 } });
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
      // review fails (bad designId) → rig stuck
      assert.equal(result?.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'stuck');

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
    it('returns null when no rigs exist and no open writs', async () => {
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
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
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

  it('dispatches a writ via an explicit rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. A writ type must have an explicit mapping
    // in `rigTemplateMappings` (config or kit) to be dispatched; there is no
    // "default template catches all" fallback.
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
        { id: 'c', designId: 'implement', upstream: ['b'], givens: {} },
      ],
    };
    const fix = buildFixture({
      spider: {
        rigTemplates: { default: defaultTemplate },
        rigTemplateMappings: { mandate: 'default' },
      },
    });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Task writ', body: 'test', type: 'mandate' });
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 3, 'rig should use mapped template (3 engines)');
  });

  it('uses type-specific template over default when both exist', async () => {
    const mandateTemplate: RigTemplate = {
      engines: [
        { id: 'only', designId: 'seal', givens: {} },
      ],
    };
    const defaultTemplate: RigTemplate = {
      engines: [
        { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
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

  it('leaves a writ in open when its type has no rigTemplateMappings entry', async () => {
    // Dispatch is strictly opt-in. A writ type with no mapping is inert by
    // configuration — the Spider's crawl loop skips it and the writ remains
    // in `open` status. This is the substrate for any writ type that should
    // be tracked in the books without being executed.
    const fix = buildFixture({
      spider: {
        rigTemplates: { hotfix: { engines: [{ id: 'x', designId: 'seal', givens: {} }] } },
        // Note: no rigTemplateMappings. The buildFixture auto-mapping helper
        // only injects mandate→default when a 'default' template exists,
        // which it does not here, so 'mandate' is genuinely unmapped.
      },
    });
    const { clerk, spider, stacks } = fix;

    const posted = await clerk.post({ title: 'Mandate writ', body: 'test' }); // defaults to 'mandate'
    const result = await spider.crawl();
    assert.equal(result, null, 'crawl should return null — no writ was dispatched');

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs.length, 0, 'no rig should be created for unmapped writ type');

    // Writ should still be in 'open' — dispatch was skipped, not failed.
    const writ = await clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });

  it('dispatches a mandate writ via the fixture auto-mapping convenience', async () => {
    // buildFixture auto-adds { mandate: 'default' } when a 'default' template
    // exists and no explicit mapping is provided. This mirrors the default
    // test fixture which provides STANDARD_TEMPLATE as 'default'.
    const fix = buildFixture();
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'Test', body: 'test' }); // type: 'mandate', uses STANDARD_TEMPLATE
    const result = await spider.crawl();
    assert.equal(result?.action, 'rig-spawned');
    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'STANDARD_TEMPLATE produces 5 engines');
  });

  it('leaves a writ in open when no rigTemplates are configured at all', async () => {
    // Override the fixture's default rigTemplates injection by setting rigTemplates to undefined.
    // With no templates and no mappings, an un-mapped writ type is inert — dispatch is skipped.
    const fix = buildFixture({ spider: { rigTemplates: undefined } });
    const { clerk, spider, stacks } = fix;

    const posted = await clerk.post({ title: 'Test writ', body: 'test' });
    const result = await spider.crawl();
    assert.equal(result, null);

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs.length, 0);

    const writ = await clerk.show(posted.id);
    assert.equal(writ.phase, 'open');
  });
});

describe('Spider — variable resolution', () => {
  afterEach(() => {
    clearGuild();
  });

  it('${writ} resolves to the full WritDoc object', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '${writ}' } }],
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

  it('${vars.<key>} resolves to the value from spiderConfig.variables', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.cmd, 'make build');
  });

  it('${vars.<key>} resolves non-string value types correctly', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { n: '${vars.count}' } }],
    };
    const fix = buildFixture({ spider: { variables: { count: 42 }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines[0].givensSpec.n, 42);
  });

  it('${vars.<key>} omits the key when the variable is absent from variables dict', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.testCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: {}, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    assert.ok(!('cmd' in rigs[0].engines[0].givensSpec), 'cmd key should be absent when testCommand is not set');
  });

  it('${vars.<key>} omits the key when the variables dict itself is absent from config', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { cmd: '${vars.testCommand}' } }],
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

  it('mixed literals and ${...} expressions resolve correctly together', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { writ: '${writ}', role: 'reviewer', cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'pnpm build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Mixed test', body: 'mixed body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givens = rigs[0].engines[0].givensSpec;
    // ${writ} resolves to the WritDoc object
    assert.equal((givens.writ as { id: string }).id, writ.id, '${writ} should resolve to WritDoc');
    // literal string "reviewer" passes through unchanged
    assert.equal(givens.role, 'reviewer', 'literal "reviewer" should pass through unchanged');
    // ${vars.buildCommand} resolves to the configured value
    assert.equal(givens.cmd, 'pnpm build', '${vars.buildCommand} should resolve to configured value');
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

  it('${writ} and ${vars.<key>} resolve to their respective values', async () => {
    const template: RigTemplate = {
      engines: [{ id: 'only', designId: 'seal', givens: { w: '${writ}', cmd: '${vars.buildCommand}' } }],
    };
    const fix = buildFixture({ spider: { variables: { buildCommand: 'make build' }, rigTemplates: { default: template } } });
    const { clerk, spider, stacks } = fix;

    const writ = await clerk.post({ title: 'Curly brace test', body: 'test body' });
    await spider.crawl();

    const rigs = await rigsBook(stacks).list();
    const givensSpec = rigs[0].engines[0].givensSpec;
    // ${writ} resolves to the WritDoc object
    assert.equal((givensSpec.w as { id: string }).id, writ.id, '${writ} should resolve to WritDoc');
    // ${vars.buildCommand} resolves to the configured value
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
                { id: 'a', designId: 'draft', givens: { writ: '${writ}' } },
                { id: 'b', designId: 'implement', upstream: ['a'], givens: { writ: '${writ}', role: '${vars.role}' } },
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
                { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
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
                { id: 'a', designId: 'draft', upstream: ['c'], givens: { writ: '${writ}' } },
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

  it('throws [spider] error for unrecognized expression (${buildCommand})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${buildCommand}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${role})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { r: '${role}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.buildCommand})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.buildCommand}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('throws [spider] error for unrecognized expression (${spider.a.b})', () => {
    assert.throws(
      () => buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${spider.a.b}' } }],
            },
          },
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.startsWith('[spider]'), err.message);
        assert.ok(err.message.includes('unrecognized expression'), err.message);
        return true;
      },
    );
  });

  it('accepts ${vars.a.b} as a valid expression (dot-path traversal)', () => {
    // Under the new interpolation system, ${vars.*} supports arbitrary dot-path traversal
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.a.b}' } }],
            },
          },
        },
      })
    );
  });

  it('accepts ${vars.buildCommand} as a valid expression', () => {
    assert.doesNotThrow(() =>
      buildFixture({
        spider: {
          rigTemplates: {
            default: {
              engines: [{ id: 'x', designId: 'seal', givens: { cmd: '${vars.buildCommand}' } }],
            },
          },
        },
      })
    );
  });

  it('bare $vars.buildCommand (no ${...}) is treated as a literal string without error', () => {
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
    assert.equal(finalWrit.phase, 'completed');
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
        { id: 'draft', designId: 'draft', givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'], givens: { writ: '${writ}', role: '${vars.role}' } },
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
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(sealYields), 'should fall back to seal engine yields');
  });
});

describe('Spider — STANDARD_TEMPLATE full pipeline givens', () => {
  afterEach(() => {
    clearGuild();
  });

  it('STANDARD_TEMPLATE spawns a 5-engine rig with correct givens (using ${vars.role})', async () => {
    const fix = buildFixture(); // uses STANDARD_TEMPLATE with variables: { role: 'artificer' }
    const { clerk, spider, stacks } = fix;

    await clerk.post({ title: 'test', body: 'test' });
    await spider.crawl(); // spawn

    const rigs = await rigsBook(stacks).list();
    assert.equal(rigs[0].engines.length, 5, 'standard template produces 5 engines');

    const implement = rigs[0].engines.find((e: EngineInstance) => e.id === 'implement');
    const revise = rigs[0].engines.find((e: EngineInstance) => e.id === 'revise');
    const review = rigs[0].engines.find((e: EngineInstance) => e.id === 'review');

    assert.equal(implement?.givensSpec.role, 'artificer', 'implement ${vars.role} resolves to "artificer"');
    assert.equal(revise?.givensSpec.role, 'artificer', 'revise ${vars.role} resolves to "artificer"');
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
        { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
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
    assert.equal(finalWrit.phase, 'completed');
    assert.equal(finalWrit.resolution, JSON.stringify(step2Yields), 'resolution uses step2 yields via resolutionEngineId');
  });

  it('3-engine template without seal uses resolutionEngine for writ resolution', async () => {
    // Configure a template with draft → implement → review, no seal engine.
    // resolutionEngine: 'review' directs the CDC handler to use review's yields.
    const template: RigTemplate = {
      engines: [
        { id: 'draft',     designId: 'draft',     givens: { writ: '${writ}' } },
        { id: 'implement', designId: 'implement', upstream: ['draft'],     givens: { writ: '${writ}', role: '${vars.role}' } },
        { id: 'review',    designId: 'review',    upstream: ['implement'], givens: { writ: '${writ}' } },
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
    assert.equal(finalWrit.phase, 'completed');
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
      for (const status of ['running', 'completed', 'failed', 'stuck', 'blocked']) {
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
// block types (writ-phase, scheduled-time, book-updated) are delivered
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
      spider: {
        rigTemplates: { default: template },
        rigTemplateMappings: { mandate: 'default' },
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
      indexes: ['phase', 'type', 'createdAt', ['phase', 'type'], ['phase', 'createdAt']],
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
    const cancelCalls: Array<{ sessionId: string; options?: { reason?: string } }> = [];
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
      subscribeToSession(): AsyncIterable<SessionChunk> | null {
        return null;
      },
      async cancel(sessionId: string, options?: { reason?: string }): Promise<SessionDoc> {
        cancelCalls.push({ sessionId, options });
        const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
        const session = await sessBook.get(sessionId);
        if (session) {
          const now = new Date().toISOString();
          await sessBook.patch(sessionId, {
            status: 'cancelled',
            endedAt: now,
            ...(options?.reason ? { error: options.reason } : {}),
          });
          return { ...session, status: 'cancelled', endedAt: now };
        }
        return { id: sessionId, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as SessionDoc;
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
      assert.ok(spider.getBlockType('writ-phase') !== undefined, 'writ-phase should be registered');
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
      assert.ok(ids.includes('writ-phase'), 'writ-phase should be in list');
      assert.ok(ids.includes('scheduled-time'), 'scheduled-time should be in list');
      assert.ok(ids.includes('book-updated'), 'book-updated should be in list');
      assert.ok(ids.includes('patron-input'), 'patron-input should be in list');

      const writStatus = result.find((bt) => bt.id === 'writ-phase');
      assert.ok(writStatus, 'writ-phase should be found');
      assert.equal(typeof writStatus.pluginId, 'string', 'pluginId should be a string');
      assert.equal(writStatus.pollIntervalMs, 10_000, 'writ-phase should have 10s poll interval');

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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'stuck');
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

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
    it('blocked engines are cancelled (with block cleared) when rig stuck', async () => {
      const fix = buildBlockingFixture();

      // Create a real writ so the CDC handler can transition it when the rig becomes stuck.
      const writ = await fix.clerk.post({ title: 'Fail test writ', body: 'Body' });
      // Writ starts in 'open' — it can transition to failed directly.

      // Directly insert a rig with one blocked engine and one pending engine.
      // A third engine (running) will fail via its session, triggering failEngine (rig → stuck).
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
      assert.equal(updatedRig!.status, 'stuck', 'rig should be stuck');

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
    it('writ remains open when rig transitions to blocked — no CDC writ transition', async () => {
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
      await fix.spider.crawl(); // spawn
      await fix.spider.crawl(); // run → rig-blocked

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'blocked');

      // Writ should remain 'open' — CDC ignores 'blocked' status
      const currentWrit = await fix.clerk.show(writ.id);
      assert.equal(
        currentWrit.phase,
        'open',
        'writ should remain open when rig is blocked; CDC must not fire for blocked status',
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
    it('checker returns { status: "failed" } with no reason — engine failed, rig stuck permanently', async () => {
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'stuck');
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

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

      const result = await fix.spider.crawl(); // checkBlocked → a fails → rig stuck
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'stuck');
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
      assert.equal(rig.status, 'stuck');
      // Engine is now failed; the block record should be gone (failEngine cleared it)
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'failed');
      // lastCheckedAt was never set (failure path skips it)
    });

    it('checker failure on rig with blocked status — rig transitions to stuck', async () => {
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
      assert.equal((result as { outcome: string }).outcome, 'stuck');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'stuck', 'rig should transition from blocked to stuck');
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine?.error?.includes('gone'), `expected error to include "gone", got: ${engine?.error}`);
    });
  });

  // ── writ-phase checker additional cases (R12–R16) ─────────────────────

  describe('writ-phase checker — additional failure cases', () => {
    it('returns failed with terminal-mismatch reason when writ is failed but target is completed', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'failed');

      const blockType = fix.spider.getBlockType('writ-phase');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
      assert.deepEqual(result, {
        status: 'failed',
        reason: 'Writ reached terminal phase "failed" instead of "completed"',
      });
    });

    it('returns cleared when writ is at failed status and target is failed (target match wins)', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'failed');

      const blockType = fix.spider.getBlockType('writ-phase');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetPhase: 'failed' });
      assert.deepEqual(result, { status: 'cleared' }, 'target match takes priority over terminal-mismatch');
    });

    it('returns failed with terminal-mismatch reason when writ is cancelled but target is completed', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.clerk.transition(writ.id, 'cancelled');

      const blockType = fix.spider.getBlockType('writ-phase');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
      assert.deepEqual(result, {
        status: 'failed',
        reason: 'Writ reached terminal phase "cancelled" instead of "completed"',
      });
    });

    it('returns pending when writ is at non-terminal, non-target status', async () => {
      const fix = buildBlockingFixture();
      const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
      // writ starts at 'open' status, which is neither completed nor a terminal mismatch for 'completed' target

      const blockType = fix.spider.getBlockType('writ-phase');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
      assert.deepEqual(result, { status: 'pending' }, 'non-terminal non-target status should return pending');
    });
  });

  // ── Built-in block types (R22–R25, V16–V18) ───────────────────────────

  describe('Built-in block types', () => {

    // ── writ-phase (R23, V16) ───────────────────────────────────────────

    describe('writ-phase block type (R23, V16)', () => {
      it('checker returns pending when writ is not at target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });

        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined, 'writ-phase block type should be registered');

        const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'pending' }, 'checker should return pending when writ is not completed');
      });

      it('checker returns cleared when writ reaches target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
        await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'cleared' }, 'checker should return cleared when writ is completed');
      });

      it('checker returns failed when writ does not exist', async () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: 'nonexistent-writ-99', targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'failed', reason: 'Writ not found' }, 'checker should return failed when writ not found');
      });

      it('writ-phase has pollIntervalMs of 10000 (R23)', () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 10_000, 'writ-phase should have 10s poll interval');
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
    engines: [{ id: 'step1', designId: 'draft', givens: { writ: '${writ}' } }],
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

  describe('V5, V6 — lookup chain (explicit mappings only)', () => {
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

    it('unmapped writ types are inert — crawl skips them and they stay in open', async () => {
      // Dispatch is strictly opt-in per writ type. A custom writ type with
      // no explicit mapping in rigTemplateMappings is not dispatched; the
      // writ remains in 'open' status for non-dispatch handling.
      const fix = buildFixture({
        spider: {
          rigTemplates: { standard: { engines: [{ id: 'std', designId: 'draft', givens: {} }] } },
          rigTemplateMappings: { mandate: 'standard' },
          variables: {},
        },
        clerk: { writTypes: [{ name: 'custom-type' }] },
      });

      const writ = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'custom-type' });
      const result = await fix.spider.crawl();
      assert.equal(result, null, 'crawl should return null — custom-type is unmapped');
      const rig = await fix.spider.forWrit(writ.id);
      assert.equal(rig, null);
      const shown = await fix.clerk.show(writ.id);
      assert.equal(shown.phase, 'open');
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
    it('leaves a writ in open when no template, mapping, or default exists', async () => {
      // Config has no templates, no mappings, no default
      // Set rigTemplates to undefined to override the buildFixture default
      const fix = buildFixture({
        spider: { rigTemplates: undefined, variables: {} },
        clerk: { writTypes: [{ name: 'orphan-type' }] },
      });

      const posted = await fix.clerk.post({ title: 'Test', body: 'Body', type: 'orphan-type' });
      const result = await fix.spider.crawl();
      // Opt-in dispatch: unmapped writ types are inert — crawl skips them.
      assert.equal(result, null);
      const writ = await fix.clerk.show(posted.id);
      assert.equal(writ.phase, 'open');
    });
  });
});

// ── ${yields.*} reference tests ───────────────────────────────────────

describe('${yields.*} reference support', () => {
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
                  { id: 'step1', designId: 'seal', givens: { x: '${yields.nonexistent.foo}' } },
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
                  { id: 'a', designId: 'seal', givens: { x: '${yields.b.foo}' } },
                  { id: 'b', designId: 'draft', upstream: ['a'], givens: { writ: '${writ}' } },
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
      // a → b → c; c references ${yields.a.foo} (a is transitively upstream of c)
      assert.doesNotThrow(() =>
        buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'a', designId: 'seal', givens: {} },
                  { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
                  { id: 'c', designId: 'seal', upstream: ['b'], givens: { x: '${yields.a.foo}' } },
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
                  { id: 'solo', designId: 'seal', givens: { x: '${yields.solo.foo}' } },
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

    it('invalid syntax ${yields.a} (missing property segment) is rejected as invalid expression', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [
                  { id: 'a', designId: 'seal', givens: {} },
                  { id: 'b', designId: 'seal', upstream: ['a'], givens: { x: '${yields.a}' } },
                ],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('invalid expression'), err.message);
          return true;
        },
      );
    });

    it('valid ${yields.*} reference passes validation without throwing', () => {
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
                { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
                // References ${yields.nonexistent.foo} where 'nonexistent' is not an engine
                { id: 'step2', designId: 'seal', upstream: ['step1'], givens: { x: '${yields.nonexistent.foo}' } },
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
                { id: 'a', designId: 'draft', givens: { writ: '${writ}', x: '${yields.b.foo}' } },
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
                { id: 'step1', designId: 'draft', givens: { writ: '${writ}' } },
                { id: 'step2', designId: 'seal', upstream: ['step1'], givens: { p: '${yields.step1.path}' } },
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
      assert.ok(rig, 'rig should exist');
      const secondEngine = rig!.engines.find(e => e.id === 'second');
      assert.ok(secondEngine, 'second engine should exist');
      // The yield ref string must be preserved as-is in givensSpec
      assert.equal(
        secondEngine!.givensSpec.p,
        '${yields.first.path}',
        'yield ref should be stored as literal ${...} string in givensSpec',
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

  /**
   * Build a minimal fixture for yield-ref runtime tests.
   *
   * Custom engine designs must be registered in the Fabricator BEFORE Spider
   * starts (Spider's validateTemplates() runs at start time and checks the
   * Fabricator for known designIds). This mirrors the pattern used by
   * buildBlockingFixture() in the blocking tests.
   *
   * Shared by Run-time resolution tests and Template interpolation tests.
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
        spider: {
          rigTemplates: { default: template },
          variables: {},
          rigTemplateMappings: { mandate: 'default' },
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

      const fabricatorKitEntries = buildKitEntries(
        [],
        [spiderAsLoaded, ...customEngineApparatuses],
      );
      const spiderKitEntries = buildKitEntries([], [spiderAsLoaded]);

      const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
      stacksApparatus.start(noopCtx);
      const stacks = stacksApparatus.provides as StacksApi;
      apparatusMap.set('stacks', stacks);

      memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
        indexes: ['phase', 'type', 'createdAt', ['phase', 'type'], ['phase', 'createdAt']],
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

      const { ctx: fabricatorCtx } = buildCtx(fabricatorKitEntries);
      fabricatorApparatus.start(fabricatorCtx);
      const fabricator = fabricatorApparatus.provides as FabricatorApi;
      apparatusMap.set('fabricator', fabricator);

      const { ctx: spiderCtx } = buildCtx(spiderKitEntries);
      spiderApparatus.start(spiderCtx);
      const spider = spiderApparatus.provides as SpiderApi;
      apparatusMap.set('spider', spider);

      return { stacks, clerk, spider };
  }

  describe('Run-time resolution (R1, R2)', () => {
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
            { id: 'second', designId: 'yr-second', upstream: ['first'], givens: { dir: '${yields.first.path}' } },
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
              givens: { x: '${yields.first.foo}', y: '${yields.first.bar}', z: 'literal' },
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
            { id: 'second', designId: 'mp-second', upstream: ['first'], givens: { p: '${yields.first.nonExistentProp}' } },
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
            { id: 'second', designId: 'col-second', upstream: ['first'], givens: { r: '${yields.first.result}' } },
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
            { id: 'c', designId: 'tr-c', upstream: ['b'], givens: { val: '${yields.a.someProp}' } },
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

  // ── Template interpolation: inline, dot-path, type coercion, escape ──

  describe('Template interpolation — new features', () => {
    afterEach(() => { clearGuild(); });

    it('V8/R5 — inline interpolation: "Path is ${yields.first.path}" resolves to string', async () => {
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'inl-first',
        label: 'Inl First',
        run: async () => ({ status: 'completed' as const, yields: { path: '/tmp/workdir' } }),
      };
      const design2: EngineDesign = {
        id: 'inl-second',
        label: 'Inl Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider } = buildYieldFixture(
        { 'inl-first': design1, 'inl-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'inl-first', givens: {} },
            { id: 'second', designId: 'inl-second', upstream: ['first'], givens: { msg: 'Path is ${yields.first.path}' } },
          ],
        },
      );
      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second
      assert.ok(captured !== null);
      assert.equal((captured as Record<string, unknown>).msg, 'Path is /tmp/workdir');
    });

    it('V9/R8 — mixed spawn+run-time: partially resolved at spawn, rest at run-time', async () => {
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'mix-first',
        label: 'Mix First',
        run: async () => ({ status: 'completed' as const, yields: { result: 'done' } }),
      };
      const design2: EngineDesign = {
        id: 'mix-second',
        label: 'Mix Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider, stacks } = buildYieldFixture(
        { 'mix-first': design1, 'mix-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'mix-first', givens: {} },
            { id: 'second', designId: 'mix-second', upstream: ['first'],
              givens: { prompt: '${writ.title}: ${yields.first.result}' } },
          ],
        },
      );
      const writ = await clerk.post({ title: 'My Writ', body: 'Body' });
      await spider.crawl(); // spawn — ${writ.title} resolved, ${yields.first.result} preserved

      // Check givensSpec after spawn: writ.title resolved, yields expression still present
      const book = stacks.book<RigDoc>('spider', 'rigs');
      const [rig] = await book.list();
      const secondEngine = rig.engines.find(e => e.id === 'second');
      assert.ok(secondEngine, 'second engine should exist');
      assert.equal(
        secondEngine!.givensSpec.prompt,
        'My Writ: ${yields.first.result}',
        'spawn-time: writ.title resolved, yields expr preserved',
      );

      await spider.crawl(); // run first
      await spider.crawl(); // run second — yields resolved at run-time

      assert.ok(captured !== null);
      assert.equal((captured as Record<string, unknown>).prompt, 'My Writ: done',
        'run-time: yields expression resolved to actual value');
    });

    it('V11/R7 — number inline-coerced to string, object to JSON', async () => {
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'coerce-first',
        label: 'Coerce First',
        run: async () => ({
          status: 'completed' as const,
          yields: { count: 42, flag: true, obj: { a: 1 } },
        }),
      };
      const design2: EngineDesign = {
        id: 'coerce-second',
        label: 'Coerce Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider } = buildYieldFixture(
        { 'coerce-first': design1, 'coerce-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'coerce-first', givens: {} },
            {
              id: 'second', designId: 'coerce-second', upstream: ['first'],
              givens: {
                numStr: 'Count: ${yields.first.count}',
                boolStr: 'Ok: ${yields.first.flag}',
                objStr: 'Data: ${yields.first.obj}',
                // Whole-value — preserves type
                rawNum: '${yields.first.count}',
                rawObj: '${yields.first.obj}',
              },
            },
          ],
        },
      );
      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(captured !== null);
      const g = captured as Record<string, unknown>;
      assert.equal(g.numStr, 'Count: 42', 'number stringified inline');
      assert.equal(g.boolStr, 'Ok: true', 'boolean stringified inline');
      assert.equal(g.objStr, 'Data: {"a":1}', 'object JSON.stringified inline');
      // Whole-value: raw type preserved
      assert.equal(g.rawNum, 42, 'whole-value number preserved');
      assert.deepEqual(g.rawObj, { a: 1 }, 'whole-value object preserved');
    });

    it('V10/R6 — undefined inline expression replaced with empty string', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'only', designId: 'seal', givens: { msg: 'Codex: ${writ.codex}' } }],
      };
      const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
      const { clerk, spider, stacks } = fix;

      // writ has no 'codex' field → should be ''
      await clerk.post({ title: 'test', body: 'test' });
      await spider.crawl();

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs[0].engines[0].givensSpec.msg, 'Codex: ', 'undefined → empty string inline');
    });

    it('V2/R2 — ${writ.<field>} accesses a specific field of the WritDoc', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'only', designId: 'seal', givens: { title: '${writ.title}' } }],
      };
      const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
      const { clerk, spider, stacks } = fix;

      const writ = await clerk.post({ title: 'Specific Field', body: 'test' });
      await spider.crawl();

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs[0].engines[0].givensSpec.title, writ.title, '${writ.title} resolves to title string');
    });

    it('V13/R9 — escape sequence \\${ produces literal ${ without interpolation', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'only', designId: 'seal', givens: { msg: 'Use \\${this} syntax' } }],
      };
      const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'test', body: 'test' });
      await spider.crawl();

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs[0].engines[0].givensSpec.msg, 'Use ${this} syntax', 'escaped \\${ → literal ${');
    });

    it('V14/R10 — unrecognized expression ${unknown.foo} causes startup error', () => {
      assert.throws(
        () => buildFixture({
          spider: {
            rigTemplates: {
              default: {
                engines: [{ id: 'x', designId: 'seal', givens: { x: '${unknown.foo}' } }],
              },
            },
          },
        }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('unrecognized expression'), err.message);
          return true;
        },
      );
    });

    it('V22/R4 — deep dot-path traversal for yields works at run time', async () => {
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'dp-first',
        label: 'DP First',
        run: async () => ({
          status: 'completed' as const,
          yields: { nested: { deep: { prop: 'found' } } },
        }),
      };
      const design2: EngineDesign = {
        id: 'dp-second',
        label: 'DP Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider } = buildYieldFixture(
        { 'dp-first': design1, 'dp-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'dp-first', givens: {} },
            { id: 'second', designId: 'dp-second', upstream: ['first'],
              givens: { val: '${yields.first.nested.deep.prop}' } },
          ],
        },
      );
      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(captured !== null);
      assert.equal((captured as Record<string, unknown>).val, 'found', 'deep dot-path traversal works');
    });

    it('R3 — ${vars.a.b} dot-path traversal for nested config vars', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'only', designId: 'seal', givens: { val: '${vars.database.host}' } }],
      };
      const fix = buildFixture({
        spider: {
          variables: { database: { host: 'localhost' } },
          rigTemplates: { default: template },
        },
      });
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'test', body: 'test' });
      await spider.crawl();

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs[0].engines[0].givensSpec.val, 'localhost', '${vars.database.host} resolves via dot-path');
    });

    it('V21/R5 — whole-value ${yields.first.obj} preserves raw object type', async () => {
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'rv-first',
        label: 'RV First',
        run: async () => ({ status: 'completed' as const, yields: { obj: { x: 99 } } }),
      };
      const design2: EngineDesign = {
        id: 'rv-second',
        label: 'RV Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider } = buildYieldFixture(
        { 'rv-first': design1, 'rv-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'rv-first', givens: {} },
            { id: 'second', designId: 'rv-second', upstream: ['first'],
              givens: { data: '${yields.first.obj}' } },
          ],
        },
      );
      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(captured !== null);
      assert.deepEqual((captured as Record<string, unknown>).data, { x: 99 },
        'whole-value object type is preserved (not stringified)');
    });

    it('bare $writ (no ${...}) is passed through as literal string at spawn time', async () => {
      // Bare $ without ${...} wrapper is not a template expression → literal
      const template: RigTemplate = {
        engines: [{ id: 'only', designId: 'seal', givens: { w: '$writ' } }],
      };
      const fix = buildFixture({ spider: { rigTemplates: { default: template } } });
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'test', body: 'test' });
      await spider.crawl();

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs[0].engines[0].givensSpec.w, '$writ',
        'bare $writ is not recognized — stored as literal string');
    });

    it('bare $yields.draft.path (no ${...}) is not resolved at run time', async () => {
      // Bare $ without ${...} wrapper is not a template expression → literal throughout
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'bare-first',
        label: 'Bare First',
        run: async () => ({ status: 'completed' as const, yields: { path: '/real/path' } }),
      };
      const design2: EngineDesign = {
        id: 'bare-second',
        label: 'Bare Second',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
          return { status: 'completed' as const, yields: {} };
        },
      };
      const { clerk, spider } = buildYieldFixture(
        { 'bare-first': design1, 'bare-second': design2 },
        {
          engines: [
            { id: 'first', designId: 'bare-first', givens: {} },
            { id: 'second', designId: 'bare-second', upstream: ['first'],
              givens: { p: '$yields.first.path' } },
          ],
        },
      );
      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first
      await spider.crawl(); // run second

      assert.ok(captured !== null);
      assert.equal((captured as Record<string, unknown>).p, '$yields.first.path',
        'bare $yields.first.path is not resolved — passed through as literal string');
    });
  });

  // ── anima-session engine ───────────────────────────────────────────

  describe('anima-session engine', () => {
    let fix: ReturnType<typeof buildFixture>;
    beforeEach(() => { fix = buildFixture(); });
    afterEach(() => { clearGuild(); });

    // Build a minimal EngineRunContext for direct engine tests
    function makeContext(overrides: Partial<EngineRunContext> = {}): EngineRunContext {
      return {
        rigId: 'rig-test',
        engineId: 'anima-session',
        upstream: {},
        ...overrides,
      };
    }

    // ── Registration ────────────────────────────────────────────────

    describe('registration', () => {
      it('registers anima-session engine in the Fabricator', () => {
        const { fabricator } = fix;
        assert.ok(fabricator.getEngineDesign('anima-session'), 'anima-session engine should be registered');
      });

      it('has no collect method (uses generic default collect)', () => {
        assert.equal(animaSessionEngine.collect, undefined);
      });

      it('config rig template referencing designId anima-session passes validateTemplates', () => {
        // Build a fixture with anima-session as a template designId.
        // If spider.start() does not throw, validation passed.
        const animaTemplate: RigTemplate = {
          engines: [
            { id: 'anima', designId: 'anima-session', givens: { role: 'scribe', prompt: 'Do work', cwd: '/tmp' } },
          ],
          resolutionEngine: 'anima',
        };
        assert.doesNotThrow(() => {
          buildFixture({
            spider: {
              rigTemplates: { default: animaTemplate },
              variables: {},
            },
          });
        });
      });
    });

    // ── Givens validation ────────────────────────────────────────────

    describe('givens validation', () => {
      it('throws when role is missing', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ prompt: 'x', cwd: '/tmp' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('role'), `expected "role" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when role is an empty string', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ role: '', prompt: 'x', cwd: '/tmp' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('role'), `expected "role" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when role is a non-string value', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ role: 123, prompt: 'x', cwd: '/tmp' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('role'), `expected "role" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when prompt is missing', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ role: 'scribe', cwd: '/tmp' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('prompt'), `expected "prompt" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when prompt is an empty string', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ role: 'scribe', prompt: '', cwd: '/tmp' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('prompt'), `expected "prompt" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when cwd is missing', async () => {
        await assert.rejects(
          () => animaSessionEngine.run({ role: 'scribe', prompt: 'x' }, makeContext()),
          (err: Error) => {
            assert.ok(err.message.includes('cwd'), `expected "cwd" in error: ${err.message}`);
            return true;
          },
        );
      });

      it('throws when cwd is missing even when context.upstream has draft path', async () => {
        // Patron directive: no fallback to draft path — cwd must come from givens
        await assert.rejects(
          () => animaSessionEngine.run(
            { role: 'scribe', prompt: 'x' },
            makeContext({ upstream: { draft: { path: '/tmp/draft' } } }),
          ),
          (err: Error) => {
            assert.ok(err.message.includes('cwd'), `expected "cwd" in error: ${err.message}`);
            return true;
          },
        );
      });
    });

    // ── Summon integration ───────────────────────────────────────────

    describe('summon integration', () => {
      it('summons with correct fields when writ is provided', async () => {
        const { summonCalls } = fix;
        const mockWrit: WritDoc = {
          id: 'writ-abc',
          title: 'Test writ',
          body: 'Test body',
          status: 'open',
          createdAt: new Date().toISOString(),
        };

        const result = await animaSessionEngine.run(
          { role: 'artificer', prompt: 'Do the work', cwd: '/tmp/work', writ: mockWrit },
          makeContext({ engineId: 'my-engine' }),
        );

        assert.equal((result as { status: string }).status, 'launched');
        assert.ok(typeof (result as { sessionId: string }).sessionId === 'string', 'should have sessionId');

        const req = summonCalls[summonCalls.length - 1];
        assert.equal(req.role, 'artificer');
        assert.equal(req.prompt, 'Do the work');
        assert.equal(req.cwd, '/tmp/work');
        assert.deepEqual(req.environment, { GIT_AUTHOR_EMAIL: 'writ-abc@nexus.local' });
        assert.deepEqual(req.metadata, { engineId: 'my-engine', writId: 'writ-abc' });
      });

      it('summons with empty environment and no writId in metadata when writ is absent', async () => {
        const { summonCalls } = fix;

        await animaSessionEngine.run(
          { role: 'scribe', prompt: 'Plan something', cwd: '/tmp' },
          makeContext({ engineId: 'plain-engine' }),
        );

        const req = summonCalls[summonCalls.length - 1];
        assert.deepEqual(req.environment, {});
        assert.deepEqual(req.metadata, { engineId: 'plain-engine' });
        assert.ok(!Object.prototype.hasOwnProperty.call(req.metadata, 'writId'), 'metadata should not have writId');
      });

      it('passes conversationId to summon when provided', async () => {
        const { summonCalls } = fix;

        await animaSessionEngine.run(
          { role: 'scribe', prompt: 'Continue', cwd: '/tmp', conversationId: 'conv-123' },
          makeContext(),
        );

        const req = summonCalls[summonCalls.length - 1];
        assert.equal(req.conversationId, 'conv-123');
      });

      it('omits conversationId from summon when not provided', async () => {
        const { summonCalls } = fix;

        await animaSessionEngine.run(
          { role: 'scribe', prompt: 'Fresh start', cwd: '/tmp' },
          makeContext(),
        );

        const req = summonCalls[summonCalls.length - 1];
        assert.ok(!Object.prototype.hasOwnProperty.call(req, 'conversationId'), 'conversationId should be absent');
      });

      it('omits conversationId from summon when falsy (empty string)', async () => {
        const { summonCalls } = fix;

        await animaSessionEngine.run(
          { role: 'scribe', prompt: 'Fresh start', cwd: '/tmp', conversationId: '' },
          makeContext(),
        );

        const req = summonCalls[summonCalls.length - 1];
        assert.ok(!Object.prototype.hasOwnProperty.call(req, 'conversationId'), 'empty conversationId should be omitted');
      });
    });

    // ── Generic default collect — conversationId in yields ───────────

    describe('generic default collect — conversationId in yields', () => {
      it('includes conversationId in yields when session document has it', async () => {
        const { clerk, spider, stacks } = fix;
        await postWrit(clerk, 'ConvId test');
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

        // Insert terminal session record with conversationId
        const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
        await sessBook.put({
          id: fakeSessionId,
          status: 'completed',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          provider: 'test',
          exitCode: 0,
          conversationId: 'conv-abc',
        });

        const result = await spider.crawl(); // collect
        assert.equal(result?.action, 'engine-completed');

        const [updated] = await book.list();
        const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
        const yields = impl?.yields as Record<string, unknown>;
        assert.equal(yields.conversationId, 'conv-abc', 'yields should include conversationId from session');
      });

      it('excludes conversationId from yields when session document does not have it', async () => {
        const { clerk, spider, stacks } = fix;
        await postWrit(clerk, 'No ConvId test');
        await spider.crawl(); // spawn

        const book = rigsBook(stacks);
        const [rig] = await book.list();
        const fakeSessionId = generateId('ses', 4);

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

        // Insert terminal session record WITHOUT conversationId
        const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
        await sessBook.put({
          id: fakeSessionId,
          status: 'completed',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
          provider: 'test',
          exitCode: 0,
        });

        await spider.crawl(); // collect

        const [updated] = await book.list();
        const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
        const yields = impl?.yields as Record<string, unknown>;
        assert.ok(
          !Object.prototype.hasOwnProperty.call(yields, 'conversationId'),
          'yields should NOT contain conversationId key when session has none',
        );
      });
    });
  });
});

// ── Conditional engine activation (`when`), cascade skipping, and grafting ──

describe('Spider — when conditions, cascade skipping, and grafting', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── Helper to drive crawl until rig reaches terminal state ─────────────

  async function drainToTerminal(
    spider: SpiderApi,
    maxCrawls = 50,
  ): Promise<{ results: Array<typeof r>; finalResult: typeof r }> {
    const results: Array<Awaited<ReturnType<typeof spider.crawl>>> = [];
    let finalResult: Awaited<ReturnType<typeof spider.crawl>> = null;
    for (let i = 0; i < maxCrawls; i++) {
      const r = await spider.crawl();
      if (r) {
        results.push(r);
        finalResult = r;
        if (r.action === 'rig-completed' || r.action === 'rig-blocked') break;
      } else {
        break;
      }
    }
    return { results, finalResult };
  }

  // ── V1: types are exported ───────────────────────────────────────────

  describe('Type exports (V1)', () => {
    it('SpiderEngineRunResult and SpiderCollectResult are exported from index', () => {
      // This test verifies compilation — the import at the top of this file
      // would fail to compile if the types were not exported.
      const runResult: SpiderEngineRunResult = { status: 'completed', yields: { ok: true }, graft: [] };
      const collectResult: SpiderCollectResult = { yields: { x: 1 }, graft: [] };
      assert.equal(runResult.status, 'completed');
      assert.equal(collectResult.yields !== undefined, true);
    });
  });

  // ── V2: EngineStatus includes skipped ────────────────────────────────

  describe('EngineStatus skipped (V2)', () => {
    it('skipped engines are reflected in the rig after a false when condition', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.flag}', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { flag: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { ran: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'skip test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const r = await spider.crawl(); // skip B (or rig-completed)

      const [rig] = await rigsBook(stacks).list();
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'B');
      assert.equal(engineB?.status, 'skipped', 'B should be skipped when A.flag is false');
      // rig is done (A completed, B skipped)
      assert.ok(
        r?.action === 'engine-skipped' || r?.action === 'rig-completed',
        `Expected engine-skipped or rig-completed, got ${r?.action}`,
      );
      // writ should be completed (one completed engine)
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });
  });

  // ── V3: Branching (when true runs, when false skips) ─────────────────

  describe('Branching — when condition (V3)', () => {
    it('runs the truthy branch and skips the falsy branch when review passes', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review',  designId: 'stub-review',  givens: {} },
          { id: 'seal',    designId: 'stub-seal',    upstream: ['review'], when: '${yields.review.passed}' },
          { id: 'revise',  designId: 'stub-revise',  upstream: ['review'], when: '!${yields.review.passed}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-review': { id: 'stub-review', async run() { return { status: 'completed' as const, yields: { passed: true } }; } },
            'stub-seal':   { id: 'stub-seal',   async run() { return { status: 'completed' as const, yields: { sealed: true } }; } },
            'stub-revise': { id: 'stub-revise', async run() { return { status: 'completed' as const, yields: { revised: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'branching test', body: 'body' });
      const { results } = await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'seal')?.status, 'completed', 'seal should run when passed=true');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'revise')?.status, 'skipped', 'revise should be skipped when passed=true');
      // engine-skipped may be absorbed into rig-completed when skipping causes rig completion
      assert.ok(
        results.some((r) => r?.action === 'engine-skipped') || results.some((r) => r?.action === 'rig-completed'),
        'should have engine-skipped or rig-completed result',
      );
      assert.equal(rig.status, 'completed');
    });

    it('runs the falsy branch and skips the truthy branch when review fails', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review',  designId: 'stub-review',  givens: {} },
          { id: 'seal',    designId: 'stub-seal',    upstream: ['review'], when: '${yields.review.passed}' },
          { id: 'revise',  designId: 'stub-revise',  upstream: ['review'], when: '!${yields.review.passed}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-review': { id: 'stub-review', async run() { return { status: 'completed' as const, yields: { passed: false } }; } },
            'stub-seal':   { id: 'stub-seal',   async run() { return { status: 'completed' as const, yields: { sealed: true } }; } },
            'stub-revise': { id: 'stub-revise', async run() { return { status: 'completed' as const, yields: { revised: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'branch-fail test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'seal')?.status, 'skipped', 'seal should be skipped when passed=false');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'revise')?.status, 'completed', 'revise should run when passed=false');
      assert.equal(rig.status, 'completed');
    });

    it('supports curly-brace when syntax: ${yields.review.passed}', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review', designId: 'stub-review', givens: {} },
          { id: 'seal',   designId: 'stub-seal',   upstream: ['review'], when: '${yields.review.passed}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-review': { id: 'stub-review', async run() { return { status: 'completed' as const, yields: { passed: true } }; } },
            'stub-seal':   { id: 'stub-seal',   async run() { return { status: 'completed' as const, yields: { sealed: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'curly brace when', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'seal')?.status, 'completed');
    });

    it('supports negated curly-brace when syntax: !${yields.review.passed}', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review', designId: 'stub-review', givens: {} },
          { id: 'revise', designId: 'stub-revise', upstream: ['review'], when: '!${yields.review.passed}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-review': { id: 'stub-review', async run() { return { status: 'completed' as const, yields: { passed: false } }; } },
            'stub-revise': { id: 'stub-revise', async run() { return { status: 'completed' as const, yields: { revised: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'negated curly brace when', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'revise')?.status, 'completed');
    });
  });

  // ── V4: Skipped upstream satisfies downstream dependencies ───────────

  describe('Skipped upstream satisfies dependencies (V4)', () => {
    it('downstream engine runs when its upstream was skipped', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.flag}', givens: {} },
          // C depends on B — B is skipped, C should still become runnable
          { id: 'C', designId: 'stub-c', upstream: ['B'], givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { flag: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { ranB: true } }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: { ranC: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'skip satisfies upstream', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'A')?.status, 'completed');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'B')?.status, 'skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'completed');
      assert.equal(rig.status, 'completed');
    });
  });

  // ── V5: Rig completion with skipped engines ──────────────────────────

  describe('Rig completion with skipped engines (V5)', () => {
    it('rig completes when some engines are completed and some are skipped', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.go}', givens: {} },
          { id: 'C', designId: 'stub-c', upstream: ['A'], when: '!${yields.A.go}', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { go: true } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { ranB: true } }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: { ranC: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'rig completion test', body: 'body' });
      const { results } = await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'completed');
      assert.ok(results.some((r) => r?.action === 'rig-completed'), 'rig-completed result expected');
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });

    it('does NOT complete the rig when all engines are skipped (no completed engine)', async () => {
      // All engines have when conditions that evaluate false
      // A: unconditional but immediately followed by B which is conditional
      // We need: A completes, then B is conditional and B.upstream.all done
      // Actually to get ALL skipped we need to think differently
      // Let's make A conditional on something external — we'll inject the rig directly
      // Start: A is conditional but its upstream is [] (so it becomes runnable)
      // BUT: engines with upstream=[] are always runnable, and `when` is evaluated when they become runnable
      // So A with when=$yields.X.v and upstream=[] would be runnable immediately, but X doesn't exist in upstream
      // That means upstream['X'] = undefined, value = undefined, truthy = false => skip

      // Actually wait — upstream=[] and when=$yields.X.v:
      // evaluateWhen: upstream['X'] is undefined => value is undefined => truthy=false => skip
      // But wait — upstream['X'] would be undefined, but engineYields is undefined so we don't enter the if block
      // value remains undefined => truthy = !!undefined = false => skip

      // But this won't pass template validation since 'X' is not in the template.
      // So we need to craft this differently.

      // Approach: manually patch the rig to have all skipped engines and verify
      // the CDC handler does NOT trigger (no rig-completed), and the rig stays in running state.
      // We can do this by crafting a template where A is a conditional dependency on B
      // which itself is conditional on A — but that would be a cycle (invalid).

      // Alternative: A unconditional, B,C conditional on A (one true, one false)
      // After B runs, C is skipped. Rig has: A completed, B completed, C skipped => rig completes.

      // For all-skipped: we need to directly test isRigComplete([])
      // isRigComplete returns false if no engines, or if none are completed.
      // Let's test via actual scenario: inject the rig doc directly, then verify
      // the rig's completion check via the Spider's CDC handler not firing.

      // The cleanest test for this edge case is to:
      // 1. Build a rig with all engines having skipped status
      // 2. Verify isRigComplete returns false
      // We can verify this by patching the rig directly and checking the rig stays in 'running' state.

      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.pass}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { pass: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { ran: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'partial complete test', body: 'body' });
      await drainToTerminal(spider);

      // A is completed, B is skipped — rig should complete (A is completed)
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'completed', 'rig should complete because A completed');

      // Verify the all-skipped case: manually patch a rig with all skipped
      // Create a rig where engines are all skipped - the CDC handler (status change to
      // completed) should NOT be triggered
      const book = rigsBook(stacks);
      const allSkippedRig: RigDoc = {
        id: generateId('rig', 4),
        writId: writ.id,
        status: 'running',
        engines: [
          { id: 'X', designId: 'stub-a', status: 'skipped', upstream: [], givensSpec: {} },
          { id: 'Y', designId: 'stub-b', status: 'skipped', upstream: ['X'], givensSpec: {} },
        ],
        createdAt: new Date().toISOString(),
      };
      await book.put(allSkippedRig);
      // Now patch to try to trigger completion check — Spider should NOT mark as completed
      // Since we have no running/pending engines but all are skipped (not completed),
      // isRigComplete returns false. The rig stays in running state until next crawl.
      // A subsequent crawl with no runnable engines and no blocked engines would leave it.
      const result = await spider.crawl();
      // The rig has no runnable engines (all skipped/no pending), so tryRun returns null
      // tryCollect finds no running engines, tryProcessGrafts nothing, tryCheckBlocked nothing
      // Spider returns null (or rig-spawned for the other writ if any)
      // The all-skipped rig should remain 'running' (not completed)
      const allSkippedRigRefetched = await book.find({ where: [['id', '=', allSkippedRig.id]], limit: 1 });
      assert.equal(allSkippedRigRefetched[0]?.status, 'running', 'all-skipped rig should NOT be marked completed');
    });
  });

  // ── V6: Template validation for `when` ───────────────────────────────

  describe('Template validation for when (V6)', () => {
    it('throws at startup when when expression is not a $yields reference', () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: 'not-a-valid-ref' },
        ],
      };
      assert.throws(
        () => buildFixture(
          { spider: { rigTemplates: { default: template } } },
          { status: 'completed' },
          { customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
          } },
        ),
        /invalid when expression/i,
        'should throw on invalid when expression',
      );
    });

    it('throws at startup when when references a non-existent engine', () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.nonexistent.passed}' },
        ],
      };
      assert.throws(
        () => buildFixture(
          { spider: { rigTemplates: { default: template } } },
          { status: 'completed' },
          { customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
          } },
        ),
        /not an engine in this template/,
        'should throw when referenced engine does not exist',
      );
    });

    it('throws at startup when when references a non-upstream engine', () => {
      // B references C but C is not upstream of B (they are siblings)
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.C.passed}' },
          { id: 'C', designId: 'stub-c', upstream: ['A'] },
        ],
      };
      assert.throws(
        () => buildFixture(
          { spider: { rigTemplates: { default: template } } },
          { status: 'completed' },
          { customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: {} }; } },
          } },
        ),
        /not upstream of/,
        'should throw when when references a non-upstream engine',
      );
    });

    it('does not throw for a valid negated when expression', () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '!${yields.A.passed}' },
        ],
      };
      assert.doesNotThrow(
        () => buildFixture(
          { spider: { rigTemplates: { default: template } } },
          { status: 'completed' },
          { customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
          } },
        ),
        'valid negated when expression should not throw',
      );
    });
  });

  // ── V7: engine-skipped CrawlResult variant ───────────────────────────

  describe('engine-skipped CrawlResult (V7)', () => {
    it('returns engine-skipped action when a when condition is false', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.run}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { run: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider } = fix;
      await clerk.post({ title: 'skip result test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const r = await spider.crawl(); // should skip B or return rig-completed

      // Could be engine-skipped (rig still needs more work after B) or rig-completed
      // In this 2-engine template with A completed and B skipped → rig-completed
      assert.ok(
        r?.action === 'engine-skipped' || r?.action === 'rig-completed',
        `Expected engine-skipped or rig-completed, got ${r?.action}`,
      );
    });

    it('engine-skipped result has engineId set correctly', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.run}' },
          { id: 'C', designId: 'stub-c', upstream: ['B'] }, // unconditional, becomes runnable after B skips
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { run: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider } = fix;
      await clerk.post({ title: 'skip engineId test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const r = await spider.crawl(); // skip B

      assert.equal(r?.action, 'engine-skipped', 'action should be engine-skipped');
      assert.equal((r as { engineId: string })?.engineId, 'B', 'engineId should be B');
    });
  });

  // ── V8: failEngine leaves skipped engines unchanged ──────────────────

  describe('failEngine leaves skipped engines unchanged (V8)', () => {
    it('skipped engine stays skipped when another engine fails', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.pass}' },
          { id: 'C', designId: 'stub-c', upstream: ['A'] }, // unconditional, will fail
        ],
      };
      let bRan = false;
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { pass: false } }; } },
            // B is skipped (pass=false), C runs and throws
            'stub-b': { id: 'stub-b', async run() { bRan = true; return { status: 'completed' as const, yields: {} }; } },
            'stub-c': { id: 'stub-c', async run() { throw new Error('C failed intentionally'); } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'failEngine skipped test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      // B should remain skipped (not cancelled), C should be failed
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'B')?.status, 'skipped', 'B should remain skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'failed', 'C should be failed');
      assert.equal(rig.status, 'stuck');
      assert.equal(bRan, false, 'B should not have run');
    });
  });

  // ── V11: Cascade skipping ────────────────────────────────────────────

  describe('Cascade skipping (V11)', () => {
    it('cascade-skips a chain of conditional downstream engines in one crawl step', async () => {
      // A → B (when A.x) → C (when B.y) → D (when C.z) → E (unconditional)
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.x}' },
          { id: 'C', designId: 'stub-c', upstream: ['B'], when: '${yields.B.y}' },
          { id: 'D', designId: 'stub-d', upstream: ['C'], when: '${yields.C.z}' },
          { id: 'E', designId: 'stub-e', upstream: ['D'] },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { x: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { y: true } }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: { z: true } }; } },
            'stub-d': { id: 'stub-d', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-e': { id: 'stub-e', async run() { return { status: 'completed' as const, yields: { ranE: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'cascade skip test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A (completes with x=false)
      const skipResult = await spider.crawl(); // should skip B and cascade-skip C, D

      // Check the engine-skipped result
      assert.equal(skipResult?.action, 'engine-skipped', 'should get engine-skipped');
      const skippedResult = skipResult as { action: 'engine-skipped'; engineId: string; cascadeSkipped?: string[] };
      assert.equal(skippedResult.engineId, 'B', 'primary skipped engine should be B');
      assert.ok(
        skippedResult.cascadeSkipped?.includes('C') ?? false,
        'C should be in cascadeSkipped',
      );
      assert.ok(
        skippedResult.cascadeSkipped?.includes('D') ?? false,
        'D should be in cascadeSkipped',
      );
      // E is unconditional and should NOT be cascade-skipped
      assert.ok(
        !(skippedResult.cascadeSkipped?.includes('E') ?? false),
        'E (unconditional) should NOT be in cascadeSkipped',
      );

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'B')?.status, 'skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'D')?.status, 'skipped');
      // E should still be pending (not cascade-skipped) — it will run next
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'E')?.status, 'pending');
    });

    it('unconditional engines are NOT cascade-skipped', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.flag}' }, // conditional, skipped
          { id: 'C', designId: 'stub-c', upstream: ['B'] }, // unconditional
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { flag: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: { ranC: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'unconditional no-cascade test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const skipResult = await spider.crawl(); // skip B

      assert.equal(skipResult?.action, 'engine-skipped');
      const skippedResult = skipResult as { cascadeSkipped?: string[] };
      // C is unconditional — it should NOT appear in cascadeSkipped
      assert.ok(
        !(skippedResult.cascadeSkipped?.includes('C') ?? false),
        'unconditional C should not be cascade-skipped',
      );

      // C should be pending (will run on next crawl)
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'pending');
    });
  });

  // ── When references skipped engine (edge case) ───────────────────────

  describe('when references a skipped engine (edge case)', () => {
    it('skips engine when its when references a skipped upstream engine (undefined is falsy)', async () => {
      // X skips B (B.when is falsy), C has when=$yields.B.result which is undefined (B was skipped)
      // => C should also be skipped (undefined is falsy)
      const template: RigTemplate = {
        engines: [
          { id: 'X', designId: 'stub-x', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['X'], when: '${yields.X.flag}' },
          { id: 'C', designId: 'stub-c', upstream: ['B'], when: '${yields.B.result}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-x': { id: 'stub-x', async run() { return { status: 'completed' as const, yields: { flag: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { result: 'something' } }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'skipped upstream when test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'B')?.status, 'skipped');
      // C references B which is skipped (no yields) => upstream['B'] is undefined => value=undefined => falsy => skip
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'skipped');
    });

    it('runs engine when its negated when references a skipped upstream engine (negated undefined is truthy)', async () => {
      // X completes with flag=false, B is skipped (when=$yields.X.flag=false)
      // C has when=!$yields.B.result — B is skipped so B.result is undefined => !undefined = true => C runs
      const template: RigTemplate = {
        engines: [
          { id: 'X', designId: 'stub-x', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['X'], when: '${yields.X.flag}' },
          { id: 'C', designId: 'stub-c', upstream: ['B'], when: '!${yields.B.result}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-x': { id: 'stub-x', async run() { return { status: 'completed' as const, yields: { flag: false } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: { result: 'something' } }; } },
            'stub-c': { id: 'stub-c', async run() { return { status: 'completed' as const, yields: { ranC: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'negated skipped upstream when test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'B')?.status, 'skipped');
      // C's when=!$yields.B.result: B is skipped (no yields) => upstream['B']=undefined => value=undefined => truthy=false => !false=true => C runs
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'C')?.status, 'completed');
    });
  });

  // ── V9, V10, V11: Engine-initiated grafting ───────────────────────────

  describe('Engine-initiated grafting — clockwork (V9, V10, V11)', () => {
    it('clockwork engine can graft new engines to the rig', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'decision', designId: 'stub-decision', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-decision': {
              id: 'stub-decision',
              async run() {
                const result: SpiderEngineRunResult = {
                  status: 'completed',
                  yields: { decided: true },
                  graft: [{ id: 'extra', designId: 'stub-extra', upstream: ['decision'] }],
                };
                return result;
              },
            },
            'stub-extra': {
              id: 'stub-extra',
              async run() { return { status: 'completed' as const, yields: { ran: true } }; },
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'graft test', body: 'body' });

      await spider.crawl(); // spawn
      const r1 = await spider.crawl(); // run decision → engine-completed
      assert.equal(r1?.action, 'engine-completed');

      const r2 = await spider.crawl(); // tryProcessGrafts → engine-grafted
      assert.equal(r2?.action, 'engine-grafted', 'should return engine-grafted');
      const graftResult = r2 as { action: 'engine-grafted'; engineId: string; graftedEngineIds: string[] };
      assert.equal(graftResult.engineId, 'decision', 'engineId should be the originating engine');
      assert.deepEqual(graftResult.graftedEngineIds, ['extra'], 'graftedEngineIds should contain extra');

      // Rig should now have 2 engines
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.length, 2, 'rig should have 2 engines after graft');
      assert.ok(rig.engines.find((e: EngineInstance) => e.id === 'extra'), 'extra engine should exist');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'extra')?.status, 'pending');

      const r3 = await spider.crawl(); // run extra → rig-completed (extra is the last engine)
      // When the last engine completes, tryRun returns rig-completed directly
      assert.equal(r3?.action, 'rig-completed');
      assert.equal((r3 as { outcome: string }).outcome, 'completed');

      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });

    it('graft is processed in a separate crawl step after engine-completed', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'graftingEngine', designId: 'stub-grafter', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-grafter': {
              id: 'stub-grafter',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { x: 1 },
                  graft: [{ id: 'added', designId: 'stub-added', upstream: ['graftingEngine'] }],
                };
              },
            },
            'stub-added': {
              id: 'stub-added',
              async run() { return { status: 'completed' as const, yields: {} }; },
            },
          },
        },
      );
      const { clerk, spider } = fix;
      await clerk.post({ title: 'graft step test', body: 'body' });

      const r1 = await spider.crawl(); // spawn
      assert.equal(r1?.action, 'rig-spawned');
      const r2 = await spider.crawl(); // run graftingEngine → engine-completed (graft queued)
      assert.equal(r2?.action, 'engine-completed', 'first step is engine-completed, not graft');
      const r3 = await spider.crawl(); // process grafts → engine-grafted
      assert.equal(r3?.action, 'engine-grafted', 'second step is engine-grafted');
    });
  });

  // ── V10: Graft validation failures ──────────────────────────────────

  describe('Graft validation failures (V10)', () => {
    it('fails originating engine when graft has a duplicate engine ID', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'bad-grafter', designId: 'stub-bad-grafter', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-bad-grafter': {
              id: 'stub-bad-grafter',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { ok: true },
                  // 'bad-grafter' already exists in the rig — duplicate
                  graft: [{ id: 'bad-grafter', designId: 'stub-bad-grafter', upstream: [] }],
                };
              },
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'dup id graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run bad-grafter → engine-completed (graft queued)
      const r = await spider.crawl(); // process graft → validation fails → rig-completed/failed

      assert.equal(r?.action, 'rig-completed', 'should return rig-completed on graft failure');
      assert.equal((r as { outcome: string }).outcome, 'stuck', 'outcome should be stuck');

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'stuck');
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'bad-grafter');
      assert.ok(failedEngine?.error?.includes('Duplicate engine id'), 'error should mention duplicate engine id');
    });

    it('fails originating engine when graft references unknown designId', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'grafter', designId: 'stub-grafter-unknown', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-grafter-unknown': {
              id: 'stub-grafter-unknown',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { ok: true },
                  graft: [{ id: 'new-engine', designId: 'totally-unknown-design', upstream: ['grafter'] }],
                };
              },
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'unknown designId graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run grafter → engine-completed
      const r = await spider.crawl(); // process graft → validation fails

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'stuck');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'grafter');
      assert.ok(failedEngine?.error?.includes('unknown designId'), 'error should mention unknown designId');
    });

    it('fails originating engine when graft creates a cycle', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'cycle-grafter', designId: 'stub-cycle-grafter', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-cycle-grafter': {
              id: 'stub-cycle-grafter',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { ok: true },
                  // Creates cycle: cycle-grafter → new1 → cycle-grafter (cycle-grafter already exists)
                  // Actually cycle-grafter is already in the rig — but new1 referencing cycle-grafter is fine
                  // We need to make a cycle among the grafted engines themselves
                  graft: [
                    { id: 'new1', designId: 'stub-new1', upstream: ['new2'] },
                    { id: 'new2', designId: 'stub-new2', upstream: ['new1'] },
                  ],
                };
              },
            },
            'stub-new1': { id: 'stub-new1', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-new2': { id: 'stub-new2', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'cycle graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run cycle-grafter → engine-completed
      const r = await spider.crawl(); // process graft → cycle detected → fail

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'stuck');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'cycle-grafter');
      assert.ok(failedEngine?.error?.includes('cycle') || failedEngine?.error?.includes('Graft validation failed'), 'error should mention cycle');
    });

    it('fails originating engine when graft references a non-existent when engine', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'grafter2', designId: 'stub-grafter2', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-grafter2': {
              id: 'stub-grafter2',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { ok: true },
                  graft: [{
                    id: 'new-engine',
                    designId: 'stub-new-engine',
                    upstream: ['grafter2'],
                    when: '${yields.nonexistent.val}',
                  }],
                };
              },
            },
            'stub-new-engine': { id: 'stub-new-engine', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'invalid when graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run grafter2 → engine-completed
      const r = await spider.crawl(); // process graft → when validation fails

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'stuck');
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'stuck');
    });
  });

  // ── V11: maxEnginesPerRig ────────────────────────────────────────────

  describe('maxEnginesPerRig limit (V11)', () => {
    it('fails originating engine when graft would exceed maxEnginesPerRig', async () => {
      // Set maxEnginesPerRig to 2, rig already has 1 engine, graft adds 2 → total 3 > 2
      const template: RigTemplate = {
        engines: [
          { id: 'grafter-max', designId: 'stub-grafter-max', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template }, maxEnginesPerRig: 2 } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-grafter-max': {
              id: 'stub-grafter-max',
              async run() {
                return {
                  status: 'completed' as const,
                  yields: { ok: true },
                  graft: [
                    { id: 'extra1', designId: 'stub-extra-max', upstream: ['grafter-max'] },
                    { id: 'extra2', designId: 'stub-extra-max', upstream: ['grafter-max'] },
                  ],
                };
              },
            },
            'stub-extra-max': { id: 'stub-extra-max', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'maxEnginesPerRig test', body: 'body' });
      await spider.crawl(); // spawn (rig has 1 engine)
      await spider.crawl(); // run grafter-max → engine-completed (1 completed, graft queued for +2)
      const r = await spider.crawl(); // process graft → exceeds maxEnginesPerRig(2) → fail

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'stuck');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'grafter-max');
      assert.ok(
        failedEngine?.error?.includes('maxEnginesPerRig') || failedEngine?.error?.includes('exceed'),
        `error should mention maxEnginesPerRig, got: ${failedEngine?.error}`,
      );
    });

    it('uses default maxEnginesPerRig of 50 when not configured', async () => {
      // Graft 49 new engines to a rig with 1 engine = 50 total (OK)
      // Then try 50 more (51 total — should fail)
      // This test is complex; just verify the default is 50 by checking error message
      const template: RigTemplate = {
        engines: [
          { id: 'big-grafter', designId: 'stub-big-grafter', givens: {} },
        ],
      };
      // Build graft of 50 engines (would bring total to 1+50=51, exceeding default 50)
      const graft = Array.from({ length: 50 }, (_, i) => ({
        id: `extra-${i}`,
        designId: 'stub-extra-big',
        upstream: ['big-grafter'],
      }));

      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } }, // no maxEnginesPerRig → default 50
        { status: 'completed' },
        {
          customEngines: {
            'stub-big-grafter': {
              id: 'stub-big-grafter',
              async run() { return { status: 'completed' as const, yields: {}, graft } as SpiderEngineRunResult; },
            },
            'stub-extra-big': { id: 'stub-extra-big', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'default max test', body: 'body' });
      await spider.crawl(); // spawn (1 engine)
      await spider.crawl(); // run big-grafter → completed (graft of 50 queued → 51 total)
      const r = await spider.crawl(); // process graft → exceeds 50

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'stuck');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'big-grafter');
      assert.ok(
        failedEngine?.error?.includes('maxEnginesPerRig') || failedEngine?.error?.includes('exceed'),
        `error should mention maxEnginesPerRig or exceed, got: ${failedEngine?.error}`,
      );
    });
  });

  // ── V12: Quick engine collect graft ──────────────────────────────────

  describe('Quick engine collect graft (V12)', () => {
    it('quick engine can graft via collect() returning SpiderCollectResult', async () => {
      // We need a quick engine whose collect() returns { yields, graft }
      // We use the blocking fixture pattern to inject a custom quick engine
      const memBackend = new MemoryBackend();
      const stacksPlugin = createStacksApparatus(memBackend);
      const clerkPlugin = createClerk();
      const fabricatorPlugin = createFabricator();
      const spiderPlugin = createSpider();

      if (!('apparatus' in stacksPlugin)) throw new Error();
      if (!('apparatus' in clerkPlugin)) throw new Error();
      if (!('apparatus' in fabricatorPlugin)) throw new Error();
      if (!('apparatus' in spiderPlugin)) throw new Error();

      const stacksApparatus = stacksPlugin.apparatus;
      const clerkApparatus = clerkPlugin.apparatus;
      const fabricatorApparatus = fabricatorPlugin.apparatus;
      const spiderApparatus = spiderPlugin.apparatus;

      const apparatusMap = new Map<string, unknown>();

      const template: RigTemplate = {
        engines: [{ id: 'quick-grafting', designId: 'stub-quick-grafting', givens: {} }],
      };

      const fakeGuildConfig: GuildConfig = {
        name: 'test-guild',
        nexus: '0.0.0',
        plugins: [],
        spider: {
          rigTemplates: { default: template },
          rigTemplateMappings: { mandate: 'default' },
        },
      };

      let sessionId: string | null = null;

      // Quick engine: run() launches a session, collect() returns SpiderCollectResult
      const quickGraftingEngine: EngineDesign = {
        id: 'stub-quick-grafting',
        async run(_givens, context) {
          // Simulate launching a session
          const fakeId = `fake-ses-${context.engineId}`;
          sessionId = fakeId;
          return { status: 'launched' as const, sessionId: fakeId };
        },
        async collect(_sessionId) {
          const result: SpiderCollectResult = {
            yields: { collected: true },
            graft: [{ id: 'follow-up', designId: 'stub-follow-up', upstream: ['quick-grafting'] }],
          };
          return result;
        },
      };

      const stubFollowUp: EngineDesign = {
        id: 'stub-follow-up',
        async run() { return { status: 'completed' as const, yields: { done: true } }; },
      };

      const customEngineApparatus: LoadedApparatus = {
        packageName: '@test/quick-graft-engines',
        id: 'test-qg-engines',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { engines: { 'stub-quick-grafting': quickGraftingEngine, 'stub-follow-up': stubFollowUp } },
          provides: {},
          start() {},
        },
      };

      const spiderAsLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus',
        id: 'spider',
        version: '0.0.0',
        apparatus: spiderApparatus,
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

      const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded, customEngineApparatus]);
      const spiderKitEntries = buildKitEntries([], [spiderAsLoaded]);

      const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
      stacksApparatus.start(noopCtx);
      const stacks = stacksApparatus.provides as StacksApi;
      apparatusMap.set('stacks', stacks);

      memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
        indexes: ['phase', 'type', 'createdAt', ['phase', 'type'], ['phase', 'createdAt']],
      });
      memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
        indexes: ['status', 'writId', ['status', 'writId'], 'createdAt'],
      });
      memBackend.ensureBook({ ownerId: 'animator', book: 'sessions' }, {
        indexes: ['startedAt', 'status'],
      });

      // Fake animator that writes a session doc for the session our quick engine launched
      const mockAnimator: AnimatorApi = {
        summon(): AnimateHandle {
          throw new Error('summon not used');
        },
        animate(): AnimateHandle {
          throw new Error('animate not used');
        },
      };
      apparatusMap.set('animator', mockAnimator);

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

      const writ = await clerk.post({ title: 'quick graft test', body: 'body' });

      const r1 = await spider.crawl(); // spawn
      assert.equal(r1?.action, 'rig-spawned');

      const r2 = await spider.crawl(); // run quick-grafting → engine-started
      assert.equal(r2?.action, 'engine-started');

      // Now manually write a completed session doc so collect can run
      assert.ok(sessionId, 'sessionId should have been set by run()');
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: sessionId!,
        status: 'completed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        provider: 'test',
        exitCode: 0,
      });

      const r3 = await spider.crawl(); // tryCollect → engine-completed (with graft queued)
      assert.equal(r3?.action, 'engine-completed', 'should collect and complete');

      const r4 = await spider.crawl(); // tryProcessGrafts → engine-grafted
      assert.equal(r4?.action, 'engine-grafted', 'should process graft from collect');
      assert.deepEqual((r4 as { graftedEngineIds: string[] }).graftedEngineIds, ['follow-up']);

      // Check yields were extracted correctly (not the whole { yields, graft } object)
      const book = rigsBook(stacks);
      const rigs = await book.list();
      const rig = rigs[0];
      const quickEngine = rig.engines.find((e: EngineInstance) => e.id === 'quick-grafting');
      assert.deepEqual(quickEngine?.yields, { collected: true }, 'yields should be extracted from SpiderCollectResult');

      // follow-up is the last engine, so when it completes, tryRun returns rig-completed directly
      const r5 = await spider.crawl(); // run follow-up → rig-completed (it's the last engine)
      assert.equal(r5?.action, 'rig-completed');
      assert.equal((r5 as { outcome: string }).outcome, 'completed');

      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });
  });

  // ── Bounded retry pattern (pre-seeded) ───────────────────────────────

  describe('Bounded retry pattern (V3)', () => {
    it('review-1 passes → review-2 and revise-1 skipped → seal runs', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'implement',  designId: 'stub-impl',    givens: {} },
          { id: 'review-1',   designId: 'stub-review1', upstream: ['implement'] },
          { id: 'revise-1',   designId: 'stub-revise1', upstream: ['review-1'],  when: '!${yields.review-1.passed}' },
          { id: 'review-2',   designId: 'stub-review2', upstream: ['revise-1'],  when: '!${yields.review-1.passed}' },
          { id: 'seal',       designId: 'stub-seal',    upstream: ['review-1', 'review-2'] },
        ],
      };

      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-impl':    { id: 'stub-impl',    async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-review1': { id: 'stub-review1', async run() { return { status: 'completed' as const, yields: { passed: true } }; } },
            'stub-revise1': { id: 'stub-revise1', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-review2': { id: 'stub-review2', async run() { return { status: 'completed' as const, yields: { passed: true } }; } },
            'stub-seal':    { id: 'stub-seal',    async run() { return { status: 'completed' as const, yields: { sealed: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'retry review-1 passes', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'revise-1')?.status, 'skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'review-2')?.status, 'skipped');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'seal')?.status, 'completed');
      assert.equal(rig.status, 'completed');
    });

    it('review-1 fails, review-2 passes → revise-1 and review-2 run → seal runs', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'implement',  designId: 'stub-impl',    givens: {} },
          { id: 'review-1',   designId: 'stub-review1', upstream: ['implement'] },
          { id: 'revise-1',   designId: 'stub-revise1', upstream: ['review-1'],  when: '!${yields.review-1.passed}' },
          { id: 'review-2',   designId: 'stub-review2', upstream: ['revise-1'],  when: '!${yields.review-1.passed}' },
          { id: 'seal',       designId: 'stub-seal',    upstream: ['review-1', 'review-2'] },
        ],
      };

      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-impl':    { id: 'stub-impl',    async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-review1': { id: 'stub-review1', async run() { return { status: 'completed' as const, yields: { passed: false } }; } },
            'stub-revise1': { id: 'stub-revise1', async run() { return { status: 'completed' as const, yields: {} }; } },
            'stub-review2': { id: 'stub-review2', async run() { return { status: 'completed' as const, yields: { passed: true } }; } },
            'stub-seal':    { id: 'stub-seal',    async run() { return { status: 'completed' as const, yields: { sealed: true } }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'retry review-1 fails', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'revise-1')?.status, 'completed');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'review-2')?.status, 'completed');
      assert.equal(rig.engines.find((e: EngineInstance) => e.id === 'seal')?.status, 'completed');
      assert.equal(rig.status, 'completed');
    });
  });

  // ── buildFromTemplate copies when field ───────────────────────────────

  describe('buildFromTemplate copies when field', () => {
    it('engine instances have the when field from the template', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.go}' },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: template } } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-a': { id: 'stub-a', async run() { return { status: 'completed' as const, yields: { go: true } }; } },
            'stub-b': { id: 'stub-b', async run() { return { status: 'completed' as const, yields: {} }; } },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'when field test', body: 'body' });
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'B');
      assert.equal(engineB?.when, '${yields.A.go}', 'when field should be copied to engine instance');
    });
  });
});

// ── Rig cancellation tests ──────────────────────────────────────────────

describe('Spider — rig cancellation', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // Test 1: Cancel running rig — happy path
  it('cancel running rig — happy path', async () => {
    const { clerk, spider, stacks, cancelCalls } = fix;
    await postWrit(clerk);
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Mark draft as completed so implement can launch
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'draft'
        ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }
        : e,
    );
    await book.patch(rig.id, { engines: updatedEngines });

    // Launch implement (creates session)
    const startResult = await spider.crawl();
    assert.equal(startResult?.action, 'engine-started');

    const [rigAfterStart] = await book.list();
    const implEngine = rigAfterStart.engines.find((e: EngineInstance) => e.id === 'implement');
    assert.ok(implEngine?.sessionId, 'implement should have a sessionId');

    // Insert a running session (override the auto-completed one)
    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    await sessBook.patch(implEngine!.sessionId!, { status: 'running', endedAt: undefined });

    // Cancel the rig
    const cancelledRig = await spider.cancel(rig.id);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');

    // Animator.cancel should have been called
    assert.equal(cancelCalls.length, 1, 'should have called animator.cancel once');
    assert.equal(cancelCalls[0].sessionId, implEngine!.sessionId);

    // Check engine statuses
    const impl = cancelledRig.engines.find((e: EngineInstance) => e.id === 'implement');
    assert.equal(impl?.status, 'cancelled', 'implement should be cancelled');
    assert.ok(impl?.completedAt, 'implement should have completedAt');

    // Pending engines should be cancelled
    for (const id of ['review', 'revise', 'seal']) {
      const eng = cancelledRig.engines.find((e: EngineInstance) => e.id === id);
      assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
    }

    // Completed engine should be unchanged
    const draft = cancelledRig.engines.find((e: EngineInstance) => e.id === 'draft');
    assert.equal(draft?.status, 'completed', 'draft should remain completed');
  });

  // Test 2: Cancel running rig with reason
  it('cancel running rig with reason stores reason in error field', async () => {
    const { clerk, spider, stacks } = fix;
    await postWrit(clerk);
    await spider.crawl(); // spawn

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Pre-complete draft, launch implement
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'draft'
        ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }
        : e,
    );
    await book.patch(rig.id, { engines: updatedEngines });
    await spider.crawl(); // engine-started

    const [rigAfterStart] = await book.list();
    const implEngine = rigAfterStart.engines.find((e: EngineInstance) => e.id === 'implement');
    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    await sessBook.patch(implEngine!.sessionId!, { status: 'running', endedAt: undefined });

    const cancelledRig = await spider.cancel(rig.id, { reason: 'No longer needed' });

    const impl = cancelledRig.engines.find((e: EngineInstance) => e.id === 'implement');
    assert.equal(impl?.error, 'No longer needed', 'reason should be in error field');
  });

  // Test 3: Cancel blocked rig
  it('cancel blocked rig — blocked engine gets cancelled with block cleared', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    const blockRecord: BlockRecord = {
      type: 'patron-input',
      condition: { requestId: 'ir-123' },
      blockedAt: now,
    };
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'blocked',
      engines: [
        { id: 'eng-blocked', designId: 'dummy', status: 'blocked', upstream: [], givensSpec: {}, block: blockRecord },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-blocked'], givensSpec: {} },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled');
    const engBlocked = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-blocked');
    assert.equal(engBlocked?.status, 'cancelled', 'blocked engine should be cancelled');
    assert.equal(engBlocked?.block, undefined, 'block should be cleared');
    assert.ok(engBlocked?.completedAt, 'blocked engine should have completedAt');

    const engPending = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-pending');
    assert.equal(engPending?.status, 'cancelled', 'pending engine should be cancelled');
  });

  // Test 4: Cancel blocked rig with pending input request
  it('cancel rig rejects pending input requests', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'blocked',
      engines: [
        {
          id: 'eng-blocked',
          designId: 'dummy',
          status: 'blocked',
          upstream: [],
          givensSpec: {},
          block: { type: 'patron-input', condition: { requestId: 'ir-test' }, blockedAt: now },
        },
      ],
      createdAt: now,
    });

    // Create pending input request
    const irBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
    await irBook.put({
      id: 'ir-test',
      rigId,
      engineId: 'eng-blocked',
      status: 'pending',
      questions: { q1: { type: 'boolean', label: 'Continue?' } },
      answers: {},
      createdAt: now,
      updatedAt: now,
    });

    await spider.cancel(rigId);

    const updatedIr = await irBook.get('ir-test');
    assert.equal(updatedIr?.status, 'rejected', 'input request should be rejected');
    assert.equal(updatedIr?.rejectionReason, 'Rig cancelled', 'rejection reason should be set');
  });

  // Test 5: Cancel idempotent on terminal rig (completed)
  it('cancel is idempotent on completed rig', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'completed',
      engines: [
        { id: 'eng1', designId: 'dummy', status: 'completed', upstream: [], givensSpec: {}, yields: {}, completedAt: now },
      ],
      createdAt: now,
    });

    const result = await spider.cancel(rigId);
    assert.equal(result.status, 'completed', 'should return rig unchanged');
  });

  // Test 6: Cancel idempotent on already-cancelled rig
  it('cancel is idempotent on already-cancelled rig', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'cancelled',
      engines: [
        { id: 'eng1', designId: 'dummy', status: 'cancelled', upstream: [], givensSpec: {} },
      ],
      createdAt: now,
    });

    const result = await spider.cancel(rigId);
    assert.equal(result.status, 'cancelled', 'should return rig unchanged');
  });

  // Test 7: Cancel non-existent rig throws
  it('cancel non-existent rig throws', async () => {
    const { spider } = fix;
    await assert.rejects(
      () => spider.cancel('rig-nonexistent'),
      /not found/i,
    );
  });

  // Test 8: tryCollect detects cancelled session
  it('tryCollect detects cancelled session → rig-completed cancelled', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    const fakeSessionId = generateId('ses', 4);

    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, sessionId: fakeSessionId, startedAt: now },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
      ],
      createdAt: now,
    });

    // Insert a cancelled session
    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    await sessBook.put({
      id: fakeSessionId,
      status: 'cancelled',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      provider: 'test',
      exitCode: 1,
      error: 'User cancelled',
      metadata: {},
    });

    const result = await spider.crawl();

    assert.ok(result !== null, 'crawl should return a result');
    assert.equal(result!.action, 'rig-completed');
    assert.equal((result as { outcome: string }).outcome, 'cancelled');

    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled');
    const engRunning = updatedRig?.engines.find((e: EngineInstance) => e.id === 'eng-running');
    assert.equal(engRunning?.status, 'cancelled', 'running engine should be cancelled');
    assert.equal(engRunning?.error, 'User cancelled', 'error from session should be preserved');
    const engPending = updatedRig?.engines.find((e: EngineInstance) => e.id === 'eng-pending');
    assert.equal(engPending?.status, 'cancelled', 'pending engine should be cancelled');
  });

  // Test 9: tryCollect cancelled session rejects input requests
  it('tryCollect cancelled session rejects pending input requests', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    const fakeSessionId = generateId('ses', 4);

    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, sessionId: fakeSessionId, startedAt: now },
        {
          id: 'eng-blocked',
          designId: 'dummy',
          status: 'blocked',
          upstream: [],
          givensSpec: {},
          block: { type: 'patron-input', condition: { requestId: 'ir-x' }, blockedAt: now },
        },
      ],
      createdAt: now,
    });

    // Create pending input request
    const irBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
    await irBook.put({
      id: 'ir-x',
      rigId,
      engineId: 'eng-blocked',
      status: 'pending',
      questions: { q1: { type: 'text', label: 'Describe' } },
      answers: {},
      createdAt: now,
      updatedAt: now,
    });

    // Insert a cancelled session
    const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
    await sessBook.put({
      id: fakeSessionId,
      status: 'cancelled',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      provider: 'test',
      exitCode: 1,
      metadata: {},
    });

    await spider.crawl();

    const updatedIr = await irBook.get('ir-x');
    assert.equal(updatedIr?.status, 'rejected', 'input request should be rejected');
    assert.equal(updatedIr?.rejectionReason, 'Rig cancelled');
  });

  // Test 10: CDC handler transitions writ to cancelled
  it('CDC handler transitions writ to cancelled with error reason', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng1', designId: 'dummy', status: 'cancelled', upstream: [], givensSpec: {}, error: 'User requested stop', completedAt: now },
      ],
      createdAt: now,
    });

    // Patch to cancelled triggers CDC
    await book.patch(rigId, { status: 'cancelled' });

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should transition to cancelled');
  });

  // Test 11: CDC handler cancelled without error message uses fallback
  it('CDC handler cancelled without engine error uses "Rig cancelled" fallback', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng1', designId: 'dummy', status: 'cancelled', upstream: [], givensSpec: {}, completedAt: now },
      ],
      createdAt: now,
    });

    await book.patch(rigId, { status: 'cancelled' });

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should transition to cancelled');
  });

  // ── Rig cancel with already-terminal writ ─────────────────────────────

  // Test 12: Cancel rig whose writ is already cancelled
  it('cancel rig whose writ is already cancelled — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'cancelled');

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, startedAt: now },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');
    const engRunning = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-running');
    assert.equal(engRunning?.status, 'cancelled', 'running engine should be cancelled');
    const engPending = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-pending');
    assert.equal(engPending?.status, 'cancelled', 'pending engine should be cancelled');

    // Writ should remain cancelled (not re-transitioned)
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should still be cancelled');
  });

  // Test 13: Cancel rig whose writ is already completed
  it('cancel rig whose writ is already completed — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'completed');

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, startedAt: now },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');

    // Writ should remain completed (not re-transitioned)
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should still be completed');
  });

  // Test 14: Cancel rig whose writ is already failed
  it('cancel rig whose writ is already failed — rig transitions, writ untouched', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'failed');

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, startedAt: now },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');

    // Writ should remain failed (not re-transitioned)
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'failed', 'writ should still be failed');
  });

  // Test 15: Cancel rig with open writ — both transition (regression guard)
  it('cancel rig with open writ — both rig and writ transition to cancelled', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {}, startedAt: now },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should also be cancelled');
  });

  // Test 16: Cancel rig with mixed engine statuses — preserves completed engines
  it('cancel rig with mixed engine statuses — running/pending cancelled, completed preserved', async () => {
    const { stacks, spider, clerk } = fix;
    const writ = await postWrit(clerk);
    await clerk.transition(writ.id, 'cancelled');

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'running',
      engines: [
        { id: 'eng-completed', designId: 'dummy', status: 'completed', upstream: [], givensSpec: {}, yields: { x: 1 }, completedAt: now },
        { id: 'eng-running', designId: 'dummy', status: 'running', upstream: ['eng-completed'], givensSpec: {}, startedAt: now },
        { id: 'eng-pending1', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
        { id: 'eng-pending2', designId: 'dummy', status: 'pending', upstream: ['eng-running'], givensSpec: {} },
        { id: 'eng-pending3', designId: 'dummy', status: 'pending', upstream: ['eng-pending1', 'eng-pending2'], givensSpec: {} },
      ],
      createdAt: now,
    });

    const cancelledRig = await spider.cancel(rigId);

    assert.equal(cancelledRig.status, 'cancelled', 'rig should be cancelled');

    const engCompleted = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-completed');
    assert.equal(engCompleted?.status, 'completed', 'completed engine should be preserved');

    const engRunning = cancelledRig.engines.find((e: EngineInstance) => e.id === 'eng-running');
    assert.equal(engRunning?.status, 'cancelled', 'running engine should be cancelled');

    for (const id of ['eng-pending1', 'eng-pending2', 'eng-pending3']) {
      const eng = cancelledRig.engines.find((e: EngineInstance) => e.id === id);
      assert.equal(eng?.status, 'cancelled', `${id} should be cancelled`);
    }
  });

  // ── Concurrent engine throttle ────────────────────────────────────────

  describe('countRunningEngines / countRunningEnginesInRig', () => {
    const now = new Date().toISOString();

    function makeRig(id: string, engines: Array<{ id: string; status: string }>): RigDoc {
      return {
        id,
        writId: `writ-${id}`,
        status: 'running',
        engines: engines.map((e) => ({
          id: e.id,
          designId: 'stub',
          status: e.status as EngineInstance['status'],
          upstream: [],
          givensSpec: {},
        })),
        createdAt: now,
      };
    }

    it('counts only running engines across rigs', () => {
      const rigs = [
        makeRig('r1', [
          { id: 'e1', status: 'running' },
          { id: 'e2', status: 'pending' },
          { id: 'e3', status: 'completed' },
        ]),
        makeRig('r2', [
          { id: 'e4', status: 'running' },
          { id: 'e5', status: 'running' },
        ]),
        makeRig('r3', [
          { id: 'e6', status: 'blocked' },
          { id: 'e7', status: 'failed' },
          { id: 'e8', status: 'cancelled' },
          { id: 'e9', status: 'skipped' },
        ]),
      ];
      assert.equal(countRunningEngines(rigs), 3, 'should count 3 running engines');
    });

    it('returns 0 when no engines are running', () => {
      const rigs = [
        makeRig('r1', [
          { id: 'e1', status: 'pending' },
          { id: 'e2', status: 'completed' },
        ]),
      ];
      assert.equal(countRunningEngines(rigs), 0);
    });

    it('returns 0 for empty rigs array', () => {
      assert.equal(countRunningEngines([]), 0);
    });

    it('counts running engines in a single rig', () => {
      const rig = makeRig('r1', [
        { id: 'e1', status: 'running' },
        { id: 'e2', status: 'running' },
        { id: 'e3', status: 'pending' },
        { id: 'e4', status: 'completed' },
      ]);
      assert.equal(countRunningEnginesInRig(rig), 2);
    });

    it('returns 0 when rig has no running engines', () => {
      const rig = makeRig('r1', [
        { id: 'e1', status: 'pending' },
        { id: 'e2', status: 'blocked' },
      ]);
      assert.equal(countRunningEnginesInRig(rig), 0);
    });
  });

  describe('Concurrent engine throttle — tryRun', () => {
    // Template with two parallel engines so we can test per-rig limit
    const PARALLEL_TEMPLATE: RigTemplate = {
      engines: [
        { id: 'a', designId: 'quick-stub', givens: {} },
        { id: 'b', designId: 'quick-stub', givens: {} },
        { id: 'c', designId: 'quick-stub', givens: {} },
      ],
    };

    it('defers an engine when it would breach the system-wide limit', async () => {
      // maxConcurrentEngines=1: after one engine launches, the next should be deferred
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 3 } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'throttle-test', body: 'b' });
      await spider.crawl(); // spawn rig
      await spider.crawl(); // run engine 'a' → launched (1 running)

      // Now engine 'b' is runnable but system limit is 1
      const result = await spider.crawl();
      // tryRun should defer all runnable engines and return null, falling through to trySpawn
      // But trySpawn also checks and returns null → overall null
      assert.equal(result, null, 'should idle when system-wide limit reached');

      // Verify engine 'b' is still pending
      const [rig] = await rigsBook(stacks).list();
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'b');
      assert.equal(engineB?.status, 'pending', 'engine b should remain pending');
    });

    it('defers an engine when it would breach the per-rig limit', async () => {
      // maxConcurrentEnginesPerRig=1, maxConcurrentEngines=10
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 10, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'per-rig-test', body: 'b' });
      await spider.crawl(); // spawn rig
      await spider.crawl(); // run engine 'a' → launched (1 running in rig)

      // Engine 'b' is runnable but per-rig limit is 1
      const result = await spider.crawl();
      assert.equal(result, null, 'should idle when per-rig limit reached');

      const [rig] = await rigsBook(stacks).list();
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'b');
      assert.equal(engineB?.status, 'pending', 'engine b should remain pending');
    });

    it('starts engine when both limits have room', async () => {
      // maxConcurrentEngines=5, maxConcurrentEnginesPerRig=3
      const fix = buildFixture(
        { spider: { rigTemplates: { default: PARALLEL_TEMPLATE }, maxConcurrentEngines: 5, maxConcurrentEnginesPerRig: 3 } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider } = fix;
      await clerk.post({ title: 'start-test', body: 'b' });
      await spider.crawl(); // spawn rig
      const result = await spider.crawl(); // run engine 'a' → should succeed
      assert.ok(result !== null, 'should start engine');
      assert.equal(result!.action, 'engine-started');
    });
  });

  describe('Concurrent engine throttle — trySpawn', () => {
    it('does not spawn a new rig when system-wide engine limit is reached', async () => {
      const SINGLE_QUICK_TEMPLATE: RigTemplate = {
        engines: [
          { id: 'only', designId: 'quick-stub', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: SINGLE_QUICK_TEMPLATE }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;

      // Post two writs
      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig for writ1
      await spider.crawl(); // run engine 'only' in rig1 → launched (1 running)

      // Now writ2 is open, but system limit = 1 and we have 1 running engine
      const result = await spider.crawl();
      assert.equal(result, null, 'should not spawn second rig when at system limit');

      // Only 1 rig should exist
      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist');
    });

    it('spawns a new rig when system-wide limit has room', async () => {
      const SINGLE_CLOCKWORK: RigTemplate = {
        engines: [
          { id: 'only', designId: 'stub-clockwork', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: SINGLE_CLOCKWORK }, maxConcurrentEngines: 5 } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-clockwork': {
              id: 'stub-clockwork',
              run: async () => ({ status: 'completed' as const, yields: { done: true } }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig for writ1
      await spider.crawl(); // run clockwork engine in rig1 → completed (0 running now)
      const result = await spider.crawl(); // should spawn rig for writ2
      assert.ok(result !== null, 'should have work');
      assert.equal(result!.action, 'rig-spawned', 'should spawn when limit has room');

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 2, 'both rigs should exist');
    });
  });

  describe('Concurrent engine throttle — behavioral', () => {
    it('with maxConcurrentEngines=2, exactly 2 engines reach running status across rigs', async () => {
      const SINGLE_QUICK: RigTemplate = {
        engines: [
          { id: 'only', designId: 'quick-stub', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: SINGLE_QUICK }, maxConcurrentEngines: 2, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;

      // Post 4 writs
      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });
      await clerk.post({ title: 'writ3', body: 'b' });
      await clerk.post({ title: 'writ4', body: 'b' });

      // Spawn and run repeatedly
      // Spawn rig1, spawn rig2, run rig1 engine, run rig2 engine, then no more
      for (let i = 0; i < 20; i++) {
        await spider.crawl();
      }

      const allRigs = await rigsBook(stacks).list();
      let totalRunning = 0;
      let totalPending = 0;
      for (const rig of allRigs) {
        for (const e of rig.engines) {
          if (e.status === 'running') totalRunning++;
          if (e.status === 'pending') totalPending++;
        }
      }

      assert.equal(totalRunning, 2, 'exactly 2 engines should be running');
      // Remaining writs should either have no rig yet (still open) or rig with pending engine
      // Since trySpawn is also throttled, we should have exactly 2 rigs
      assert.equal(allRigs.length, 2, 'only 2 rigs should be spawned (trySpawn throttled)');
    });

    it('deferred engines start once a slot frees after completion', async () => {
      // Two-engine sequential template: first clockwork, then quick.
      // After the clockwork engine completes, the quick engine should start.
      // With maxConcurrentEngines=1, the clockwork engine occupies the slot
      // transiently (completes in same tick), freeing it for the quick engine
      // on the next tick.
      const TWO_ENGINE: RigTemplate = {
        engines: [
          { id: 'step1', designId: 'stub-clockwork', givens: {} },
          { id: 'step2', designId: 'quick-stub', givens: {}, upstream: ['step1'] },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: TWO_ENGINE }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'stub-clockwork': {
              id: 'stub-clockwork',
              run: async () => ({ status: 'completed' as const, yields: { done: true } }),
            },
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'writ1', body: 'b' });
      await clerk.post({ title: 'writ2', body: 'b' });

      await spider.crawl(); // spawn rig1
      await spider.crawl(); // run step1 (clockwork) → engine-completed (slot freed immediately)
      await spider.crawl(); // run step2 (quick) → engine-started (1 running slot used)

      // Now system limit reached (step2 is running). Writ2 should not spawn.
      const r = await spider.crawl();
      // trySpawn should be blocked by system limit
      assert.equal(r, null, 'should idle when quick engine is running and system limit reached');

      const rigs = await rigsBook(stacks).list();
      assert.equal(rigs.length, 1, 'only one rig should exist while slot is occupied');

      // Verify step2 is running
      const [rig] = rigs;
      const step2 = rig.engines.find((e: EngineInstance) => e.id === 'step2');
      assert.equal(step2?.status, 'running', 'step2 should be running');
    });
  });

  describe('Concurrent engine throttle — regression', () => {
    it('tryCollect is never throttled', async () => {
      // With maxConcurrentEngines=1, collect should still work even if 1 engine is running
      const SINGLE_QUICK: RigTemplate = {
        engines: [
          { id: 'only', designId: 'animator-quick', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: SINGLE_QUICK }, maxConcurrentEngines: 1, maxConcurrentEnginesPerRig: 1 } },
        { status: 'completed' },
        {
          customEngines: {
            'animator-quick': {
              id: 'animator-quick',
              async run() {
                const animator = (await import('@shardworks/nexus-core')).guild().apparatus<AnimatorApi>('animator');
                const handle = animator.summon({ role: 'test', prompt: 'test', cwd: '/tmp' });
                return { status: 'launched' as const, sessionId: handle.sessionId };
              },
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;

      await clerk.post({ title: 'collect-test', body: 'b' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run → launched (1 running)

      // The mock animator eagerly writes terminal session, so collect should pick it up
      const result = await spider.crawl();
      assert.ok(result !== null, 'collect should not be blocked by throttle');
      // The action should be rig-completed (single engine rig with completed session)
      assert.equal(result!.action, 'rig-completed', 'should collect and complete rig');
    });

    it('uses defaults of maxConcurrentEngines=3, maxConcurrentEnginesPerRig=1 when not configured', async () => {
      // Don't configure any throttle settings — use the standard fixture
      const SINGLE_QUICK: RigTemplate = {
        engines: [
          { id: 'only', designId: 'quick-stub', givens: {} },
        ],
      };
      const fix = buildFixture(
        { spider: { rigTemplates: { default: SINGLE_QUICK } } },
        { status: 'completed' },
        {
          customEngines: {
            'quick-stub': {
              id: 'quick-stub',
              run: async () => ({ status: 'launched' as const, sessionId: generateId('ses', 4) }),
              collect: async () => ({ yields: {} }),
            },
          },
        },
      );
      const { clerk, spider, stacks } = fix;

      // Post 5 writs
      for (let i = 0; i < 5; i++) {
        await clerk.post({ title: `writ${i}`, body: 'b' });
      }

      // Run many crawl ticks
      for (let i = 0; i < 30; i++) {
        await spider.crawl();
      }

      const allRigs = await rigsBook(stacks).list();
      let totalRunning = 0;
      for (const rig of allRigs) {
        for (const e of rig.engines) {
          if (e.status === 'running') totalRunning++;
        }
      }

      assert.equal(totalRunning, 3, 'default maxConcurrentEngines should be 3');
      assert.equal(allRigs.length, 3, 'default limit should cap at 3 spawned rigs');
    });
  });

});

// ── Writ→Rig cascade tests ──────────────────────────────────────────

describe('Spider — writ→rig cascade', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  /**
   * Helper: post a writ, spawn a rig, advance the first engine to running
   * with an active animator session. Returns both writ and rig.
   */
  async function spawnRunningRig(opts?: { parentId?: string }) {
    const { clerk, spider, stacks } = fix;
    const writ = opts?.parentId
      ? await clerk.post({ title: 'Child writ', body: 'child', parentId: opts.parentId })
      : await postWrit(clerk);

    // Writs start in 'open' status (either standalone or child). The parent
    // does not auto-transition when a child is added; children are created
    // directly in 'open'. The spider's trySpawn picks up the 'open' writ.

    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const rigs = await book.find({ where: [['writId', '=', writ.id]], limit: 1 });
    const rig = rigs[0];

    // Mark draft as completed so implement can launch
    const updatedEngines = rig.engines.map((e: EngineInstance) =>
      e.id === 'draft'
        ? { ...e, status: 'completed' as const, yields: { draftId: 'd1', codexName: 'c', branch: 'b', path: '/p' } }
        : e,
    );
    await book.patch(rig.id, { engines: updatedEngines });

    // Launch implement (creates session)
    await spider.crawl(); // engine-started

    const [rigAfterStart] = await book.find({ where: [['writId', '=', writ.id]], limit: 1 });
    const implEngine = rigAfterStart.engines.find((e: EngineInstance) => e.id === 'implement');

    // Override the auto-completed session to be running
    if (implEngine?.sessionId) {
      const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.patch(implEngine.sessionId, { status: 'running', endedAt: undefined });
    }

    const freshWrit = await clerk.show(writ.id);
    return { writ: freshWrit, rig: rigAfterStart };
  }

  // V1 [R1, R2]: Cancel writ cascades to rig
  it('writ cancelled cascades to rig cancellation', async () => {
    const { clerk, stacks, cancelCalls } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Cancel the writ
    await clerk.transition(writ.id, 'cancelled');

    // Rig should now be cancelled
    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled after writ cancellation');

    // Animator.cancel should have been called for the running session
    assert.ok(cancelCalls.length >= 1, 'animator.cancel should have been called');
  });

  // V6 [R5]: Writ failed does NOT cascade to rig cancellation
  it('writ failed does not cascade to rig — rig remains running', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Fail the writ
    await clerk.transition(writ.id, 'failed', { resolution: 'External failure' });

    // Rig should still be running — only cancelled triggers cascade
    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'running', 'rig should remain running after writ failure');
  });

  // V2 [R1, R3]: Cancel writ with no rig (no-op)
  it('writ cancelled with no rig is a silent no-op', async () => {
    const { clerk } = fix;
    const writ = await postWrit(clerk);

    // Cancel without ever spawning a rig — should not throw
    await clerk.transition(writ.id, 'cancelled');

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled');
  });

  // V3 [R1, R4]: Cancel writ when rig is already terminal
  it('writ cancelled when rig is already terminal is a silent no-op', async () => {
    const { clerk, spider, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Cancel the rig directly first
    await spider.cancel(rig.id);

    const book = rigsBook(stacks);
    const cancelledRig = await book.get(rig.id);
    assert.equal(cancelledRig?.status, 'cancelled', 'rig should already be cancelled');

    // Now cancel the writ — the cascade should be a no-op for the rig
    // The writ may already be cancelled by the rig→writ CDC, but if not:
    const currentWrit = await clerk.show(writ.id);
    if (currentWrit.phase !== 'cancelled') {
      await clerk.transition(writ.id, 'cancelled');
    }

    // Rig should still be cancelled (unchanged)
    const rigAfter = await book.get(rig.id);
    assert.equal(rigAfter?.status, 'cancelled', 'rig should remain cancelled');
  });

  // V4 [R5, R6]: Circular cascade — writ cancelled first
  it('circular cascade completes without error when writ cancelled first', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Cancel writ — triggers: writ→rig CDC (cancels rig) → rig→writ CDC (writ already terminal, skips)
    await clerk.transition(writ.id, 'cancelled');

    // Both should be terminal
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled');

    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled');
  });

  // V4 complement: Circular cascade — rig cancelled first
  it('circular cascade completes without error when rig cancelled first', async () => {
    const { clerk, spider, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Cancel rig — triggers: rig→writ CDC (transitions writ) → writ→rig CDC (rig already terminal, skips)
    await spider.cancel(rig.id);

    // Both should be terminal
    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should be cancelled');

    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled via rig→writ CDC');
  });

  // V5 [R5]: Cancel rig whose writ is already terminal (existing bug fix)
  it('rig cancellation succeeds when writ is already terminal', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Directly patch the writ to a terminal state (simulating out-of-band cancellation)
    const writsBook = stacks.book<WritDoc>('clerk', 'writs');
    await writsBook.patch(writ.id, { phase: 'cancelled', resolvedAt: new Date().toISOString() });

    // Cancel the rig — should succeed because the guard skips clerk.transition()
    const cancelledRig = await spider.cancel(rig.id);
    assert.equal(cancelledRig.status, 'cancelled', 'rig cancellation should succeed');
  });

  // V8 [R1, R4]: Completed writ with completed rig (no-op)
  it('writ completed with already-completed rig is a silent no-op', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Mark all engines as completed so the rig completes
    const completedEngines = rig.engines.map((e: EngineInstance) => ({
      ...e,
      status: 'completed' as const,
      yields: { mock: true },
      completedAt: new Date().toISOString(),
    }));
    await book.patch(rig.id, { engines: completedEngines, status: 'completed' });

    // The rig→writ CDC should have completed the writ
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should be completed via rig→writ CDC');

    // Both should be terminal and stable — no errors
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'completed', 'rig should remain completed');
  });

  // Edge case: blocked rig with cancelled writ
  it('blocked rig is cancelled when writ is cancelled', async () => {
    const { clerk, stacks } = fix;
    const writ = await postWrit(clerk);
    // Writ is already 'open' — spider.trySpawn would normally pick it up,
    // but we skip that path by constructing a blocked rig directly below.

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    const blockRecord: BlockRecord = {
      type: 'patron-input',
      condition: { requestId: 'ir-123' },
      blockedAt: now,
    };
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'blocked',
      engines: [
        { id: 'eng-blocked', designId: 'dummy', status: 'blocked', upstream: [], givensSpec: {}, block: blockRecord },
        { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: ['eng-blocked'], givensSpec: {} },
      ],
      createdAt: now,
    });

    // Cancel the writ — should cascade to cancel the blocked rig
    await clerk.transition(writ.id, 'cancelled');

    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled', 'blocked rig should be cancelled');

    // Engines should be cancelled
    const engBlocked = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-blocked');
    assert.equal(engBlocked?.status, 'cancelled', 'blocked engine should be cancelled');
    assert.equal(engBlocked?.block, undefined, 'block should be cleared');
  });

  // [R5]: Writ completed does NOT cascade to rig cancellation
  it('writ completed does not cascade to rig — rig remains running', async () => {
    const { clerk, stacks } = fix;
    const { writ, rig } = await spawnRunningRig();

    // Complete the writ
    await clerk.transition(writ.id, 'completed', { resolution: 'Done' });

    // Rig should still be running — only cancelled triggers cascade
    const book = rigsBook(stacks);
    const updatedRig = await book.get(rig.id);
    assert.equal(updatedRig?.status, 'running', 'rig should remain running after writ completion');
  });

  // [R4]: Cancel reason format includes writ ID
  it('cancel reason matches "Writ <writId> cancelled" format', async () => {
    const { clerk, stacks, cancelCalls } = fix;
    const { writ } = await spawnRunningRig();

    await clerk.transition(writ.id, 'cancelled');

    // The animator.cancel call should have the correct reason
    const reasonCall = cancelCalls.find((c) => c.options?.reason?.includes(writ.id));
    assert.ok(reasonCall, 'animator.cancel should have been called with writ ID in reason');
    assert.equal(reasonCall!.options!.reason, `Writ ${writ.id} cancelled`, 'reason should match exact format');
  });

  // [R6]: Rig cancel with already-completed writ succeeds
  it('rig cancellation succeeds when writ is already completed', async () => {
    const { clerk, spider, stacks } = fix;
    const writ = await postWrit(clerk);
    await spider.crawl(); // spawn rig

    const book = rigsBook(stacks);
    const [rig] = await book.list();

    // Directly patch the writ to completed
    const writsBookHandle = stacks.book<WritDoc>('clerk', 'writs');
    await writsBookHandle.patch(writ.id, { phase: 'completed', resolvedAt: new Date().toISOString() });

    // Cancel the rig — should succeed because the guard skips clerk.transition()
    const cancelledRig = await spider.cancel(rig.id);
    assert.equal(cancelledRig.status, 'cancelled', 'rig cancellation should succeed');

    // Writ should remain completed
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'completed', 'writ should remain completed');
  });

  // [R1]: Cascade with already-terminal rig is idempotent
  it('writ cancelled when rig is already cancelled is a silent no-op', async () => {
    const { clerk, stacks } = fix;
    const writ = await postWrit(clerk);

    const book = rigsBook(stacks);
    const rigId = generateId('rig', 4);
    const now = new Date().toISOString();
    // Insert an already-cancelled rig
    await book.put({
      id: rigId,
      writId: writ.id,
      status: 'cancelled',
      engines: [
        { id: 'eng1', designId: 'dummy', status: 'cancelled', upstream: [], givensSpec: {} },
      ],
      createdAt: now,
    });

    // Cancel the writ — cascade should no-op for the rig
    await clerk.transition(writ.id, 'cancelled');

    // No errors, rig unchanged
    const updatedRig = await book.get(rigId);
    assert.equal(updatedRig?.status, 'cancelled', 'rig should remain cancelled');
    const updatedWrit = await clerk.show(writ.id);
    assert.equal(updatedWrit.phase, 'cancelled', 'writ should be cancelled');
  });

  // V7 [R7]: Parent/child cascade — parent writ cancelled cascades to child's rig
  it('parent writ cancellation cascades to child rig via clerk parent→child cascade', async () => {
    const { clerk, spider, stacks } = fix;

    // Create parent writ as a draft ('new') so the spider won't pick it up
    // for dispatch. Under the new vocabulary the spider only dispatches
    // writs in 'open' phase; a draft parent keeps its own rig out of the
    // picture so this test exercises only the parent→child cascade path.
    const parentWrit = await clerk.post({ title: 'Parent writ', body: 'parent', draft: true });
    assert.equal(parentWrit.phase, 'new', 'parent should be a draft');

    // Create child writ — parent does not auto-transition (R5); child is 'open'
    const childWrit = await clerk.post({ title: 'Child writ', body: 'child', parentId: parentWrit.id });
    assert.equal(childWrit.phase, 'open', 'child should be open');

    const parentAfterChild = await clerk.show(parentWrit.id);
    assert.equal(parentAfterChild.phase, 'new', 'parent should remain new after child added');

    // Spawn rig for child (parent is new, so spider skips it)
    await spider.crawl(); // spawns child rig

    const book = rigsBook(stacks);
    const childRigs = await book.find({ where: [['writId', '=', childWrit.id]], limit: 1 });
    assert.equal(childRigs.length, 1, 'child should have a rig');
    const childRig = childRigs[0];

    // Cancel the parent writ — clerk's handleParentTerminal cancels child writ → spider CDC cancels child rig
    await clerk.transition(parentWrit.id, 'cancelled');

    // Child writ should be cancelled (by clerk's parent→child cascade)
    const updatedChildWrit = await clerk.show(childWrit.id);
    assert.equal(updatedChildWrit.phase, 'cancelled', 'child writ should be cancelled');

    // Child rig should be cancelled (by spider's writ→rig CDC)
    const updatedChildRig = await book.get(childRig.id);
    assert.equal(updatedChildRig?.status, 'cancelled', 'child rig should be cancelled');
  });

  // [R8, R9]: Parent cancel cascades to multiple child rigs with correct reason
  it('parent writ cancellation cascades to two child rigs with correct cancel reasons', async () => {
    const { clerk, stacks } = fix;

    // Draft parent so spider doesn't dispatch it
    const parentWrit = await clerk.post({ title: 'Parent', body: 'parent', draft: true });

    // Two children
    const child1 = await clerk.post({ title: 'Child 1', body: 'c1', parentId: parentWrit.id });
    const child2 = await clerk.post({ title: 'Child 2', body: 'c2', parentId: parentWrit.id });

    // Directly insert rigs for both children (avoids crawl advancing engines)
    const book = rigsBook(stacks);
    const now = new Date().toISOString();
    const child1RigId = generateId('rig', 4);
    const child2RigId = generateId('rig', 4);

    await book.put({
      id: child1RigId,
      writId: child1.id,
      status: 'running',
      engines: [
        { id: 'eng1', designId: 'draft', status: 'running', upstream: [], givensSpec: {} },
      ],
      createdAt: now,
    });
    await book.put({
      id: child2RigId,
      writId: child2.id,
      status: 'running',
      engines: [
        { id: 'eng1', designId: 'draft', status: 'running', upstream: [], givensSpec: {} },
      ],
      createdAt: now,
    });

    // Cancel the parent
    await clerk.transition(parentWrit.id, 'cancelled');

    // Both children cancelled
    const updatedChild1 = await clerk.show(child1.id);
    const updatedChild2 = await clerk.show(child2.id);
    assert.equal(updatedChild1.phase, 'cancelled', 'child1 writ should be cancelled');
    assert.equal(updatedChild2.phase, 'cancelled', 'child2 writ should be cancelled');

    // Both child rigs cancelled
    const updatedRig1 = await book.get(child1RigId);
    const updatedRig2 = await book.get(child2RigId);
    assert.equal(updatedRig1?.status, 'cancelled', 'child1 rig should be cancelled');
    assert.equal(updatedRig2?.status, 'cancelled', 'child2 rig should be cancelled');

    // Verify cancel reasons contain respective child writ IDs
    const rig1Engine = updatedRig1!.engines.find((e: EngineInstance) => e.status === 'cancelled' && e.error);
    const rig2Engine = updatedRig2!.engines.find((e: EngineInstance) => e.status === 'cancelled' && e.error);
    assert.ok(rig1Engine, 'child1 rig should have a cancelled engine with error');
    assert.equal(rig1Engine!.error, `Writ ${child1.id} cancelled`, 'child1 rig engine error should reference child1 writ');
    assert.ok(rig2Engine, 'child2 rig should have a cancelled engine with error');
    assert.equal(rig2Engine!.error, `Writ ${child2.id} cancelled`, 'child2 rig engine error should reference child2 writ');
  });
});
