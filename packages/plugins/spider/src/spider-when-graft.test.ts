/**
 * Spider — `when` conditions, cascade skipping, and grafting.
 *
 * Covers conditional engine activation via the `when` predicate, the
 * downstream cascade-skip behaviour when an engine is skipped, and the
 * graft path that splices new engines into an in-flight rig.
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

// ── Conditional engine activation (`when`), cascade skipping, and grafting ──

describe('Spider — when conditions, cascade skipping, and grafting', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── In-file helpers ─────────────────────────────────────────────────

  // Stub-engine factory: most tests want a clockwork engine that returns
  // `{ status: 'completed', yields }`. This collapses dozens of inline
  // `{ id, async run() { return { status: 'completed' as const, yields }; } }`
  // literals to one line each.
  const clockworkStub = (id: string, yields: Record<string, unknown> = {}): EngineDesign => ({
    id, async run() { return { status: 'completed' as const, yields }; },
  });

  const failingStub = (id: string, message: string): EngineDesign => ({
    id, async run() { throw new Error(message); },
  });

  const graftingStub = (
    id: string,
    opts: { yields?: Record<string, unknown>; graft: NonNullable<SpiderEngineRunResult['graft']> },
  ): EngineDesign => ({
    id,
    async run() {
      return {
        status: 'completed' as const,
        yields: opts.yields ?? {},
        graft: opts.graft,
      };
    },
  });

  // Collect a list of [id, yields?] pairs into a customEngines map.
  const stubMap = (...defs: Array<[string, Record<string, unknown>?]>): Record<string, EngineDesign> =>
    Object.fromEntries(defs.map(([id, yields]) => [id, clockworkStub(id, yields)]));

  function buildWhenFixture(
    template: RigTemplate,
    customEngines: Record<string, EngineDesign>,
    spiderExtras: Partial<NonNullable<GuildConfig['spider']>> = {},
  ): ReturnType<typeof buildFixture> {
    return buildFixture(
      { spider: { rigTemplates: { default: template }, ...spiderExtras } },
      { status: 'completed' },
      { customEngines },
    );
  }

  const engStatus = (rig: RigDoc, id: string): string | undefined =>
    rig.engines.find((e: EngineInstance) => e.id === id)?.status;

  function assertStatuses(rig: RigDoc, expected: Record<string, EngineInstance['status']>): void {
    for (const [id, status] of Object.entries(expected)) {
      assert.equal(engStatus(rig, id), status, `engine "${id}" should be ${status}`);
    }
  }

  // Drive crawl until rig reaches terminal state.
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
        if (r.action === 'rig-completed') break;
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { flag: false }],
        ['stub-b', { ran: true }],
      ));
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'skip test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const r = await spider.crawl(); // skip B (or rig-completed)

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { B: 'skipped' });
      assert.ok(
        r?.action === 'engine-skipped' || r?.action === 'rig-completed',
        `Expected engine-skipped or rig-completed, got ${r?.action}`,
      );
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });
  });

  // ── V3: Branching (when true runs, when false skips) ─────────────────

  describe('Branching — when condition (V3)', () => {
    const branchTemplate: RigTemplate = {
      engines: [
        { id: 'review',  designId: 'stub-review',  givens: {} },
        { id: 'seal',    designId: 'stub-seal',    upstream: ['review'], when: '${yields.review.passed}' },
        { id: 'revise',  designId: 'stub-revise',  upstream: ['review'], when: '!${yields.review.passed}' },
      ],
    };

    it('runs the truthy branch and skips the falsy branch when review passes', async () => {
      const fix = buildWhenFixture(branchTemplate, stubMap(
        ['stub-review', { passed: true }],
        ['stub-seal',   { sealed: true }],
        ['stub-revise', { revised: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'branching test', body: 'body' });
      const { results } = await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { seal: 'completed', revise: 'skipped' });
      // engine-skipped may be absorbed into rig-completed when skipping causes rig completion
      assert.ok(
        results.some((r) => r?.action === 'engine-skipped') || results.some((r) => r?.action === 'rig-completed'),
        'should have engine-skipped or rig-completed result',
      );
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
    });

    it('runs the falsy branch and skips the truthy branch when review fails', async () => {
      const fix = buildWhenFixture(branchTemplate, stubMap(
        ['stub-review', { passed: false }],
        ['stub-seal',   { sealed: true }],
        ['stub-revise', { revised: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'branch-fail test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { seal: 'skipped', revise: 'completed' });
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
    });

    it('supports curly-brace when syntax: ${yields.review.passed}', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review', designId: 'stub-review', givens: {} },
          { id: 'seal',   designId: 'stub-seal',   upstream: ['review'], when: '${yields.review.passed}' },
        ],
      };
      const fix = buildWhenFixture(template, stubMap(
        ['stub-review', { passed: true }],
        ['stub-seal',   { sealed: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'curly brace when', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { seal: 'completed' });
    });

    it('supports negated curly-brace when syntax: !${yields.review.passed}', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'review', designId: 'stub-review', givens: {} },
          { id: 'revise', designId: 'stub-revise', upstream: ['review'], when: '!${yields.review.passed}' },
        ],
      };
      const fix = buildWhenFixture(template, stubMap(
        ['stub-review', { passed: false }],
        ['stub-revise', { revised: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'negated curly brace when', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { revise: 'completed' });
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { flag: false }],
        ['stub-b', { ranB: true }],
        ['stub-c', { ranC: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'skip satisfies upstream', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { A: 'completed', B: 'skipped', C: 'completed' });
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { go: true }],
        ['stub-b', { ranB: true }],
        ['stub-c', { ranC: true }],
      ));
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'rig completion test', body: 'body' });
      const { results } = await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
      assert.ok(results.some((r) => r?.action === 'rig-completed'), 'rig-completed result expected');
      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });

    it('does NOT complete the rig when all engines are skipped (no completed engine)', async () => {
      // The cleanest way to verify the all-skipped edge case: run a normal
      // skip-completing rig first, then directly inject a separate rig with
      // all engines status='skipped' and verify it stays in 'running'
      // (isRigComplete returns false when there are no completed engines).
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.pass}' },
        ],
      };
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { pass: false }],
        ['stub-b', { ran: true }],
      ));
      const { clerk, spider, stacks } = fix;
      const writ = await clerk.post({ title: 'partial complete test', body: 'body' });
      await drainToTerminal(spider);

      // A is completed, B is skipped — rig should complete (A is completed)
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'completed', 'rig should complete because A completed');
      assertTerminalAt(rig);

      // Now seed an all-skipped rig and verify the CDC handler does NOT
      // mark it completed (no running/pending and no completed engine).
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
      // tryRun finds no runnable engines; tryCollect/tryProcessGrafts/tryCheckBlocked
      // also have nothing to do; the all-skipped rig stays 'running'.
      await spider.crawl();
      const refetched = await book.find({ where: [['id', '=', allSkippedRig.id]], limit: 1 });
      assert.equal(refetched[0]?.status, 'running', 'all-skipped rig should NOT be marked completed');
    });
  });

  // ── V6: Template validation for `when` ───────────────────────────────

  describe('Template validation for when (V6)', () => {
    const ab = (whenExpr: string): RigTemplate => ({
      engines: [
        { id: 'A', designId: 'stub-a', givens: {} },
        { id: 'B', designId: 'stub-b', upstream: ['A'], when: whenExpr },
      ],
    });
    const abEngines = stubMap(['stub-a'], ['stub-b']);

    it('throws at startup when when expression is not a $yields reference', () => {
      assert.throws(
        () => buildWhenFixture(ab('not-a-valid-ref'), abEngines),
        /invalid when expression/i,
        'should throw on invalid when expression',
      );
    });

    it('throws at startup when when references a non-existent engine', () => {
      assert.throws(
        () => buildWhenFixture(ab('${yields.nonexistent.passed}'), abEngines),
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
        () => buildWhenFixture(template, stubMap(['stub-a'], ['stub-b'], ['stub-c'])),
        /not upstream of/,
        'should throw when when references a non-upstream engine',
      );
    });

    it('does not throw for a valid negated when expression', () => {
      assert.doesNotThrow(
        () => buildWhenFixture(ab('!${yields.A.passed}'), abEngines),
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { run: false }],
        ['stub-b'],
      ));
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { run: false }],
        ['stub-b'],
        ['stub-c'],
      ));
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
      const fix = buildWhenFixture(template, {
        'stub-a': clockworkStub('stub-a', { pass: false }),
        // B is skipped (pass=false), C runs and throws
        'stub-b': { id: 'stub-b', async run() { bRan = true; return { status: 'completed' as const, yields: {} }; } },
        'stub-c': failingStub('stub-c', 'C failed intentionally'),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'failEngine skipped test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { B: 'skipped', C: 'failed' });
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { x: false }],
        ['stub-b', { y: true }],
        ['stub-c', { z: true }],
        ['stub-d'],
        ['stub-e', { ranE: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'cascade skip test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A (completes with x=false)
      const skipResult = await spider.crawl(); // should skip B and cascade-skip C, D

      assert.equal(skipResult?.action, 'engine-skipped', 'should get engine-skipped');
      const skippedResult = skipResult as { action: 'engine-skipped'; engineId: string; cascadeSkipped?: string[] };
      assert.equal(skippedResult.engineId, 'B', 'primary skipped engine should be B');
      assert.ok(skippedResult.cascadeSkipped?.includes('C') ?? false, 'C should be in cascadeSkipped');
      assert.ok(skippedResult.cascadeSkipped?.includes('D') ?? false, 'D should be in cascadeSkipped');
      // E is unconditional and should NOT be cascade-skipped
      assert.ok(!(skippedResult.cascadeSkipped?.includes('E') ?? false), 'E (unconditional) should NOT be in cascadeSkipped');

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { B: 'skipped', C: 'skipped', D: 'skipped', E: 'pending' });
    });

    it('unconditional engines are NOT cascade-skipped', async () => {
      const template: RigTemplate = {
        engines: [
          { id: 'A', designId: 'stub-a', givens: {} },
          { id: 'B', designId: 'stub-b', upstream: ['A'], when: '${yields.A.flag}' }, // conditional, skipped
          { id: 'C', designId: 'stub-c', upstream: ['B'] }, // unconditional
        ],
      };
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { flag: false }],
        ['stub-b'],
        ['stub-c', { ranC: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'unconditional no-cascade test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run A
      const skipResult = await spider.crawl(); // skip B

      assert.equal(skipResult?.action, 'engine-skipped');
      const skippedResult = skipResult as { cascadeSkipped?: string[] };
      assert.ok(!(skippedResult.cascadeSkipped?.includes('C') ?? false), 'unconditional C should not be cascade-skipped');

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { C: 'pending' });
    });
  });

  // ── When references skipped engine (edge case) ───────────────────────

  describe('when references a skipped engine (edge case)', () => {
    // Both tests use the same template shape: X completes, B is skipped
    // (when=$yields.X.flag is false), then C's behaviour depends on whether
    // it references B.result with or without negation. Skipped engines have
    // no yields, so upstream[B] is undefined → value undefined → falsy.
    const template = (cWhen: string): RigTemplate => ({
      engines: [
        { id: 'X', designId: 'stub-x', givens: {} },
        { id: 'B', designId: 'stub-b', upstream: ['X'], when: '${yields.X.flag}' },
        { id: 'C', designId: 'stub-c', upstream: ['B'], when: cWhen },
      ],
    });
    const engines = stubMap(
      ['stub-x', { flag: false }],
      ['stub-b', { result: 'something' }],
      ['stub-c', { ranC: true }],
    );

    it('skips engine when its when references a skipped upstream engine (undefined is falsy)', async () => {
      // C: when=$yields.B.result. B was skipped → B.result is undefined → falsy → skip
      const fix = buildWhenFixture(template('${yields.B.result}'), engines);
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'skipped upstream when test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { B: 'skipped', C: 'skipped' });
    });

    it('runs engine when its negated when references a skipped upstream engine (negated undefined is truthy)', async () => {
      // C: when=!$yields.B.result. B skipped → B.result undefined → !undefined=true → C runs
      const fix = buildWhenFixture(template('!${yields.B.result}'), engines);
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'negated skipped upstream when test', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { B: 'skipped', C: 'completed' });
    });
  });

  // ── V9, V10, V11: Engine-initiated grafting ───────────────────────────

  describe('Engine-initiated grafting — clockwork (V9, V10, V11)', () => {
    it('clockwork engine can graft new engines to the rig', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'decision', designId: 'stub-decision', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        'stub-decision': graftingStub('stub-decision', {
          yields: { decided: true },
          graft: [{ id: 'extra', designId: 'stub-extra', upstream: ['decision'] }],
        }),
        'stub-extra': clockworkStub('stub-extra', { ran: true }),
      });
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

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.engines.length, 2, 'rig should have 2 engines after graft');
      assert.ok(rig.engines.find((e: EngineInstance) => e.id === 'extra'), 'extra engine should exist');
      assertStatuses(rig, { extra: 'pending' });

      const r3 = await spider.crawl(); // run extra → rig-completed (extra is the last engine)
      assert.equal(r3?.action, 'rig-completed');
      assert.equal((r3 as { outcome: string }).outcome, 'completed');

      const finalWrit = await clerk.show(writ.id);
      assert.equal(finalWrit.phase, 'completed');
    });

    it('graft is processed in a separate crawl step after engine-completed', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'graftingEngine', designId: 'stub-grafter', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        'stub-grafter': graftingStub('stub-grafter', {
          yields: { x: 1 },
          graft: [{ id: 'added', designId: 'stub-added', upstream: ['graftingEngine'] }],
        }),
        'stub-added': clockworkStub('stub-added'),
      });
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
        engines: [{ id: 'bad-grafter', designId: 'stub-bad-grafter', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        // 'bad-grafter' already exists in the rig — duplicate
        'stub-bad-grafter': graftingStub('stub-bad-grafter', {
          yields: { ok: true },
          graft: [{ id: 'bad-grafter', designId: 'stub-bad-grafter', upstream: [] }],
        }),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'dup id graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run bad-grafter → engine-completed (graft queued)
      const r = await spider.crawl(); // process graft → validation fails → rig-completed/failed

      assert.equal(r?.action, 'rig-completed', 'should return rig-completed on graft failure');
      assert.equal((r as { outcome: string }).outcome, 'failed', 'outcome should be failed');

      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'bad-grafter');
      assert.ok(latestAttempt(failedEngine!)?.error?.includes('Duplicate engine id'), 'error should mention duplicate engine id');
    });

    it('fails originating engine when graft references unknown designId', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'grafter', designId: 'stub-grafter-unknown', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        'stub-grafter-unknown': graftingStub('stub-grafter-unknown', {
          yields: { ok: true },
          graft: [{ id: 'new-engine', designId: 'totally-unknown-design', upstream: ['grafter'] }],
        }),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'unknown designId graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run grafter → engine-completed
      const r = await spider.crawl(); // process graft → validation fails

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'failed');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'grafter');
      assert.ok(latestAttempt(failedEngine!)?.error?.includes('unknown designId'), 'error should mention unknown designId');
    });

    it('fails originating engine when graft creates a cycle', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'cycle-grafter', designId: 'stub-cycle-grafter', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        // Make a cycle among the grafted engines themselves: new1 ↔ new2
        'stub-cycle-grafter': graftingStub('stub-cycle-grafter', {
          yields: { ok: true },
          graft: [
            { id: 'new1', designId: 'stub-new1', upstream: ['new2'] },
            { id: 'new2', designId: 'stub-new2', upstream: ['new1'] },
          ],
        }),
        'stub-new1': clockworkStub('stub-new1'),
        'stub-new2': clockworkStub('stub-new2'),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'cycle graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run cycle-grafter → engine-completed
      const r = await spider.crawl(); // process graft → cycle detected → fail

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'failed');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'cycle-grafter');
      const failedErr = latestAttempt(failedEngine!)?.error;
      assert.ok(failedErr?.includes('cycle') || failedErr?.includes('Graft validation failed'), 'error should mention cycle');
    });

    it('fails originating engine when graft references a non-existent when engine', async () => {
      const template: RigTemplate = {
        engines: [{ id: 'grafter2', designId: 'stub-grafter2', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        'stub-grafter2': graftingStub('stub-grafter2', {
          yields: { ok: true },
          graft: [{
            id: 'new-engine',
            designId: 'stub-new-engine',
            upstream: ['grafter2'],
            when: '${yields.nonexistent.val}',
          }],
        }),
        'stub-new-engine': clockworkStub('stub-new-engine'),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'invalid when graft test', body: 'body' });
      await spider.crawl(); // spawn
      await spider.crawl(); // run grafter2 → engine-completed
      const r = await spider.crawl(); // process graft → when validation fails

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'failed');
      const [rig] = await rigsBook(stacks).list();
      assert.equal(rig.status, 'failed');
      assertTerminalAt(rig);
    });
  });

  // ── V11: maxEnginesPerRig ────────────────────────────────────────────

  describe('maxEnginesPerRig limit (V11)', () => {
    it('fails originating engine when graft would exceed maxEnginesPerRig', async () => {
      // maxEnginesPerRig=2; rig has 1 engine; graft adds 2 → total 3 > 2
      const template: RigTemplate = {
        engines: [{ id: 'grafter-max', designId: 'stub-grafter-max', givens: {} }],
      };
      const fix = buildWhenFixture(template, {
        'stub-grafter-max': graftingStub('stub-grafter-max', {
          yields: { ok: true },
          graft: [
            { id: 'extra1', designId: 'stub-extra-max', upstream: ['grafter-max'] },
            { id: 'extra2', designId: 'stub-extra-max', upstream: ['grafter-max'] },
          ],
        }),
        'stub-extra-max': clockworkStub('stub-extra-max'),
      }, { maxEnginesPerRig: 2 });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'maxEnginesPerRig test', body: 'body' });
      await spider.crawl(); // spawn (rig has 1 engine)
      await spider.crawl(); // run grafter-max → engine-completed (1 completed, graft queued for +2)
      const r = await spider.crawl(); // process graft → exceeds maxEnginesPerRig(2) → fail

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'failed');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'grafter-max');
      const failedErr = latestAttempt(failedEngine!)?.error;
      assert.ok(
        failedErr?.includes('maxEnginesPerRig') || failedErr?.includes('exceed'),
        `error should mention maxEnginesPerRig, got: ${failedErr}`,
      );
    });

    it('uses default maxEnginesPerRig of 50 when not configured', async () => {
      // Graft 50 new engines to a rig with 1 engine = 51 total (would exceed default 50)
      const template: RigTemplate = {
        engines: [{ id: 'big-grafter', designId: 'stub-big-grafter', givens: {} }],
      };
      const graft = Array.from({ length: 50 }, (_, i) => ({
        id: `extra-${i}`,
        designId: 'stub-extra-big',
        upstream: ['big-grafter'],
      }));

      const fix = buildWhenFixture(template, {
        // no maxEnginesPerRig spider config → default 50
        'stub-big-grafter': graftingStub('stub-big-grafter', { yields: {}, graft }),
        'stub-extra-big': clockworkStub('stub-extra-big'),
      });
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'default max test', body: 'body' });
      await spider.crawl(); // spawn (1 engine)
      await spider.crawl(); // run big-grafter → completed (graft of 50 queued → 51 total)
      const r = await spider.crawl(); // process graft → exceeds 50

      assert.equal(r?.action, 'rig-completed');
      assert.equal((r as { outcome: string }).outcome, 'failed');
      const [rig] = await rigsBook(stacks).list();
      const failedEngine = rig.engines.find((e: EngineInstance) => e.id === 'big-grafter');
      const failedErr = latestAttempt(failedEngine!)?.error;
      assert.ok(
        failedErr?.includes('maxEnginesPerRig') || failedErr?.includes('exceed'),
        `error should mention maxEnginesPerRig or exceed, got: ${failedErr}`,
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

      const mockAnimator: AnimatorApi = {
        summon(): AnimateHandle { throw new Error('summon not used'); },
        animate(): AnimateHandle { throw new Error('animate not used'); },
      };
      apparatusMap.set('animator', mockAnimator);

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

      // Yields were extracted correctly (not the whole { yields, graft } object)
      const book = rigsBook(stacks);
      const rigs = await book.list();
      const rig = rigs[0];
      const quickEngine = rig.engines.find((e: EngineInstance) => e.id === 'quick-grafting');
      assert.deepEqual(latestAttempt(quickEngine!)?.yields, { collected: true }, 'yields should be extracted from SpiderCollectResult');

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
    const retryTemplate: RigTemplate = {
      engines: [
        { id: 'implement',  designId: 'stub-impl',    givens: {} },
        { id: 'review-1',   designId: 'stub-review1', upstream: ['implement'] },
        { id: 'revise-1',   designId: 'stub-revise1', upstream: ['review-1'],  when: '!${yields.review-1.passed}' },
        { id: 'review-2',   designId: 'stub-review2', upstream: ['revise-1'],  when: '!${yields.review-1.passed}' },
        { id: 'seal',       designId: 'stub-seal',    upstream: ['review-1', 'review-2'] },
      ],
    };

    it('review-1 passes → review-2 and revise-1 skipped → seal runs', async () => {
      const fix = buildWhenFixture(retryTemplate, stubMap(
        ['stub-impl'],
        ['stub-review1', { passed: true }],
        ['stub-revise1'],
        ['stub-review2', { passed: true }],
        ['stub-seal',    { sealed: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'retry review-1 passes', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { 'revise-1': 'skipped', 'review-2': 'skipped', seal: 'completed' });
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
    });

    it('review-1 fails, review-2 passes → revise-1 and review-2 run → seal runs', async () => {
      const fix = buildWhenFixture(retryTemplate, stubMap(
        ['stub-impl'],
        ['stub-review1', { passed: false }],
        ['stub-revise1'],
        ['stub-review2', { passed: true }],
        ['stub-seal',    { sealed: true }],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'retry review-1 fails', body: 'body' });
      await drainToTerminal(spider);

      const [rig] = await rigsBook(stacks).list();
      assertStatuses(rig, { 'revise-1': 'completed', 'review-2': 'completed', seal: 'completed' });
      assert.equal(rig.status, 'completed');
      assertTerminalAt(rig);
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
      const fix = buildWhenFixture(template, stubMap(
        ['stub-a', { go: true }],
        ['stub-b'],
      ));
      const { clerk, spider, stacks } = fix;
      await clerk.post({ title: 'when field test', body: 'body' });
      await spider.crawl(); // spawn

      const [rig] = await rigsBook(stacks).list();
      const engineB = rig.engines.find((e: EngineInstance) => e.id === 'B');
      assert.equal(engineB?.when, '${yields.A.go}', 'when field should be copied to engine instance');
    });
  });
});
