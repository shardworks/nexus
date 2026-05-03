/**
 * Spider — engine blocking on external conditions.
 *
 * Engine-blocking machinery: registered block types (writ-phase,
 * scheduled-time, book-updated, patron-input), block-spec validation
 * (V1–V22), the checkBlocked walk step, and all R1–R29 spec
 * requirements for block / unblock transitions. Uses an in-file
 * `buildBlockingFixture` that gives Spider a real StartupContext with
 * kit-delivered block types.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider } from './spider.ts';
import type { SpiderApi, RigDoc, EngineInstance, RigTemplate, BlockType, CheckResult } from './types.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigResumeTool from './tools/rig-resume.ts';

import {
  latestAttempt,
  STANDARD_TEMPLATE,
  buildKitEntries,
  buildCtx,
  mergeCustomEnginesIntoSpider,
  assertTerminalAt,
} from './spider-test-fixture.ts';

// ── Engine / BlockType factories (in-file helpers) ────────────────────

const engineDone = (id: string, yields: Record<string, unknown> = {}): EngineDesign => ({
  id,
  async run() { return { status: 'completed', yields }; },
});

const engineBlocks = (
  id: string,
  blockType: string,
  condition: Record<string, unknown> = {},
  message?: string,
): EngineDesign => ({
  id,
  async run() {
    return { status: 'blocked', blockType, condition, ...(message ? { message } : {}) };
  },
});

/** Block on first run; complete on retry (when ctx.priorBlock is set). */
const engineUnblockOnPriorBlock = (
  id: string,
  blockType: string,
  condition: Record<string, unknown> = {},
  yields: Record<string, unknown> = {},
): EngineDesign => ({
  id,
  async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
    if (!ctx.priorBlock) return { status: 'blocked', blockType, condition };
    return { status: 'completed', yields };
  },
});

const holdPending = (
  id: string,
  schema: z.ZodTypeAny = z.object({}),
  opts: { pollIntervalMs?: number } = {},
): BlockType => ({
  id,
  conditionSchema: schema,
  ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
  async check(): Promise<CheckResult> { return { status: 'pending' }; },
});

const holdCleared = (id: string, schema: z.ZodTypeAny = z.object({})): BlockType => ({
  id,
  conditionSchema: schema,
  async check(): Promise<CheckResult> { return { status: 'cleared' }; },
});

const holdFailed = (id: string, reason?: string, schema: z.ZodTypeAny = z.object({})): BlockType => ({
  id,
  conditionSchema: schema,
  async check(): Promise<CheckResult> { return reason ? { status: 'failed', reason } : { status: 'failed' }; },
});

/** Single-engine template (the most common shape in this file). */
const soleTemplate = (designId: string, id = 'sole'): RigTemplate => ({
  engines: [{ id, designId, givens: {} }],
  resolutionEngine: id,
});

const findEng = (rig: { engines: EngineInstance[] }, id: string): EngineInstance => {
  const e = rig.engines.find((x) => x.id === id);
  assert.ok(e, `engine "${id}" not found`);
  return e!;
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('Spider — engine blocking on external conditions', () => {

  /**
   * Like buildFixture() but gives Spider a real StartupContext with
   * Wire-phase kit entries so block types and engines are delivered via
   * ctx.kits() during start().
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
      tryApparatus<T>(name: string): T | null {
        try { return this.apparatus<T>(name); } catch { return null; }
      },
      config<T>(_pluginId: string): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return fakeGuildConfig; },
      kits(): LoadedKit[] { return []; },
      apparatuses(): LoadedApparatus[] { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    // Splice test-supplied custom engines into Spider's supportKit so stub
    // engines overwrite matching built-ins instead of registering a second
    // kit contribution under the same id (which Fabricator rejects as a
    // kit-vs-kit collision).
    const spiderAsLoaded: LoadedApparatus = {
      packageName: '@shardworks/spider-apparatus',
      id: 'spider',
      version: '0.0.0',
      apparatus: mergeCustomEnginesIntoSpider(spiderApparatus, customEngines),
    };

    const customBlockTypeApparatuses: LoadedApparatus[] = [];
    if (customBlockTypes && customBlockTypes.length > 0) {
      const blockTypesRecord: Record<string, BlockType> = {};
      for (const bt of customBlockTypes) blockTypesRecord[bt.id] = bt;
      customBlockTypeApparatuses.push({
        packageName: '@test/custom-block-types',
        id: 'test-custom-block-types',
        version: '0.0.0',
        apparatus: { requires: [], supportKit: { blockTypes: blockTypesRecord }, provides: {}, start() {} },
      });
    }

    const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded]);
    const spiderKitEntries = buildKitEntries([], [spiderAsLoaded, ...customBlockTypeApparatuses]);

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
          id: sessionId, status: outcome.status, startedAt, endedAt, durationMs: 0, provider: 'mock',
          exitCode: outcome.status === 'completed' ? 0 : 1,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.output !== undefined ? { output: outcome.output } : {}),
          metadata: request.metadata,
        };
        void sessBook.put(doc);
        const result = Promise.resolve({ ...doc } as SessionResult);
        async function* emptyChunks(): AsyncIterable<SessionChunk> {}
        return { sessionId, chunks: emptyChunks(), result };
      },
      animate(): AnimateHandle { throw new Error('animate() not used in Spider tests'); },
      subscribeToSession(): AsyncIterable<SessionChunk> | null { return null; },
      async cancel(sessionId: string, options?: { reason?: string }): Promise<SessionDoc> {
        cancelCalls.push({ sessionId, options });
        const sessBook = stacks.book<SessionDoc>('animator', 'sessions');
        const session = await sessBook.get(sessionId);
        if (session) {
          const now = new Date().toISOString();
          await sessBook.patch(sessionId, {
            status: 'cancelled', endedAt: now,
            ...(options?.reason ? { error: options.reason } : {}),
          });
          return { ...session, status: 'cancelled', endedAt: now };
        }
        return { id: sessionId, status: 'cancelled', startedAt: '', endedAt: '', durationMs: 0, provider: 'mock', exitCode: 1 } as SessionDoc;
      },
    };
    apparatusMap.set('animator', mockAnimatorApi);

    clerkApparatus.start(noopCtx);
    const realClerk = clerkApparatus.provides as ClerkApi;

    // Auto-publish writs landing in `new` to `open` (mirrors buildFixture's wrapper).
    const clerk: ClerkApi = {
      ...realClerk,
      async post(request) {
        const writ = await realClerk.post(request);
        if (writ.phase === 'new') return realClerk.transition(writ.id, 'open');
        return writ;
      },
    };
    apparatusMap.set('clerk', clerk);

    const { ctx: fabricatorCtx, fire: fireFabricator } = buildCtx(fabricatorKitEntries);
    const { ctx: spiderCtx } = buildCtx(spiderKitEntries);

    fabricatorApparatus.start(fabricatorCtx);
    apparatusMap.set('fabricator', fabricatorApparatus.provides as FabricatorApi);

    spiderApparatus.start(spiderCtx);
    apparatusMap.set('spider', spiderApparatus.provides as SpiderApi);

    return {
      stacks,
      clerk,
      fabricator: fabricatorApparatus.provides as FabricatorApi,
      spider: spiderApparatus.provides as SpiderApi,
      memBackend,
      fire: fireFabricator,
      summonCalls,
      setSessionOutcome(outcome) { currentSessionOutcome = outcome; },
    };
  }

  afterEach(() => { clearGuild(); });

  describe('Crawl phase ordering: checkBlocked before run (R4)', () => {
    it('held engine is cleared and dispatched before an independent pending engine runs', async () => {
      // Engine A is held; its checker immediately clears the hold.
      // Engine B is independent (no upstream). When both opportunities
      // exist simultaneously, the hold-clearing phase must run before
      // spawn/run so A's clear is taken first.
      const fix = buildBlockingFixture(
        {
          'phase-a-engine': engineUnblockOnPriorBlock('phase-a-engine', 'phase-hold', { go: false }),
          'phase-b-engine': engineDone('phase-b-engine'),
        },
        {
          engines: [
            { id: 'a', designId: 'phase-a-engine', givens: {} },
            { id: 'b', designId: 'phase-b-engine', givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [holdCleared('phase-hold', z.object({ go: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Ordering Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      // crawl picks the first pending engine (a is first in the list).
      const runResult = await fix.spider.crawl();
      assert.ok(runResult !== null);
      assert.equal(runResult.action, 'engine-held');
      assert.equal((runResult as { engineId: string }).engineId, 'a');

      // Next crawl clears a's hold; in the same crawl tryRun feeds priorBlock and the engine completes.
      const nextResult = await fix.spider.crawl();
      assert.ok(nextResult !== null);
      assert.ok(
        (nextResult.action === 'engine-completed' || nextResult.action === 'engine-started')
          && (nextResult as { engineId: string }).engineId === 'a',
        `expected engine-completed/started for 'a', got: ${nextResult.action} for ${(nextResult as { engineId: string }).engineId}`,
      );
    });
  });

  describe('Block type registry', () => {
    it('getBlockType returns the four built-in block types after startup (V3, R6)', () => {
      const { spider } = buildBlockingFixture();
      assert.ok(spider.getBlockType('writ-phase') !== undefined);
      assert.ok(spider.getBlockType('scheduled-time') !== undefined);
      assert.ok(spider.getBlockType('book-updated') !== undefined);
      assert.ok(spider.getBlockType('patron-input') !== undefined);
    });

    it('getBlockType returns undefined for an unknown block type id (R6)', () => {
      assert.equal(buildBlockingFixture().spider.getBlockType('nonexistent'), undefined);
    });

    it('registers a custom block type contributed via Wire-phase kit entry (R5)', () => {
      const { spider } = buildBlockingFixture({}, undefined, [holdPending('my-custom-type', z.object({ key: z.string() }))]);
      assert.ok(spider.getBlockType('my-custom-type') !== undefined);
    });

    it('listBlockTypes returns all built-in block types with correct info', () => {
      const { spider } = buildBlockingFixture();
      const result = spider.listBlockTypes();
      assert.ok(Array.isArray(result));

      const ids = result.map((bt) => bt.id);
      for (const id of ['writ-phase', 'scheduled-time', 'book-updated', 'patron-input']) {
        assert.ok(ids.includes(id), `${id} should be in list`);
      }

      const writStatus = result.find((bt) => bt.id === 'writ-phase')!;
      assert.equal(typeof writStatus.pluginId, 'string');
      assert.equal(writStatus.pollIntervalMs, 10_000);

      const scheduledTime = result.find((bt) => bt.id === 'scheduled-time')!;
      assert.equal(scheduledTime.pollIntervalMs, 30_000);
    });

    it('listBlockTypes includes custom block type registered via Wire-phase kit entry', () => {
      const custom = holdPending('my-custom-type', z.object({ key: z.string() }), { pollIntervalMs: 5000 });
      const { spider } = buildBlockingFixture({}, undefined, [custom]);

      const found = spider.listBlockTypes().find((bt) => bt.id === 'my-custom-type');
      assert.ok(found);
      assert.equal(found.pollIntervalMs, 5000);
    });

    it('listBlockTypes block type without pollIntervalMs has undefined pollIntervalMs', () => {
      const { spider } = buildBlockingFixture({}, undefined, [holdPending('no-poll-type')]);
      const found = spider.listBlockTypes().find((bt) => bt.id === 'no-poll-type');
      assert.ok(found);
      assert.equal(found.pollIntervalMs, undefined);
    });

    it('throws when two kits contribute the same block-type id (kit-vs-kit collision is fatal)', () => {
      // Two independent apparatuses both contribute a block type with id
      // 'conflict-block'. With the fail-loud kit-vs-kit rule, this must
      // refuse to start — silent last-wins would leave operators unable
      // to predict which checker implementation runs.
      const blockTypeA = holdPending('conflict-block');
      const blockTypeB = holdCleared('conflict-block');

      const memBackend = new MemoryBackend();
      const stacksPlugin = createStacksApparatus(memBackend);
      const clerkPlugin = createClerk();
      const fabricatorPlugin = createFabricator();
      const spiderPlugin = createSpider();

      if (
        !('apparatus' in stacksPlugin) ||
        !('apparatus' in clerkPlugin) ||
        !('apparatus' in fabricatorPlugin) ||
        !('apparatus' in spiderPlugin)
      ) {
        throw new Error('plugins must be apparatuses');
      }

      const apparatusMap = new Map<string, unknown>();
      const fakeGuildConfig: GuildConfig = {
        name: 'test-guild', nexus: '0.0.0', plugins: [],
        spider: { rigTemplates: { default: STANDARD_TEMPLATE }, rigTemplateMappings: { mandate: 'default' } },
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
        config<T>(_pluginId: string): T { return {} as T; },
        writeConfig() {},
        guildConfig() { return fakeGuildConfig; },
        kits(): LoadedKit[] { return []; },
        apparatuses(): LoadedApparatus[] { return []; },
        startupWarnings() { return []; },
      };
      setGuild(fakeGuild);

      const spiderAsLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus', id: 'spider', version: '0.0.0',
        apparatus: spiderPlugin.apparatus,
      };
      const kitA: LoadedApparatus = {
        packageName: '@test/kit-a-blocks', id: 'kit-a-blocks', version: '0.0.0',
        apparatus: { requires: [], supportKit: { blockTypes: { conflict: blockTypeA } }, provides: {}, start() {} },
      };
      const kitB: LoadedApparatus = {
        packageName: '@test/kit-b-blocks', id: 'kit-b-blocks', version: '0.0.0',
        apparatus: { requires: [], supportKit: { blockTypes: { conflict: blockTypeB } }, provides: {}, start() {} },
      };

      const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded]);
      const spiderKitEntries = buildKitEntries([], [spiderAsLoaded, kitA, kitB]);

      const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
      stacksPlugin.apparatus.start(noopCtx);
      apparatusMap.set('stacks', stacksPlugin.apparatus.provides);

      memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, { indexes: ['phase', 'type', 'createdAt', 'parentId'] });
      memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, { indexes: ['sourceId', 'targetId', 'label'] });
      memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, { indexes: ['status', 'writId', 'createdAt'] });

      const { ctx: clerkCtx } = buildCtx(spiderKitEntries);
      void clerkPlugin.apparatus.start(clerkCtx);
      apparatusMap.set('clerk', clerkPlugin.apparatus.provides);

      const { ctx: fabricatorCtx } = buildCtx(fabricatorKitEntries);
      fabricatorPlugin.apparatus.start(fabricatorCtx);
      apparatusMap.set('fabricator', fabricatorPlugin.apparatus.provides);

      apparatusMap.set('animator', {});

      const { ctx: spiderCtx } = buildCtx(spiderKitEntries);
      assert.throws(
        () => spiderPlugin.apparatus.start(spiderCtx),
        (err: Error) =>
          /blockTypes/.test(err.message)
          && /conflict-block/.test(err.message)
          && /kit-a-blocks/.test(err.message)
          && /kit-b-blocks/.test(err.message),
      );
    });
  });

  describe('Engine blocked result → pending+hold metadata (V1, V2)', () => {
    it('transitions engine to pending+hold and persists hold metadata', async () => {
      const fix = buildBlockingFixture(
        { 'blk-engine': engineBlocks('blk-engine', 'test-block', { x: 1 }, 'waiting') },
        soleTemplate('blk-engine'),
        [holdPending('test-block', z.object({ x: z.number() }))],
      );

      await fix.clerk.post({ title: 'Blocking writ', body: 'Wait' });
      await fix.spider.crawl();

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { holdReason: string }).holdReason, 'test-block');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      const engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'pending');
      assert.equal(engine.holdReason, 'test-block');
      assert.deepEqual(engine.holdCondition, { x: 1 });
    });
  });

  describe('Unregistered block type → immediate engine failure (V19, R26)', () => {
    it('fails engine with "Unknown block type" when blockType is not registered', async () => {
      const fix = buildBlockingFixture(
        { 'bad-blk-engine': engineBlocks('bad-blk-engine', 'does-not-exist') },
        soleTemplate('bad-blk-engine'),
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      const result = await fix.spider.crawl();

      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const error = latestAttempt(findEng(rig, 'sole'))?.error;
      assert.ok(error?.includes('Unknown block type'), `got: ${error}`);
      assert.ok(error?.includes('does-not-exist'), `got: ${error}`);
    });
  });

  describe('Zod validation failure → immediate engine failure (V20, R27)', () => {
    it('fails engine with Zod error details when condition shape is wrong', async () => {
      const fix = buildBlockingFixture(
        { 'bad-cond-engine': engineBlocks('bad-cond-engine', 'strict-type', { wrong: 123 }) },
        soleTemplate('bad-cond-engine'),
        [holdPending('strict-type', z.object({ required: z.string() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      const result = await fix.spider.crawl();

      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      const error = latestAttempt(findEng(rig, 'sole'))?.error;
      assert.ok(error?.includes('Block type "strict-type" rejected condition'), `got: ${error}`);
    });
  });

  describe('CrawlResult variants (R15)', () => {
    it('returns engine-held when engine blocks; rig stays running even when no other progress is possible (V8, V10)', async () => {
      // Engine A blocks; Engine B depends on A. Rig stays `running` —
      // held engines do not terminally fail the rig.
      const fix = buildBlockingFixture(
        {
          'dep-blocking-a': engineBlocks('dep-blocking-a', 'dep-hold', { w: true }),
          'dep-dependent-b': engineDone('dep-dependent-b'),
        },
        {
          engines: [
            { id: 'a', designId: 'dep-blocking-a', givens: {} },
            { id: 'b', designId: 'dep-dependent-b', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [holdPending('dep-hold', z.object({ w: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      const result = await fix.spider.crawl();

      assert.ok(result !== null);
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { holdReason: string }).holdReason, 'dep-hold');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      const engineA = findEng(rig, 'a');
      assert.equal(engineA.status, 'pending');
      assert.equal(engineA.holdReason, 'dep-hold');
    });

    it('returns engine-held when engine blocks and rig has other runnable engines (V11)', async () => {
      // Two independent engines. A blocks first; B is still pending and
      // runnable. engine-held returned; rig stays running.
      const fix = buildBlockingFixture(
        {
          'indep-blocking-a': engineBlocks('indep-blocking-a', 'indep-hold', { w: true }),
          'indep-passing-b': engineDone('indep-passing-b'),
        },
        {
          engines: [
            { id: 'a', designId: 'indep-blocking-a', givens: {} },
            { id: 'b', designId: 'indep-passing-b', givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [holdPending('indep-hold', z.object({ w: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      const result = await fix.spider.crawl();

      assert.ok(result !== null);
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { engineId: string }).engineId, 'a');
      assert.equal((result as { holdReason: string }).holdReason, 'indep-hold');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
    });

    it('returns engine-completed (or engine-started) when checker clears hold (R9)', async () => {
      const fix = buildBlockingFixture(
        { 'ctrl-engine': engineUnblockOnPriorBlock('ctrl-engine', 'ctrl-block', { go: false }) },
        soleTemplate('ctrl-engine'),
        [holdCleared('ctrl-block', z.object({ go: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const unblock = await fix.spider.crawl();
      assert.ok(unblock !== null);
      assert.ok(
        unblock.action === 'engine-completed' || unblock.action === 'engine-started' || unblock.action === 'rig-completed',
        `got: ${unblock.action}`,
      );
    });
  });

  describe('lastCheckedAt persisted when checker returns pending (V6, R10)', () => {
    it('sets engine.lastCheckedAt after checker returns pending', async () => {
      const fix = buildBlockingFixture(
        { 'nc-engine': engineBlocks('nc-engine', 'nc-block', { val: 'x' }) },
        soleTemplate('nc-engine'),
        [holdPending('nc-block', z.object({ val: z.string() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      let [rig] = await fix.spider.list();
      assert.equal(findEng(rig, 'sole').lastCheckedAt, undefined);

      await fix.spider.crawl();
      [rig] = await fix.spider.list();
      const engine = findEng(rig, 'sole');
      assert.ok(typeof engine.lastCheckedAt === 'string' && engine.lastCheckedAt.length > 0);
    });
  });

  describe('Checker clears hold → engine dispatches with priorBlock (V5, R9)', () => {
    it('engine completes and hold metadata is cleared when checker clears', async () => {
      let checkerResult: CheckResult = { status: 'pending' };
      const ctrlBlock: BlockType = {
        id: 'ctrl2-block',
        conditionSchema: z.object({ key: z.string() }),
        async check(): Promise<CheckResult> { return checkerResult; },
      };
      const fix = buildBlockingFixture(
        { 'ctrl2-engine': engineUnblockOnPriorBlock('ctrl2-engine', 'ctrl2-block', { key: 'v' }, { done: true }) },
        soleTemplate('ctrl2-engine'),
        [ctrlBlock],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      // Crawl with checker still pending → engine stays held.
      await fix.spider.crawl();
      let [rig] = await fix.spider.list();
      let engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'pending');
      assert.equal(engine.holdReason, 'ctrl2-block');

      // Flip checker to cleared → next crawl clears hold and re-dispatches.
      checkerResult = { status: 'cleared' };
      const after = await fix.spider.crawl();
      assert.ok(after !== null);
      assert.equal(after.action, 'rig-completed');
      assert.equal((after as { outcome: string }).outcome, 'completed');

      [rig] = await fix.spider.list();
      engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'completed');
      assert.equal(engine.holdReason, undefined);
      assert.equal(engine.holdCondition, undefined);
    });
  });

  describe('Checker throws → engine stays held (V7, R11)', () => {
    it('engine remains in pending+hold and is not failed when checker throws', async () => {
      const throwBlock: BlockType = {
        id: 'throw-block',
        conditionSchema: z.object({ v: z.number() }),
        async check() { throw new Error('network error'); },
      };
      const fix = buildBlockingFixture(
        { 'throw-engine': engineBlocks('throw-engine', 'throw-block', { v: 1 }) },
        soleTemplate('throw-engine'),
        [throwBlock],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      const engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'pending');
      assert.equal(engine.holdReason, 'throw-block');
      assert.equal(rig.status, 'running');
    });
  });

  describe('Poll interval respected (V4, R8)', () => {
    it('skips checker within pollIntervalMs, runs it after interval elapsed', async () => {
      let checkCallCount = 0;
      const polledBlock: BlockType = {
        id: 'polled-block',
        conditionSchema: z.object({ w: z.boolean() }),
        pollIntervalMs: 60_000,
        async check(): Promise<CheckResult> { checkCallCount++; return { status: 'pending' }; },
      };
      const fix = buildBlockingFixture(
        { 'polled-engine': engineBlocks('polled-engine', 'polled-block', { w: true }) },
        soleTemplate('polled-engine'),
        [polledBlock],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      // First checkBlocked crawl: no lastCheckedAt → checker IS called.
      await fix.spider.crawl();
      assert.equal(checkCallCount, 1);

      // Second crawl immediately: lastCheckedAt set, pollIntervalMs not elapsed → skipped.
      await fix.spider.crawl();
      assert.equal(checkCallCount, 1);

      // Manually rewind lastCheckedAt to 61s ago to simulate elapsed interval.
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const [rig] = await book.list();
      const pastTime = new Date(Date.now() - 61_000).toISOString();
      await book.patch(rig.id, {
        engines: rig.engines.map((e) => e.id === 'sole' ? { ...e, lastCheckedAt: pastTime } : e),
      });

      await fix.spider.crawl();
      assert.equal(checkCallCount, 2);
    });
  });

  describe('Rig stays running while engine is held, hold metadata clears when released (V9, R14)', () => {
    it('rig stays running throughout hold; engine dispatches with cleared hold after checker clears', async () => {
      let shouldClear = false;
      const clearableBlock: BlockType = {
        id: 'clearable-block',
        conditionSchema: z.object({ go: z.boolean() }),
        async check(): Promise<CheckResult> { return shouldClear ? { status: 'cleared' } : { status: 'pending' }; },
      };
      const fix = buildBlockingFixture(
        {
          'clearable-engine': engineUnblockOnPriorBlock('clearable-engine', 'clearable-block', { go: false }),
          'clearable-dep-engine': engineDone('clearable-dep-engine'),
        },
        {
          engines: [
            { id: 'a', designId: 'clearable-engine', givens: {} },
            { id: 'b', designId: 'clearable-dep-engine', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [clearableBlock],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      let engineA = findEng(rig, 'a');
      assert.equal(engineA.status, 'pending');
      assert.equal(engineA.holdReason, 'clearable-block');

      shouldClear = true;
      const after = await fix.spider.crawl();
      assert.ok(
        after?.action === 'engine-completed' || after?.action === 'engine-started',
        `got: ${after?.action}`,
      );

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      engineA = findEng(rig, 'a');
      assert.equal(engineA.status, 'completed');
      assert.equal(engineA.holdReason, undefined);
    });
  });

  describe('resume() API (V12, R16, R17)', () => {
    it('clears hold manually: hold metadata removed, engine is dispatched on next crawl', async () => {
      const fix = buildBlockingFixture(
        { 'hold-engine': engineUnblockOnPriorBlock('hold-engine', 'hold-block', { hold: true }, { resumed: true }) },
        soleTemplate('hold-engine'),
        [holdPending('hold-block', z.object({ hold: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      const before = findEng(rig, 'sole');
      assert.equal(before.status, 'pending');
      assert.equal(before.holdReason, 'hold-block');

      await fix.spider.resume(rig.id, 'sole');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      const after = findEng(rig, 'sole');
      assert.equal(after.status, 'pending');
      assert.equal(after.holdReason, undefined);
      assert.equal(after.holdCondition, undefined);
    });

    it('throws when engine has no hold (V12)', async () => {
      const fix = buildBlockingFixture();
      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      const pendingEngine = rig.engines.find((e) => e.status === 'pending');
      assert.ok(pendingEngine !== undefined);

      await assert.rejects(
        () => fix.spider.resume(rig.id, pendingEngine!.id),
        (err: Error) => {
          assert.ok(err.message.includes('no hold'), `got: ${err.message}`);
          return true;
        },
      );
    });
  });

  describe('Prior block context on restart (V5, R20)', () => {
    it('priorBlock is passed to engine context on restart after hold clears', async () => {
      let callCount = 0;
      let capturedPriorBlock: unknown = undefined;

      const priorCapture: EngineDesign = {
        id: 'prior-capture-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          callCount++;
          capturedPriorBlock = ctx.priorBlock;
          if (callCount === 1) return { status: 'blocked', blockType: 'prior-block', condition: { val: 'test' } };
          return { status: 'completed', yields: { done: true } };
        },
      };
      const fix = buildBlockingFixture(
        { 'prior-capture-engine': priorCapture },
        soleTemplate('prior-capture-engine'),
        [holdCleared('prior-block', z.object({ val: z.string() }))],
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      assert.equal(callCount, 1);
      assert.equal(capturedPriorBlock, undefined);

      await fix.spider.crawl();

      assert.equal(callCount, 2);
      assert.ok(capturedPriorBlock !== undefined);
      const prior = capturedPriorBlock as { type: string; condition: unknown; blockedAt: string };
      assert.equal(prior.type, 'prior-block');
      assert.deepEqual(prior.condition, { val: 'test' });
      assert.ok(typeof prior.blockedAt === 'string' && prior.blockedAt.length > 0);
    });

    it('priorBlock is undefined when engine has never been held', async () => {
      let captured: unknown = 'not-set';
      const simpleEngine: EngineDesign = {
        id: 'simple-noblk-engine',
        async run(_g: Record<string, unknown>, ctx: EngineRunContext) {
          captured = ctx.priorBlock;
          return { status: 'completed', yields: {} };
        },
      };
      const fix = buildBlockingFixture(
        { 'simple-noblk-engine': simpleEngine },
        soleTemplate('simple-noblk-engine'),
      );

      await fix.clerk.post({ title: 'Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      assert.equal(captured, undefined);
    });
  });

  describe('failEngine cancels held engines alongside plain pending ones (V15, R21)', () => {
    it('held engines are cancelled (with hold metadata cleared) when rig fails', async () => {
      const fix = buildBlockingFixture();

      const writ = await fix.clerk.post({ title: 'Fail test writ', body: 'Body' });

      // Directly insert a rig with one held engine, one plain pending engine,
      // and one running engine that will fail via its session.
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const rigId = generateId('rig', 4);
      const now = new Date().toISOString();
      const fakeSessionId = generateId('ses', 4);
      await book.put({
        id: rigId,
        writId: writ.id,
        status: 'running',
        engines: [
          {
            id: 'eng-held', designId: 'dummy', status: 'pending', upstream: [], givensSpec: {},
            holdReason: 'some-block', holdCondition: { x: 1 }, lastCheckedAt: now,
          },
          { id: 'eng-pending', designId: 'dummy', status: 'pending', upstream: [], givensSpec: {} },
          {
            id: 'eng-running', designId: 'dummy', status: 'running', upstream: [], givensSpec: {},
            attempts: [{ startedAt: now, sessionId: fakeSessionId }],
          },
        ],
        createdAt: now,
      });

      const sessBook = fix.stacks.book<SessionDoc>('animator', 'sessions');
      await sessBook.put({
        id: fakeSessionId, status: 'failed', startedAt: now, endedAt: now, durationMs: 0,
        provider: 'test', exitCode: 1, error: 'intentional failure', metadata: {},
      });

      await fix.spider.crawl();

      const updatedRig = await book.get(rigId);
      assert.ok(updatedRig !== null);
      assert.equal(updatedRig!.status, 'failed');
      assertTerminalAt(updatedRig);

      const engHeld = findEng(updatedRig!, 'eng-held');
      const engPending = findEng(updatedRig!, 'eng-pending');
      const engRunning = findEng(updatedRig!, 'eng-running');

      assert.equal(engHeld.status, 'cancelled');
      assert.equal(engHeld.holdReason, undefined);
      assert.equal(engHeld.holdCondition, undefined);
      assert.equal(engPending.status, 'cancelled');
      assert.equal(engRunning.status, 'failed');
    });
  });

  describe('CDC handler does not fire while rig is running with a held engine (V22, R29)', () => {
    it('writ remains open when rig has a held engine — rig stays running, CDC sees no terminal transition', async () => {
      const fix = buildBlockingFixture(
        { 'cdc-blk-engine': engineUnblockOnPriorBlock('cdc-blk-engine', 'cdc-hold', { w: true }) },
        soleTemplate('cdc-blk-engine'),
        [holdPending('cdc-hold', z.object({ w: z.boolean() }))],
      );

      const writ = await fix.clerk.post({ title: 'CDC Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      const sole = findEng(rig, 'sole');
      assert.equal(sole.status, 'pending');
      assert.equal(sole.holdReason, 'cdc-hold');

      const currentWrit = await fix.clerk.show(writ.id);
      assert.equal(currentWrit.phase, 'open');
    });
  });

  describe('rig-list — blocked status filter (V13, R18)', () => {
    it('returns blocked rigs when filtering by blocked status', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      const rigId = generateId('rig', 4);
      await book.put({ id: rigId, writId: generateId('wrt', 4), status: 'blocked', engines: [], createdAt: new Date().toISOString() });

      const blocked = await fix.spider.list({ status: 'blocked' });
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0].id, rigId);
      assert.equal(blocked[0].status, 'blocked');
    });

    it('does not return blocked rig when filtering by running status', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      await book.put({ id: generateId('rig', 4), writId: generateId('wrt', 4), status: 'blocked', engines: [], createdAt: new Date().toISOString() });

      const running = await fix.spider.list({ status: 'running' });
      assert.equal(running.length, 0);
    });

    it('rig-list tool accepts "blocked" as a valid status parameter', async () => {
      const fix = buildBlockingFixture();
      const book = fix.stacks.book<RigDoc>('spider', 'rigs');
      await book.put({ id: generateId('rig', 4), writId: generateId('wrt', 4), status: 'blocked', engines: [], createdAt: new Date().toISOString() });

      const result = await rigListTool.handler({ status: 'blocked' }) as RigDoc[];
      assert.equal(result.length, 1);
      assert.equal(result[0].status, 'blocked');
    });
  });

  describe('rig-resume tool — handler delegation (R16)', () => {
    it('handler calls spider.resume() and returns { ok: true } when engine is held', async () => {
      const fix = buildBlockingFixture(
        { 'hold2-engine': engineUnblockOnPriorBlock('hold2-engine', 'hold2-block', { hold: true }) },
        soleTemplate('hold2-engine'),
        [holdPending('hold2-block', z.object({ hold: z.boolean() }))],
      );

      await fix.clerk.post({ title: 'Resume Tool Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      assert.equal(findEng(rig, 'sole').holdReason, 'hold2-block');

      const result = await rigResumeTool.handler({ rigId: rig.id, engineId: 'sole' });
      assert.deepEqual(result, { ok: true });

      const [updatedRig] = await fix.spider.list();
      assert.equal(updatedRig.status, 'running');
      const engine = findEng(updatedRig, 'sole');
      assert.equal(engine.status, 'pending');
      assert.equal(engine.holdReason, undefined);
    });

    it('handler propagates error when engine has no hold', async () => {
      const fix = buildBlockingFixture();
      await fix.clerk.post({ title: 'Resume Error Writ', body: 'Body' });
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      const pendingEngine = rig.engines.find((e) => e.status === 'pending');
      assert.ok(pendingEngine !== undefined);

      await assert.rejects(
        () => rigResumeTool.handler({ rigId: rig.id, engineId: pendingEngine!.id }),
        (err: Error) => {
          assert.ok(err.message.includes('no hold'), `got: ${err.message}`);
          return true;
        },
      );
    });
  });

  describe('rig-show instructions mention hold metadata (R19)', () => {
    it('instructions text contains hold-state references', () => {
      const instructions = rigShowTool.instructions ?? '';
      assert.ok(instructions.toLowerCase().includes('hold'), `got: "${instructions}"`);
      assert.ok(
        instructions.includes('holdReason') || instructions.includes('holdUntil') || instructions.includes('lastCheckedAt'),
        `got: "${instructions}"`,
      );
    });
  });

  describe('BlockType re-exported from spider index (R28)', () => {
    it('BlockType type is exported from the package index', async () => {
      const idx = await import('./index.ts');
      // BlockType is a type-only export; confirm the module loaded by
      // asserting the default export is a spider apparatus plugin.
      assert.ok(idx !== null && typeof idx === 'object');
      assert.ok('default' in idx);
      const plugin = idx.default as unknown;
      assert.ok(typeof plugin === 'object' && plugin !== null);
      assert.ok('apparatus' in (plugin as object));
    });
  });

  describe('Checker failure path — permanent hold failure', () => {
    it('checker returns { status: "failed" } with no reason — engine failed, rig failed permanently', async () => {
      const fix = buildBlockingFixture(
        { 'fail-engine': engineBlocks('fail-engine', 'perm-fail-block') },
        soleTemplate('fail-engine'),
        [holdFailed('perm-fail-block')],
      );

      await fix.clerk.post({ title: 'Failing Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'failed');
      const error = latestAttempt(engine)?.error;
      assert.ok(error?.includes('failed permanently'), `got: ${error}`);
      assert.ok(error?.includes('perm-fail-block'), `got: ${error}`);
    });

    it('checker returns { status: "failed", reason: "resource deleted" } — error includes reason', async () => {
      const fix = buildBlockingFixture(
        { 'fail-reason-engine': engineBlocks('fail-reason-engine', 'reason-fail-block') },
        soleTemplate('fail-reason-engine'),
        [holdFailed('reason-fail-block', 'resource deleted')],
      );

      await fix.clerk.post({ title: 'Reason Fail Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      const error = latestAttempt(findEng(rig, 'sole'))?.error;
      assert.ok(error?.includes('failed: resource deleted'), `got: ${error}`);
    });

    it('checker failure with multiple engines — sibling cancelled', async () => {
      const fix = buildBlockingFixture(
        {
          'sib-blocking-a': engineBlocks('sib-blocking-a', 'sib-fail-block'),
          'sib-dependent-b': engineDone('sib-dependent-b'),
        },
        {
          engines: [
            { id: 'a', designId: 'sib-blocking-a', givens: {} },
            { id: 'b', designId: 'sib-dependent-b', upstream: ['a'], givens: {} },
          ],
          resolutionEngine: 'b',
        },
        [holdFailed('sib-fail-block')],
      );

      await fix.clerk.post({ title: 'Sibling Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      assert.equal(findEng(rig, 'a').status, 'failed');
      assert.equal(findEng(rig, 'b').status, 'cancelled');
    });

    it('checker failure does not update lastCheckedAt (R8)', async () => {
      const fix = buildBlockingFixture(
        { 'no-lc-engine': engineBlocks('no-lc-engine', 'no-lc-block') },
        soleTemplate('no-lc-engine'),
        [holdFailed('no-lc-block')],
      );

      await fix.clerk.post({ title: 'No LC Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      let [rig] = await fix.spider.list();
      assert.equal(findEng(rig, 'sole').lastCheckedAt, undefined);

      await fix.spider.crawl();

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const engine = findEng(rig, 'sole');
      assert.equal(engine.status, 'failed');
      assert.equal(engine.holdReason, undefined);
    });

    it('checker failure on held engine — rig transitions to failed', async () => {
      const fix = buildBlockingFixture(
        { 'btf-engine': engineBlocks('btf-engine', 'btf-block') },
        soleTemplate('btf-engine'),
        [holdFailed('btf-block', 'gone')],
      );

      await fix.clerk.post({ title: 'BTF Writ', body: 'Body' });
      await fix.spider.crawl();
      await fix.spider.crawl();

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      assert.equal(findEng(rig, 'sole').holdReason, 'btf-block');

      const result = await fix.spider.crawl();
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const error = latestAttempt(findEng(rig, 'sole'))?.error;
      assert.ok(error?.includes('gone'), `got: ${error}`);
    });
  });

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
      assert.deepEqual(result, { status: 'cleared' });
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
      // writ starts at 'open' — neither completed nor terminal-mismatch.

      const blockType = fix.spider.getBlockType('writ-phase');
      assert.ok(blockType !== undefined);

      const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
      assert.deepEqual(result, { status: 'pending' });
    });
  });

  describe('Built-in block types', () => {

    describe('writ-phase block type (R23, V16)', () => {
      it('checker returns pending when writ is not at target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });

        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'pending' });
      });

      it('checker returns cleared when writ reaches target status', async () => {
        const fix = buildBlockingFixture();
        const writ = await fix.clerk.post({ title: 'Writ', body: 'Body' });
        await fix.clerk.transition(writ.id, 'completed', { resolution: 'done' });

        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: writ.id, targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'cleared' });
      });

      it('checker returns failed when writ does not exist', async () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ writId: 'nonexistent-writ-99', targetPhase: 'completed' });
        assert.deepEqual(result, { status: 'failed', reason: 'Writ not found' });
      });

      it('writ-phase has pollIntervalMs of 10000 (R23)', () => {
        const fix = buildBlockingFixture();
        const blockType = fix.spider.getBlockType('writ-phase');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 10_000);
      });
    });

    describe('scheduled-time block type (R24, V17)', () => {
      it('checker returns pending for a future timestamp', async () => {
        const blockType = buildBlockingFixture().spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);

        const futureTime = new Date(Date.now() + 3_600_000).toISOString();
        const result = await blockType.check({ resumeAt: futureTime });
        assert.deepEqual(result, { status: 'pending' });
      });

      it('checker returns cleared for a past timestamp', async () => {
        const blockType = buildBlockingFixture().spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);

        const pastTime = new Date(Date.now() - 3_600_000).toISOString();
        const result = await blockType.check({ resumeAt: pastTime });
        assert.deepEqual(result, { status: 'cleared' });
      });

      it('scheduled-time has pollIntervalMs of 30000 (R24)', () => {
        const blockType = buildBlockingFixture().spider.getBlockType('scheduled-time');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 30_000);
      });
    });

    describe('book-updated block type (R25, V18)', () => {
      it('checker returns pending when book is empty', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'empty-data' }, {});

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'empty-data' });
        assert.deepEqual(result, { status: 'pending' });
      });

      it('checker returns cleared when book has at least one document', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'nonempty-data' }, {});
        const book = fix.stacks.book<{ id: string; value: string }>('test-owner', 'nonempty-data');
        await book.put({ id: 'doc-1', value: 'hello' });

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'nonempty-data' });
        assert.deepEqual(result, { status: 'cleared' });
      });

      it('checker returns pending when specific documentId is not found', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'doc-data' }, {});

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'doc-data', documentId: 'nonexistent-doc' });
        assert.deepEqual(result, { status: 'pending' });
      });

      it('checker returns cleared when specific documentId is found', async () => {
        const fix = buildBlockingFixture();
        fix.memBackend.ensureBook({ ownerId: 'test-owner', book: 'doc-data-2' }, {});
        const book = fix.stacks.book<{ id: string; content: string }>('test-owner', 'doc-data-2');
        await book.put({ id: 'target-doc', content: 'data' });

        const blockType = fix.spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);

        const result = await blockType.check({ ownerId: 'test-owner', book: 'doc-data-2', documentId: 'target-doc' });
        assert.deepEqual(result, { status: 'cleared' });
      });

      it('book-updated has pollIntervalMs of 10000 (R25)', () => {
        const blockType = buildBlockingFixture().spider.getBlockType('book-updated');
        assert.ok(blockType !== undefined);
        assert.equal(blockType.pollIntervalMs, 10_000);
      });
    });

  });
});
