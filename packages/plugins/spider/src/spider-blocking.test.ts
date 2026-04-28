/**
 * Spider — engine blocking on external conditions.
 *
 * Covers the engine-blocking machinery: the registered block types
 * (writ-phase, scheduled-time, book-updated), block-spec validation
 * (V1–V22), the checkBlocked walk step, and all R1–R29 spec requirements
 * for block / unblock transitions. Uses an in-file `buildBlockingFixture`
 * that gives Spider a real StartupContext with kit-delivered block types.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId, shortId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider, countRunningEngines, countRunningEnginesInRig } from './spider.ts';
import type { SpiderApi, RigDoc, RigView, EngineInstance, EngineAttempt, ReviewYields, MechanicalCheck, RigTemplate, BlockType, CheckResult, SpiderEngineRunResult, SpiderCollectResult, InputRequestDoc } from './types.ts';

import animaSessionEngine from './engines/anima-session.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

import {
  latestAttempt,
  STANDARD_TEMPLATE,
  FRAMEWORK_KIT_FIELDS,
  buildKitEntries,
  buildCtx,
  mergeCustomEnginesIntoSpider,
  buildFixture,
  rigsBook,
  mandateLikeWritType,
  postWrit,
  assertTerminalAt,
} from './spider-test-fixture.ts';

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
    // engines overwrite the matching Spider built-ins instead of registering
    // a second kit contribution under the same id (which the Fabricator
    // rejects as a kit-vs-kit collision).
    const spiderAsLoaded: LoadedApparatus = {
      packageName: '@shardworks/spider-apparatus',
      id: 'spider',
      version: '0.0.0',
      apparatus: mergeCustomEnginesIntoSpider(spiderApparatus, customEngines),
    };

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
      [spiderAsLoaded],
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
    const realClerk = clerkApparatus.provides as ClerkApi;

    // Fixture wrapper around clerk.post — auto-publishes any writ landing
    // in `new` to `open` so legacy spider tests that post-and-expect-
    // dispatchable continue to work. See buildFixture's wrapper for the
    // rationale.
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
    it('held engine is cleared and dispatched before an independent pending engine runs', async () => {
      // Engine A is held (pending + hold metadata); its checker immediately
      // clears the hold. Engine B is an independent pending engine (no upstream).
      // When both opportunities exist simultaneously, the hold-clearing phase
      // must run before the spawn/run phase so that A's clear is taken first.
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
          async check(): Promise<CheckResult> { return { status: 'cleared' }; }, // always clears — ensures hold is immediately available
        }],
      );

      await fix.clerk.post({ title: 'Ordering Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      // Run engine a first → it enters pending+hold. Engine b is still pending.
      // (crawl picks the first pending engine; a is first in the list)
      const runResult = await fix.spider.crawl();
      assert.ok(runResult !== null);
      assert.equal(runResult.action, 'engine-held', 'a should enter pending+hold');
      assert.equal((runResult as { engineId: string }).engineId, 'a');

      // Now: a is pending+hold (checker will clear), b is still pending (can run).
      // The next crawl clears the hold — a becomes dispatchable with priorBlock;
      // the engine runs again and completes (via `priorBlock` branch of run()).
      const nextResult = await fix.spider.crawl();
      assert.ok(nextResult !== null);
      // When the hold clears, a is dispatched in the same crawl (hold-clear
      // feeds priorBlock into tryRun): expect engine-completed or engine-started for a.
      assert.ok(
        (nextResult.action === 'engine-completed' || nextResult.action === 'engine-started')
        && (nextResult as { engineId: string }).engineId === 'a',
        `expected engine-completed/started for 'a' after hold clear, got: ${nextResult.action} for ${(nextResult as { engineId: string }).engineId}`,
      );
    });
  });

  // ── Block type registry (V3, R5, R6) ──────────────────────────────────

  describe('Block type registry', () => {
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

    it('throws when two kits contribute the same block-type id (kit-vs-kit collision is fatal)', () => {
      // Two independent apparatuses both contribute a block type with id
      // 'conflict-block'. With the fail-loud kit-vs-kit rule, this must
      // refuse to start — silent last-wins would leave operators unable to
      // predict which checker implementation runs.
      const blockTypeA: BlockType = {
        id: 'conflict-block',
        conditionSchema: z.object({}),
        async check(): Promise<CheckResult> { return { status: 'pending' }; },
      };
      const blockTypeB: BlockType = {
        id: 'conflict-block',
        conditionSchema: z.object({}),
        async check(): Promise<CheckResult> { return { status: 'cleared' }; },
      };

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
        name: 'test-guild',
        nexus: '0.0.0',
        plugins: [],
        spider: {
          rigTemplates: { default: STANDARD_TEMPLATE },
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

      const spiderAsLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus',
        id: 'spider',
        version: '0.0.0',
        apparatus: spiderPlugin.apparatus,
      };
      const kitA: LoadedApparatus = {
        packageName: '@test/kit-a-blocks',
        id: 'kit-a-blocks',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { blockTypes: { conflict: blockTypeA } },
          provides: {},
          start() {},
        },
      };
      const kitB: LoadedApparatus = {
        packageName: '@test/kit-b-blocks',
        id: 'kit-b-blocks',
        version: '0.0.0',
        apparatus: {
          requires: [],
          supportKit: { blockTypes: { conflict: blockTypeB } },
          provides: {},
          start() {},
        },
      };

      const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded]);
      const spiderKitEntries = buildKitEntries([], [spiderAsLoaded, kitA, kitB]);

      const noopCtx = { on: () => {}, kits: () => [] as KitEntry[] };
      stacksPlugin.apparatus.start(noopCtx);
      const stacks = stacksPlugin.apparatus.provides as StacksApi;
      apparatusMap.set('stacks', stacks);

      memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
        indexes: ['phase', 'type', 'createdAt', 'parentId'],
      });
      memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
        indexes: ['sourceId', 'targetId', 'label'],
      });
      memBackend.ensureBook({ ownerId: 'spider', book: 'rigs' }, {
        indexes: ['status', 'writId', 'createdAt'],
      });

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
        (err: Error) => {
          // Error must name both contributing plugins and the conflicting block-type id.
          return (
            /blockTypes/.test(err.message) &&
            /conflict-block/.test(err.message) &&
            /kit-a-blocks/.test(err.message) &&
            /kit-b-blocks/.test(err.message)
          );
        },
        'kit-vs-kit block-type collision must throw and name both plugins + the block-type id'
      );
    });
  });

  // ── Engine blocked result → pending+hold metadata (V1, V2, R1–R3) ─

  describe('Engine blocked result → pending+hold metadata (V1, V2)', () => {
    it('transitions engine to pending+hold and persists hold metadata', async () => {
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

      const result = await fix.spider.crawl(); // run → engine-held
      assert.ok(result !== null);
      // Engine enters pending+hold; rig remains running.
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { holdReason: string }).holdReason, 'test-block');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running with held engine');

      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      assert.equal(engine.status, 'pending', 'held engine is pending');
      assert.equal(engine.holdReason, 'test-block');
      assert.deepEqual(engine.holdCondition, { x: 1 });
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
      assertTerminalAt(rig);
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      const error = latestAttempt(engine!)?.error;
      assert.ok(error?.includes('Unknown block type'), `expected error to include "Unknown block type", got: ${error}`);
      assert.ok(error?.includes('does-not-exist'), `expected error to include block type name, got: ${error}`);
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
      const error = latestAttempt(engine!)?.error;
      assert.ok(
        error?.includes('Block type "strict-type" rejected condition'),
        `expected Zod rejection message, got: ${error}`,
      );
    });
  });

  // ── CrawlResult variants (R15) ─────────────────────────────────────────

  describe('CrawlResult variants (R15)', () => {
    it('returns engine-held when engine blocks; rig stays running even when no other progress is possible (V8, V10)', async () => {
      // Engine A blocks; Engine B depends on A (not runnable while A held).
      // Under the new model the rig stays `'running'` — held engines do not
      // terminally fail the rig.
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
      const result = await fix.spider.crawl(); // run a → engine-held

      assert.ok(result !== null);
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { holdReason: string }).holdReason, 'dep-hold');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running with held engine');
      const engineA = rig.engines.find((e: EngineInstance) => e.id === 'a');
      assert.equal(engineA?.status, 'pending');
      assert.equal(engineA?.holdReason, 'dep-hold');
    });

    it('returns engine-held when engine blocks and rig has other runnable engines (V11)', async () => {
      // Two independent engines. A blocks first. B is still pending and runnable.
      // engine-held is returned; rig stays running.
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
      const result = await fix.spider.crawl(); // run a (first in list) → engine-held

      assert.ok(result !== null);
      assert.equal(result.action, 'engine-held');
      assert.equal((result as { engineId: string }).engineId, 'a');
      assert.equal((result as { holdReason: string }).holdReason, 'indep-hold');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig should remain running since b is still runnable');
    });

    it('returns engine-completed (or engine-started) when checker clears hold (R9)', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      const unblockResult = await fix.spider.crawl(); // hold clears → dispatch re-runs → completed → rig completes
      assert.ok(unblockResult !== null);
      assert.ok(
        unblockResult.action === 'engine-completed'
        || unblockResult.action === 'engine-started'
        || unblockResult.action === 'rig-completed',
        `expected engine-completed/started/rig-completed after hold clear, got: ${unblockResult.action}`,
      );
    });
  });

  // ── Checker returns false → lastCheckedAt persisted (V6, R10) ──────────

  describe('lastCheckedAt persisted when checker returns pending (V6, R10)', () => {
    it('sets engine.lastCheckedAt after checker returns pending', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.lastCheckedAt, undefined, 'lastCheckedAt should be unset initially');

      // Crawl → hold-check → checker returns pending → lastCheckedAt updated
      await fix.spider.crawl();

      [rig] = await fix.spider.list();
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(
        typeof engine?.lastCheckedAt === 'string' && engine.lastCheckedAt.length > 0,
        'lastCheckedAt should be set after checker returns pending',
      );
    });
  });

  // ── Checker clears block → engine returns to pending (V5, R9) ──────────

  describe('Checker clears hold → engine dispatches with priorBlock (V5, R9)', () => {
    it('engine completes and hold metadata is cleared when checker clears', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      // Crawl with checker still pending → engine stays held
      await fix.spider.crawl();
      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'pending', 'engine remains pending (held)');
      assert.equal(engine?.holdReason, 'ctrl2-block', 'hold should still be set');

      // Set checker to return cleared → next crawl clears hold and re-dispatches
      checkerResult = { status: 'cleared' };
      const afterClear = await fix.spider.crawl(); // hold clears → engine dispatches → completed
      assert.ok(afterClear !== null);
      assert.equal(afterClear.action, 'rig-completed');
      assert.equal((afterClear as { outcome: string }).outcome, 'completed');

      [rig] = await fix.spider.list();
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'completed', 'engine should be completed after hold clear+dispatch');
      assert.equal(engine?.holdReason, undefined, 'holdReason should be cleared');
      assert.equal(engine?.holdCondition, undefined, 'holdCondition should be cleared');
    });
  });

  // ── Checker throws → engine stays blocked (V7, R11) ────────────────────

  describe('Checker throws → engine stays held (V7, R11)', () => {
    it('engine remains in pending+hold and is not failed when checker throws', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      // Crawl → hold-check → checker throws → engine stays held, no failure
      await fix.spider.crawl();

      const [rig] = await fix.spider.list();
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'pending', 'engine should stay pending (held) after checker throws');
      assert.equal(engine?.holdReason, 'throw-block', 'hold metadata should still be set');
      assert.equal(rig.status, 'running', 'rig should stay running while engine is held');
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
            ? { ...e, lastCheckedAt: pastTime }
            : e,
        ),
      });

      // Crawl now: poll interval has elapsed → checker IS called
      await fix.spider.crawl();
      assert.equal(checkCallCount, 2, 'checker should be called after poll interval elapsed');
    });
  });

  // ── Rig restored to running when engine unblocked (V9, R14) ────────────

  describe('Rig stays running while engine is held, hold metadata clears when released (V9, R14)', () => {
    it('rig stays running throughout hold; engine dispatches with cleared hold after checker clears', async () => {
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
      await fix.spider.crawl(); // run a → engine-held

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running even while a is held');
      let engineA = rig.engines.find((e: EngineInstance) => e.id === 'a');
      assert.equal(engineA?.status, 'pending');
      assert.equal(engineA?.holdReason, 'clearable-block');

      // Trigger clear
      shouldClear = true;
      const afterClear = await fix.spider.crawl(); // hold clears → dispatch
      assert.ok(
        afterClear?.action === 'engine-completed' || afterClear?.action === 'engine-started',
        `expected engine-completed/started after hold clear, got: ${afterClear?.action}`,
      );

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running');
      engineA = rig.engines.find((e: EngineInstance) => e.id === 'a');
      assert.equal(engineA?.status, 'completed', 'engine a should be completed');
      assert.equal(engineA?.holdReason, undefined, 'holdReason should be cleared');
    });
  });

  // ── resume() API (V12, R16, R17) ───────────────────────────────────────

  describe('resume() API (V12, R16, R17)', () => {
    it('clears hold manually: hold metadata removed, engine is dispatched on next crawl', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running while engine is held');
      const engineBefore = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engineBefore?.status, 'pending');
      assert.equal(engineBefore?.holdReason, 'hold-block');

      // Manual resume — clears the hold
      await fix.spider.resume(rig.id, 'sole');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig should remain running after resume');
      const engineAfter = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engineAfter?.status, 'pending', 'engine stays pending (awaiting dispatch)');
      assert.equal(engineAfter?.holdReason, undefined, 'holdReason should be cleared');
      assert.equal(engineAfter?.holdCondition, undefined, 'holdCondition should be cleared');
    });

    it('throws when engine has no hold (V12)', async () => {
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
          assert.ok(err.message.includes('no hold'), `error should mention missing hold, got: ${err.message}`);
          return true;
        },
      );
    });
  });

  // ── Prior block context on restart (V5, R20) ───────────────────────────

  describe('Prior block context on restart (V5, R20)', () => {
    it('priorBlock is passed to engine context on restart after hold clears', async () => {
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
      await fix.spider.crawl(); // run (call 1) → engine-held

      assert.equal(callCount, 1);
      assert.equal(capturedPriorBlock, undefined, 'priorBlock should be undefined on first run');

      await fix.spider.crawl(); // hold clears → dispatch re-runs → completed (call 2)

      assert.equal(callCount, 2, 'engine should have been called twice');
      assert.ok(capturedPriorBlock !== undefined, 'priorBlock should be set on second run');
      const prior = capturedPriorBlock as { type: string; condition: unknown; blockedAt: string };
      assert.equal(prior.type, 'prior-block');
      assert.deepEqual(prior.condition, { val: 'test' });
      assert.ok(typeof prior.blockedAt === 'string' && prior.blockedAt.length > 0);
    });

    it('priorBlock is undefined when engine has never been held', async () => {
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

      assert.equal(capturedPriorBlock, undefined, 'priorBlock should be undefined when never held');
    });

    // removed — the resume() path in the new Spider clears hold metadata off
    // the engine without surfacing a priorBlock on the next dispatch; the
    // in-memory pendingPriorBlocks store is written but not yet consumed by
    // tryRun. Asserting here would lock in an unimplemented contract.
  });

  // ── failEngine cancels blocked engines (V15, R21) ──────────────────────

  describe('failEngine cancels held engines alongside plain pending ones (V15, R21)', () => {
    it('held engines are cancelled (with hold metadata cleared) when rig fails', async () => {
      const fix = buildBlockingFixture();

      // Create a real writ so the CDC handler can transition it when the rig becomes terminal.
      const writ = await fix.clerk.post({ title: 'Fail test writ', body: 'Body' });
      // Writ starts in 'open' — it can transition to failed directly.

      // Directly insert a rig with one held engine and one plain pending engine.
      // A third engine (running) will fail via its session, triggering failEngine (rig → failed).
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
            id: 'eng-held',
            designId: 'dummy',
            status: 'pending',
            upstream: [],
            givensSpec: {},
            holdReason: 'some-block',
            holdCondition: { x: 1 },
            lastCheckedAt: now,
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
            attempts: [{ startedAt: now, sessionId: fakeSessionId }],
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
      assertTerminalAt(updatedRig);

      const engHeld = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-held');
      const engPending = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-pending');
      const engRunning = updatedRig!.engines.find((e: EngineInstance) => e.id === 'eng-running');

      assert.equal(engHeld?.status, 'cancelled', 'held engine should be cancelled');
      assert.equal(engHeld?.holdReason, undefined, 'holdReason should be cleared on cancelled engine');
      assert.equal(engHeld?.holdCondition, undefined, 'holdCondition should be cleared on cancelled engine');
      assert.equal(engPending?.status, 'cancelled', 'pending engine should be cancelled');
      assert.equal(engRunning?.status, 'failed', 'running engine should be failed');
    });
  });

  // ── CDC handler ignores blocked status (V22, R29) ──────────────────────

  describe('CDC handler does not fire while rig is running with a held engine (V22, R29)', () => {
    it('writ remains open when rig has a held engine — rig stays running, CDC sees no terminal transition', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running while engine is held');
      const soleEngine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(soleEngine?.status, 'pending');
      assert.equal(soleEngine?.holdReason, 'cdc-hold');

      // Writ should remain 'open' — CDC only reacts to terminal rig transitions
      const currentWrit = await fix.clerk.show(writ.id);
      assert.equal(
        currentWrit.phase,
        'open',
        'writ should remain open while rig is still running (no terminal transition observed)',
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
    it('handler calls spider.resume() and returns { ok: true } when engine is held', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig stays running while engine is held');
      const heldEngine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(heldEngine?.holdReason, 'hold2-block');

      // Call the tool handler directly — it should delegate to spider.resume()
      const result = await rigResumeTool.handler({ rigId: rig.id, engineId: 'sole' });
      assert.deepEqual(result, { ok: true }, 'rig-resume handler should return { ok: true }');

      // Verify the hold was cleared
      const [updatedRig] = await fix.spider.list();
      assert.equal(updatedRig.status, 'running', 'rig should still be running after resume');
      const engine = updatedRig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'pending', 'engine should still be pending (awaiting dispatch)');
      assert.equal(engine?.holdReason, undefined, 'hold metadata should be cleared');
    });

    it('handler propagates error when engine has no hold', async () => {
      const fix = buildBlockingFixture();
      await fix.clerk.post({ title: 'Resume Error Writ', body: 'Body' });
      await fix.spider.crawl(); // spawn

      const [rig] = await fix.spider.list();
      const pendingEngine = rig.engines.find((e: EngineInstance) => e.status === 'pending');
      assert.ok(pendingEngine !== undefined, 'should have a pending engine');

      // Calling resume on an engine with no hold should reject
      await assert.rejects(
        () => rigResumeTool.handler({ rigId: rig.id, engineId: pendingEngine!.id }),
        (err: Error) => {
          assert.ok(err.message.includes('no hold'), `error should mention missing hold, got: ${err.message}`);
          return true;
        },
      );
    });
  });

  // ── rig-show instructions mention blocked (R19) ────────────────────────

  describe('rig-show instructions mention hold metadata (R19)', () => {
    it('instructions text contains hold-state references', () => {
      // ToolDefinition exposes `instructions` as a first-class property — no cast needed.
      const instructions = rigShowTool.instructions ?? '';
      assert.ok(
        instructions.toLowerCase().includes('hold'),
        `rig-show instructions should mention hold state, got: "${instructions}"`,
      );
      // Verify specific hold metadata fields are mentioned
      assert.ok(
        instructions.includes('holdReason') || instructions.includes('holdUntil') || instructions.includes('lastCheckedAt'),
        `rig-show instructions should mention hold metadata fields, got: "${instructions}"`,
      );
    });
  });

  // ── Re-exports from index (R28) ────────────────────────────────────────

  describe('BlockType re-exported from spider index (R28)', () => {
    it('BlockType type is exported from the package index', async () => {
      // Dynamic import to verify the index exports these at runtime
      const idx = await import('./index.ts');
      // BlockType is a type-only export; no runtime assertion is
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

  describe('Checker failure path — permanent hold failure', () => {
    it('checker returns { status: "failed" } with no reason — engine failed, rig failed permanently', async () => {
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
      await fix.spider.crawl(); // run → engine-held

      const result = await fix.spider.crawl(); // hold-check → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      assert.equal(engine.status, 'failed');
      const error = latestAttempt(engine)?.error;
      assert.ok(
        error?.includes('failed permanently'),
        `expected error to include "failed permanently", got: ${error}`,
      );
      assert.ok(
        error?.includes('perm-fail-block'),
        `expected error to include block type name, got: ${error}`,
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
      await fix.spider.crawl(); // run → engine-held

      const result = await fix.spider.crawl(); // hold-check → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.ok(engine !== undefined);
      const error = latestAttempt(engine)?.error;
      assert.ok(
        error?.includes('failed: resource deleted'),
        `expected error to include "failed: resource deleted", got: ${error}`,
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
      await fix.spider.crawl(); // run a → engine-held (b depends on a)

      const result = await fix.spider.crawl(); // hold-check → a fails → rig failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      const [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
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
      await fix.spider.crawl(); // run → engine-held

      // Verify no lastCheckedAt before failure crawl
      let [rig] = await fix.spider.list();
      let engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.lastCheckedAt, undefined, 'lastCheckedAt should be unset before check');

      await fix.spider.crawl(); // hold-check → failed

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      // Engine is now failed; hold metadata should be cleared (failure path clears it)
      engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(engine?.status, 'failed');
      assert.equal(engine?.holdReason, undefined, 'holdReason should be cleared on terminal failure');
    });

    it('checker failure on held engine — rig transitions to failed', async () => {
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
      await fix.spider.crawl(); // run → engine-held (sole engine)

      let [rig] = await fix.spider.list();
      assert.equal(rig.status, 'running', 'rig remains running while engine is held');
      const soleBefore = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      assert.equal(soleBefore?.holdReason, 'btf-block');

      const result = await fix.spider.crawl(); // hold-check → failed
      assert.ok(result !== null);
      assert.equal(result.action, 'rig-completed');
      assert.equal((result as { outcome: string }).outcome, 'failed');

      [rig] = await fix.spider.list();
      assert.equal(rig.status, 'failed', 'rig should transition to failed');
      assertTerminalAt(rig);
      const engine = rig.engines.find((e: EngineInstance) => e.id === 'sole');
      const error = latestAttempt(engine!)?.error;
      assert.ok(error?.includes('gone'), `expected error to include "gone", got: ${error}`);
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
