/**
 * Spider — ${yields.*} reference support.
 *
 * Covers the engine-givens substitution path: how ${yields.<engineId>.*}
 * placeholders inside givens resolve to the upstream engine's terminal
 * yields, including dotted paths, missing-yield handling, type
 * preservation, and interaction with kit-contributed templates.
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

  // Build a fixture with a single-template config and assert it throws
  // with a specific message fragment. Reused for the V3-V14 startup-error
  // validation tests below.
  function expectStartupError(template: RigTemplate, fragments: readonly string[]): void {
    assert.throws(
      () => buildFixture({ spider: { rigTemplates: { default: template } } }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const fragment of fragments) {
          assert.ok(err.message.includes(fragment), `expected "${fragment}" in: ${err.message}`);
        }
        return true;
      },
    );
  }

  function expectStartupOk(template: RigTemplate): void {
    assert.doesNotThrow(() => buildFixture({ spider: { rigTemplates: { default: template } } }));
  }

  // Run a kit-template build and return the captured warnings.
  function buildWithKit(kit: LoadedKit): { warnings: string[]; fix: ReturnType<typeof buildFixture> } {
    const { warnings, restore } = captureWarnings();
    try {
      const fix = buildFixture({}, { status: 'completed' }, { kits: [kit] });
      return { warnings, fix };
    } finally {
      restore();
    }
  }

  afterEach(() => {
    clearGuild();
  });

  // ── Validation — config templates (throw) ─────────────────────────

  describe('Validation — config templates', () => {
    it('V3/R3/R5 — unknown engine_id throws with "[spider]" prefix and "not an engine in this template"', () => {
      expectStartupError(
        { engines: [{ id: 'step1', designId: 'seal', givens: { x: '${yields.nonexistent.foo}' } }] },
        ['[spider]', 'nonexistent', 'not an engine in this template'],
      );
    });

    it('V4/R4/R6 — non-upstream engine_id throws "not upstream of"', () => {
      // engine a references yields from b, but b is downstream of a (a → b, not b → a)
      expectStartupError(
        {
          engines: [
            { id: 'a', designId: 'seal', givens: { x: '${yields.b.foo}' } },
            { id: 'b', designId: 'draft', upstream: ['a'], givens: { writ: '${writ}' } },
          ],
        },
        ['[spider]', '"b" is not upstream of "a"'],
      );
    });

    it('V5/R4 — transitive upstream reference is valid (does not throw)', () => {
      // a → b → c; c references ${yields.a.foo} (a is transitively upstream of c)
      expectStartupOk({
        engines: [
          { id: 'a', designId: 'seal', givens: {} },
          { id: 'b', designId: 'seal', upstream: ['a'], givens: {} },
          { id: 'c', designId: 'seal', upstream: ['b'], givens: { x: '${yields.a.foo}' } },
        ],
      });
    });

    it('self-reference fails upstream reachability check', () => {
      expectStartupError(
        { engines: [{ id: 'solo', designId: 'seal', givens: { x: '${yields.solo.foo}' } }] },
        ['"solo" is not upstream of "solo"'],
      );
    });

    it('curly-brace form ${yields.ghost.foo} also fails with unknown engine error', () => {
      expectStartupError(
        { engines: [{ id: 'only', designId: 'seal', givens: { x: '${yields.ghost.foo}' } }] },
        ['[spider]', 'not an engine in this template'],
      );
    });

    it('invalid syntax ${yields.a} (missing property segment) is rejected as invalid expression', () => {
      expectStartupError(
        {
          engines: [
            { id: 'a', designId: 'seal', givens: {} },
            { id: 'b', designId: 'seal', upstream: ['a'], givens: { x: '${yields.a}' } },
          ],
        },
        ['invalid expression'],
      );
    });

    it('valid ${yields.*} reference passes validation without throwing', () => {
      expectStartupOk({
        engines: [
          { id: 'first', designId: 'seal', givens: {} },
          { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '${yields.first.path}' } },
        ],
      });
    });

    it('curly-brace ${yields.*.*} form passes validation when engine is upstream', () => {
      expectStartupOk({
        engines: [
          { id: 'first', designId: 'seal', givens: {} },
          { id: 'second', designId: 'seal', upstream: ['first'], givens: { p: '${yields.first.path}' } },
        ],
      });
    });
  });

  // ── Validation — kit templates (warn and skip) ─────────────────────

  describe('Validation — kit templates (warn and skip)', () => {
    it('V6/R7 — kit template with unknown engine_id warns and skips template', () => {
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
      const { warnings } = buildWithKit(kit);
      assert.ok(
        warnings.some(w => w.includes('my-kit') && w.includes('not an engine in this template')),
        `Expected warning about unknown engine, got: ${JSON.stringify(warnings)}`,
      );
    });

    it('kit template with non-upstream engine_id warns "not upstream of" and skips', () => {
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
      const { warnings } = buildWithKit(kit);
      assert.ok(
        warnings.some(w => w.includes('my-kit') && w.includes('not upstream of')),
        `Expected "not upstream of" warning, got: ${JSON.stringify(warnings)}`,
      );
    });

    it('kit template with valid yield reference is registered without warnings', () => {
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
      const { warnings, fix } = buildWithKit(kit);
      const yieldWarnings = warnings.filter(w => w.includes('not an engine') || w.includes('not upstream'));
      assert.equal(yieldWarnings.length, 0, `Unexpected yield warnings: ${JSON.stringify(yieldWarnings)}`);
      const templates = fix.spider.listTemplates();
      assert.ok(templates.some(t => t.name === 'my-kit.pipeline'), 'Template should be registered');
    });
  });

  // ── Spawn-time pass-through (R8) ──────────────────────────────────

  describe('Spawn-time pass-through (R8)', () => {
    // Both tests below verify the same property — yield-ref strings are
    // preserved as-is in givensSpec at spawn time. Different test
    // descriptors document the two equivalent syntactic forms.
    async function expectGivensSpecPreserved(): Promise<void> {
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
      assert.equal(
        secondEngine!.givensSpec.p,
        '${yields.first.path}',
        'yield ref should be stored as literal ${...} string in givensSpec',
      );
    }

    it('V7/R8 — yield reference strings survive spawn time in givensSpec', expectGivensSpecPreserved);
    it('curly-brace form ${yields.*.*} is also preserved as-is in givensSpec', expectGivensSpecPreserved);
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

      // Splice test-supplied custom engines into Spider's supportKit — see
      // mergeCustomEnginesIntoSpider for the kit-vs-kit uniqueness rationale.
      const spiderAsLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus',
        id: 'spider',
        version: '0.0.0',
        apparatus: mergeCustomEnginesIntoSpider(spiderApparatus, customEngines),
      };

      const fabricatorKitEntries = buildKitEntries([], [spiderAsLoaded]);
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
        summon(): AnimateHandle { throw new Error('summon() not expected in yield-ref tests'); },
        animate(): AnimateHandle { throw new Error('animate() not expected in yield-ref tests'); },
      };
      apparatusMap.set('animator', mockAnimatorApi);

      clerkApparatus.start(noopCtx);
      const realClerk = clerkApparatus.provides as ClerkApi;

      // Auto-publish wrapper: matches the wrapper used by buildFixture above.
      // Legacy spider tests post a writ and expect the spider to dispatch it
      // on the next crawl tick — that requires the writ to be in `open`.
      // Post-refactor `clerk.post()` lands writs in `new`, so the wrapper
      // auto-publishes any writ that lands in `new` to preserve the legacy
      // flow.
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

      return { stacks, clerk, spider };
  }

  /**
   * Two-engine fixture builder: one yields-emitting engine ('first'),
   * one givens-capturing engine ('second'). Returns the captured givens
   * after running both engines. Collapses the dominant pattern across
   * the run-time resolution + template interpolation tests.
   */
  async function runYieldRefTest(opts: {
    firstYields: Record<string, unknown>;
    secondGivens: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | null = null;
    const firstDesign: EngineDesign = {
      id: 'fs-first',
      run: async () => ({ status: 'completed' as const, yields: opts.firstYields }),
    };
    const secondDesign: EngineDesign = {
      id: 'fs-second',
      run: async (givens: Record<string, unknown>) => {
        captured = { ...givens };
        return { status: 'completed' as const, yields: {} };
      },
    };
    const { clerk, spider } = buildYieldFixture(
      { 'fs-first': firstDesign, 'fs-second': secondDesign },
      {
        engines: [
          { id: 'first', designId: 'fs-first', givens: {} },
          { id: 'second', designId: 'fs-second', upstream: ['first'], givens: opts.secondGivens },
        ],
      },
    );
    await clerk.post({ title: 'Test', body: 'Body' });
    await spider.crawl(); // spawn
    await spider.crawl(); // run first
    await spider.crawl(); // run second
    assert.ok(captured !== null, 'second engine run() should have been called');
    return captured!;
  }

  describe('Run-time resolution (R1, R2)', () => {
    it('V1/R1 — second engine receives resolved yield value in run()', async () => {
      const givens = await runYieldRefTest({
        firstYields: { path: '/tmp/workdir' },
        secondGivens: { dir: '${yields.first.path}' },
      });
      assert.equal(givens.dir, '/tmp/workdir', 'yield ref should resolve to first engine path');
    });

    it('V2/R1 — curly-brace form ${yields.*.*} resolves identically', async () => {
      const givens = await runYieldRefTest({
        firstYields: { path: '/curly/path' },
        secondGivens: { dir: '${yields.first.path}' },
      });
      assert.equal(givens.dir, '/curly/path');
    });

    it('V1 (multiple refs) — multiple yield refs in one engine all resolve', async () => {
      const givens = await runYieldRefTest({
        firstYields: { foo: 'hello', bar: 42 },
        secondGivens: { x: '${yields.first.foo}', y: '${yields.first.bar}', z: 'literal' },
      });
      assert.equal(givens.x, 'hello', 'x should resolve to first.foo');
      assert.equal(givens.y, 42, 'y should resolve to first.bar');
      assert.equal(givens.z, 'literal', 'z literal should pass through');
    });

    it('R2 — yield property missing from upstream yields causes key omission', async () => {
      // first.yields does NOT contain 'nonExistentProp'
      const givens = await runYieldRefTest({
        firstYields: { someProp: 'value' },
        secondGivens: { p: '${yields.first.nonExistentProp}' },
      });
      assert.ok(!('p' in givens), 'missing prop should cause key omission');
    });

    it('R9 — collect() also receives resolved yield values, not raw strings', async () => {
      let capturedCollectGivens: Record<string, unknown> | null = null;

      const firstDesign: EngineDesign = {
        id: 'col-first',
        run: async () => ({ status: 'completed' as const, yields: { result: 'done' } }),
      };

      // Quick engine: returns 'launched' with a fixed sessionId so we can
      // pre-write the completed session doc and then drive collect().
      const secondDesign: EngineDesign = {
        id: 'col-second',
        run: async () => ({ status: 'launched' as const, sessionId: 'col-mock-session' }),
        collect: async (sessionId: string, givens: Record<string, unknown>) => {
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

      await clerk.post({ title: 'Test', body: 'Body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run first (clockwork → completed)
      // Pre-write completed session doc so collect can find it
      await stacks.book<SessionDoc>('animator', 'sessions').put({
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
      // Three-engine chain — runYieldRefTest is two-engine only, so build
      // this one inline.
      let captured: Record<string, unknown> | null = null;

      const designA: EngineDesign = {
        id: 'tr-a',
        run: async () => ({ status: 'completed' as const, yields: { someProp: 'from-a' } }),
      };
      const designB: EngineDesign = {
        id: 'tr-b',
        run: async () => ({ status: 'completed' as const, yields: {} }),
      };
      const designC: EngineDesign = {
        id: 'tr-c',
        run: async (givens: Record<string, unknown>) => {
          captured = { ...givens };
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

      assert.ok(captured !== null, 'c engine should have been called');
      assert.equal((captured as Record<string, unknown>).val, 'from-a');
    });
  });

  // ── Template interpolation: inline, dot-path, type coercion, escape ──

  describe('Template interpolation — new features', () => {
    afterEach(() => { clearGuild(); });

    it('V8/R5 — inline interpolation: "Path is ${yields.first.path}" resolves to string', async () => {
      const givens = await runYieldRefTest({
        firstYields: { path: '/tmp/workdir' },
        secondGivens: { msg: 'Path is ${yields.first.path}' },
      });
      assert.equal(givens.msg, 'Path is /tmp/workdir');
    });

    it('V9/R8 — mixed spawn+run-time: partially resolved at spawn, rest at run-time', async () => {
      // Inline: needs to inspect rig state at spawn time, so cannot use the
      // shared two-engine helper.
      let captured: Record<string, unknown> | null = null;
      const design1: EngineDesign = {
        id: 'mix-first',
        run: async () => ({ status: 'completed' as const, yields: { result: 'done' } }),
      };
      const design2: EngineDesign = {
        id: 'mix-second',
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
      await clerk.post({ title: 'My Writ', body: 'Body' });
      await spider.crawl(); // spawn — ${writ.title} resolved, ${yields.first.result} preserved

      // After spawn: writ.title resolved, yields expression still present
      const [rig] = await stacks.book<RigDoc>('spider', 'rigs').list();
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
      const givens = await runYieldRefTest({
        firstYields: { count: 42, flag: true, obj: { a: 1 } },
        secondGivens: {
          numStr: 'Count: ${yields.first.count}',
          boolStr: 'Ok: ${yields.first.flag}',
          objStr: 'Data: ${yields.first.obj}',
          // Whole-value — preserves type
          rawNum: '${yields.first.count}',
          rawObj: '${yields.first.obj}',
        },
      });
      assert.equal(givens.numStr, 'Count: 42', 'number stringified inline');
      assert.equal(givens.boolStr, 'Ok: true', 'boolean stringified inline');
      assert.equal(givens.objStr, 'Data: {"a":1}', 'object JSON.stringified inline');
      assert.equal(givens.rawNum, 42, 'whole-value number preserved');
      assert.deepEqual(givens.rawObj, { a: 1 }, 'whole-value object preserved');
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
      expectStartupError(
        { engines: [{ id: 'x', designId: 'seal', givens: { x: '${unknown.foo}' } }] },
        ['unrecognized expression'],
      );
    });

    it('V22/R4 — deep dot-path traversal for yields works at run time', async () => {
      const givens = await runYieldRefTest({
        firstYields: { nested: { deep: { prop: 'found' } } },
        secondGivens: { val: '${yields.first.nested.deep.prop}' },
      });
      assert.equal(givens.val, 'found', 'deep dot-path traversal works');
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
      const givens = await runYieldRefTest({
        firstYields: { obj: { x: 99 } },
        secondGivens: { data: '${yields.first.obj}' },
      });
      assert.deepEqual(givens.data, { x: 99 }, 'whole-value object type is preserved (not stringified)');
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
      const givens = await runYieldRefTest({
        firstYields: { path: '/real/path' },
        secondGivens: { p: '$yields.first.path' },
      });
      assert.equal(givens.p, '$yields.first.path',
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

    // Common shape for the givens-validation tests below.
    async function expectGivensError(
      givens: Record<string, unknown>,
      field: string,
      contextOverrides: Partial<EngineRunContext> = {},
    ): Promise<void> {
      await assert.rejects(
        () => animaSessionEngine.run(givens, makeContext(contextOverrides)),
        (err: Error) => {
          assert.ok(err.message.includes(field), `expected "${field}" in error: ${err.message}`);
          return true;
        },
      );
    }

    // Common shape for collect tests: spawn rig, mark draft completed,
    // mark implement running with sessionId, insert session doc, run
    // collect tick, return implement engine yields.
    async function runCollectScenario(sessionFields: Partial<SessionDoc>): Promise<Record<string, unknown>> {
      const { clerk, spider, stacks } = fix;
      await postWrit(clerk, 'collect scenario');
      await spider.crawl(); // spawn

      const book = rigsBook(stacks);
      const [rig] = await book.list();
      const fakeSessionId = generateId('ses', 4);
      const startedAt = new Date().toISOString();

      const enginesWithSession = rig.engines.map((e: EngineInstance) => {
        if (e.id === 'draft') {
          return {
            ...e,
            status: 'completed' as const,
            attempts: [{ startedAt, endedAt: startedAt, status: 'completed' as const, yields: { draftId: 'x', codexName: 'c', branch: 'b', path: '/p' } }],
          };
        }
        if (e.id === 'implement') {
          return {
            ...e,
            status: 'running' as const,
            attempts: [{ startedAt, sessionId: fakeSessionId }],
          };
        }
        return e;
      });
      await book.patch(rig.id, { engines: enginesWithSession });

      await stacks.book<SessionDoc>('animator', 'sessions').put({
        id: fakeSessionId,
        status: 'completed',
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
        provider: 'test',
        exitCode: 0,
        ...sessionFields,
      } as SessionDoc);

      await spider.crawl(); // collect

      const [updated] = await book.list();
      const impl = updated.engines.find((e: EngineInstance) => e.id === 'implement');
      const yields = (impl ? latestAttempt(impl)?.yields : undefined) as Record<string, unknown>;
      assert.ok(yields, 'yields should exist after collect');
      return yields;
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
        const animaTemplate: RigTemplate = {
          engines: [
            { id: 'anima', designId: 'anima-session', givens: { role: 'scribe', prompt: 'Do work', cwd: '/tmp' } },
          ],
          resolutionEngine: 'anima',
        };
        assert.doesNotThrow(() => {
          buildFixture({
            spider: { rigTemplates: { default: animaTemplate }, variables: {} },
          });
        });
      });
    });

    // ── Givens validation ────────────────────────────────────────────

    describe('givens validation', () => {
      it('throws when role is missing', () => expectGivensError({ prompt: 'x', cwd: '/tmp' }, 'role'));
      it('throws when role is an empty string', () => expectGivensError({ role: '', prompt: 'x', cwd: '/tmp' }, 'role'));
      it('throws when role is a non-string value', () => expectGivensError({ role: 123, prompt: 'x', cwd: '/tmp' }, 'role'));
      it('throws when prompt is missing', () => expectGivensError({ role: 'scribe', cwd: '/tmp' }, 'prompt'));
      it('throws when prompt is an empty string', () => expectGivensError({ role: 'scribe', prompt: '', cwd: '/tmp' }, 'prompt'));
      it('throws when cwd is missing', () => expectGivensError({ role: 'scribe', prompt: 'x' }, 'cwd'));

      it('throws when cwd is missing even when context.upstream has draft path', () => {
        // Patron directive: no fallback to draft path — cwd must come from givens
        return expectGivensError(
          { role: 'scribe', prompt: 'x' },
          'cwd',
          { upstream: { draft: { path: '/tmp/draft' } } },
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
        assert.equal(summonCalls[summonCalls.length - 1].conversationId, 'conv-123');
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
        const yields = await runCollectScenario({ conversationId: 'conv-abc' });
        assert.equal(yields.conversationId, 'conv-abc', 'yields should include conversationId from session');
      });

      it('excludes conversationId from yields when session document does not have it', async () => {
        const yields = await runCollectScenario({});
        assert.ok(
          !Object.prototype.hasOwnProperty.call(yields, 'conversationId'),
          'yields should NOT contain conversationId key when session has none',
        );
      });
    });
  });
});
