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

      // Splice test-supplied custom engines into Spider's supportKit — see
      // mergeCustomEnginesIntoSpider for the kit-vs-kit uniqueness rationale.
      const spiderAsLoaded: LoadedApparatus = {
        packageName: '@shardworks/spider-apparatus',
        id: 'spider',
        version: '0.0.0',
        apparatus: mergeCustomEnginesIntoSpider(spiderApparatus, customEngines),
      };

      const fabricatorKitEntries = buildKitEntries(
        [],
        [spiderAsLoaded],
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
        const startedAt = new Date().toISOString();

        // Simulate: draft completed, implement launched a session
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
        const yields = (impl ? latestAttempt(impl)?.yields : undefined) as Record<string, unknown>;
        assert.equal(yields.conversationId, 'conv-abc', 'yields should include conversationId from session');
      });

      it('excludes conversationId from yields when session document does not have it', async () => {
        const { clerk, spider, stacks } = fix;
        await postWrit(clerk, 'No ConvId test');
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
        const yields = (impl ? latestAttempt(impl)?.yields : undefined) as Record<string, unknown>;
        assert.ok(yields, 'yields should exist after collect');
        assert.ok(
          !Object.prototype.hasOwnProperty.call(yields, 'conversationId'),
          'yields should NOT contain conversationId key when session has none',
        );
      });
    });
  });
});
