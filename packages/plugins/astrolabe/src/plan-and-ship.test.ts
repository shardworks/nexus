/**
 * Combined plan-and-ship rig template tests.
 *
 * These tests pin the structural invariants of the (now sole) planning
 * rig `astrolabe.plan-and-ship`: engine sequence, handoff wiring, and
 * the absence of any mandate-posting engine. The retired two-phase and
 * three-phase planning rigs — and the `astrolabe.spec-publish` engine
 * that only they used — have been removed from the registry; the
 * negative assertions below guard against regressions that would
 * silently re-register them.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, StartupContext } from '@shardworks/nexus-core';
import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi, Book } from '@shardworks/stacks-apparatus';
import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

import { createAstrolabe } from './astrolabe.ts';
import { createPlanFinalizeEngine } from './engines/index.ts';
import type { PlanDoc } from './types.ts';

// ── Helpers ───────────────────────────────────────────────────────────

type AnyApparatus = {
  apparatus: {
    supportKit?: Record<string, unknown>;
  };
};

function getKit(plugin: unknown): Record<string, unknown> {
  const kit = (plugin as AnyApparatus).apparatus.supportKit;
  assert.ok(kit, 'supportKit must be defined');
  return kit;
}

type TemplateEngine = {
  id: string;
  designId: string;
  upstream?: string[];
  givens?: Record<string, unknown>;
};

type RigTemplateShape = {
  engines: TemplateEngine[];
  resolutionEngine?: string;
};

// ── Shape / wiring tests ──────────────────────────────────────────────

describe('astrolabe.plan-and-ship rig template — shape and wiring', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
  const template = rigTemplates['plan-and-ship'];

  it('is registered under the plan-and-ship key', () => {
    assert.ok(template, 'plan-and-ship template must exist');
  });

  it('has 13 engines', () => {
    assert.equal(template.engines.length, 13);
  });

  it('engine sequence matches the commission spec', () => {
    assert.deepEqual(
      template.engines.map(e => e.id),
      [
        'plan-init',
        'draft',
        'reader-analyst',
        'inventory-check',
        'patron-anima',
        'decision-review',
        'spec-writer',
        'plan-finalize',
        'observation-lift',
        'implement',
        'review',
        'revise',
        'seal',
      ],
    );
  });

  it('patron-anima sits between inventory-check and decision-review', () => {
    // Anchors the commission's non-negotiable pipeline position for the
    // Patron Anima: it pre-fills reviewable decisions on the PlanDoc so
    // `decision-review` auto-skips them via the existing primer-pre-
    // decides fast path.
    const pa = template.engines.find(e => e.id === 'patron-anima');
    assert.ok(pa, 'patron-anima engine must exist');
    assert.equal(pa.designId, 'astrolabe.patron-anima');
    assert.deepEqual(pa.upstream, ['inventory-check']);
    assert.equal(pa.givens?.planId, '${yields.plan-init.planId}');

    const dr = template.engines.find(e => e.id === 'decision-review');
    assert.ok(dr, 'decision-review engine must exist');
    assert.deepEqual(
      dr.upstream, ['patron-anima'],
      'decision-review must sit downstream of patron-anima so the anima\'s fills reach the reconcile pass',
    );
  });

  it('resolutionEngine is seal — the mandate completes when implementation seals', () => {
    assert.equal(template.resolutionEngine, 'seal');
  });

  it('uses a single shared draft engine (no second draft after plan-finalize)', () => {
    const draftEngines = template.engines.filter(e => e.designId === 'draft');
    assert.equal(draftEngines.length, 1, 'only one draft engine in the pipeline');
    assert.equal(draftEngines[0].id, 'draft');
  });

  it('every post-draft engine reads upstream["draft"] by id', () => {
    // Verify the shared-draft-engine contract: downstream engines that
    // need the worktree path interpolate ${yields.draft.path} (reader-
    // analyst, spec-writer), and the spider engines (implement, review,
    // revise, seal) consume context.upstream['draft'] by literal key —
    // which requires the draft engine's id to be exactly 'draft'.
    const readerAnalyst = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(readerAnalyst?.givens?.cwd, '${yields.draft.path}');
    const specWriter = template.engines.find(e => e.id === 'spec-writer');
    assert.equal(specWriter?.givens?.cwd, '${yields.draft.path}');
  });

  it('does NOT include the spec-publish engine (no mandate posted by this rig)', () => {
    const ids = template.engines.map(e => e.designId);
    assert.ok(!ids.includes('astrolabe.spec-publish'),
      'spec-publish must not appear — the mandate-posting engine is the marker the combined rig deliberately drops');
  });

  it('plan-finalize sits immediately after spec-writer', () => {
    const pf = template.engines.find(e => e.id === 'plan-finalize');
    assert.ok(pf, 'plan-finalize must exist');
    assert.equal(pf.designId, 'astrolabe.plan-finalize');
    assert.deepEqual(pf.upstream, ['spec-writer']);
    assert.equal(pf.givens?.planId, '${yields.plan-init.planId}');
  });

  it('observation-lift sits between plan-finalize and implement', () => {
    // observation-lift lifts plan.observations into draft top-level writs
    // with an astrolabe.lifted-from edge back to the originating mandate.
    // Placement: the plan has reached `completed` (via plan-finalize) but
    // the mandate writ is still `open`, so the spider.follows gate the
    // engine installs on each lifted writ is well-formed.
    const ol = template.engines.find(e => e.id === 'observation-lift');
    assert.ok(ol, 'observation-lift engine must exist');
    assert.equal(ol.designId, 'astrolabe.observation-lift');
    assert.deepEqual(ol.upstream, ['plan-finalize']);
    assert.equal(ol.givens?.planId, '${yields.plan-init.planId}');
  });

  it('implement engine is wired to plan-finalize.spec via the prompt given', () => {
    const impl = template.engines.find(e => e.id === 'implement');
    assert.ok(impl, 'implement must exist');
    assert.equal(impl.designId, 'implement');
    // implement runs after observation-lift, which runs after plan-finalize.
    assert.deepEqual(impl.upstream, ['observation-lift']);
    // The handoff: plan-finalize yields `spec`, the implement engine reads
    // it via the new optional `prompt` given.
    assert.equal(impl.givens?.prompt, '${yields.plan-finalize.spec}');
    // And the role comes from spider.variables.role with no fallback (D7).
    assert.equal(impl.givens?.role, '${vars.role}');
    assert.equal(impl.givens?.writ, '${writ}');
  });

  it('review, revise, and seal preserve the standard mandate backbone', () => {
    const review = template.engines.find(e => e.id === 'review');
    assert.deepEqual(review?.upstream, ['implement']);
    assert.equal(review?.givens?.buildCommand, '${vars.buildCommand}');
    assert.equal(review?.givens?.testCommand, '${vars.testCommand}');

    const revise = template.engines.find(e => e.id === 'revise');
    assert.deepEqual(revise?.upstream, ['review']);
    assert.equal(revise?.givens?.role, '${vars.role}');

    const seal = template.engines.find(e => e.id === 'seal');
    assert.deepEqual(seal?.upstream, ['revise']);
    // The seal is real — not an abandon seal like the two/three-phase
    // planning rigs. The mandate writ reaches completed only after this
    // seal succeeds, which is the motivating fix for the commission.
    assert.notEqual(seal?.givens?.abandon, true,
      'combined-rig seal must not pass abandon: true — the mandate writ must reach completed via a real seal');
  });
});

// ── Default-mapping tests ─────────────────────────────────────────────

describe('astrolabe plugin-default mandate mapping', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const mappings = kit.rigTemplateMappings as Record<string, string>;

  it('maps mandate → astrolabe.plan-and-ship by default', () => {
    assert.equal(mappings.mandate, 'astrolabe.plan-and-ship');
    assert.equal(mappings.brief, undefined, 'brief mapping must not be contributed');
  });

  it('does not register the retired two-phase-planning or three-phase-planning templates', () => {
    const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
    assert.equal(rigTemplates['two-phase-planning'], undefined,
      'two-phase-planning must be unregistered — the retirement commission removed it');
    assert.equal(rigTemplates['three-phase-planning'], undefined,
      'three-phase-planning must be unregistered — the retirement commission removed it');
  });

  it('plan-and-ship is the only rig template astrolabe contributes', () => {
    const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
    assert.deepEqual(Object.keys(rigTemplates).sort(), ['plan-and-ship']);
  });
});

// ── plan-finalize engine tests ────────────────────────────────────────

describe('plan-finalize engine', () => {
  let stacks: StacksApi;
  let plansBook: Book<PlanDoc>;
  let memBackend: MemoryBackend;
  let engine: ReturnType<typeof createPlanFinalizeEngine>;

  // clerk mock — must be present because the fake guild expects it, even
  // though the engine itself must not call it. Any call here fails the test.
  const clerkMockCalls: Array<{ method: string; args: unknown[] }> = [];
  const mockClerkApi = {
    show: async (..._args: unknown[]) => {
      clerkMockCalls.push({ method: 'show', args: _args });
      throw new Error('plan-finalize must not call clerk.show');
    },
    post: async (..._args: unknown[]) => {
      clerkMockCalls.push({ method: 'post', args: _args });
      throw new Error('plan-finalize must not call clerk.post');
    },
    link: async (..._args: unknown[]) => {
      clerkMockCalls.push({ method: 'link', args: _args });
      throw new Error('plan-finalize must not call clerk.link');
    },
    transition: async (..._args: unknown[]) => {
      clerkMockCalls.push({ method: 'transition', args: _args });
      throw new Error('plan-finalize must not call clerk.transition');
    },
    list: async () => [],
    count: async () => 0,
    links: async () => ({ outbound: [], inbound: [] }),
    unlink: async () => {},
  };

  // Clockworks mock — installed when a test wires it. Records every emit
  // for assertion. The `failNext` toggle simulates an emit error so we can
  // verify best-effort `console.warn` behaviour and patch durability.
  type EmitCall = { name: string; payload: unknown; emitter: string };
  const clockworksEmitCalls: EmitCall[] = [];
  let clockworksFailNextEmit = false;
  const mockClockworksApi = {
    emit: async (name: string, payload: unknown, emitter: string): Promise<string> => {
      clockworksEmitCalls.push({ name, payload, emitter });
      if (clockworksFailNextEmit) {
        clockworksFailNextEmit = false;
        throw new Error('simulated clockworks emit failure');
      }
      return `e-fake-${clockworksEmitCalls.length}`;
    },
    resolveRelay: () => undefined,
  };

  function buildStartupCtx(): StartupContext {
    return { on() {}, kits() { return []; } };
  }

  function buildRunCtx(): EngineRunContext {
    return {
      rigId: 'rig-pf-001',
      engineId: 'plan-finalize',
      upstream: {},
    };
  }

  interface SetupOptions {
    /** Astrolabe-scoped guildConfig overrides (e.g. predictedFilesThreshold). */
    astrolabeConfig?: { predictedFilesThreshold?: unknown };
    /** When true, register the Clockworks mock under the apparatus map. */
    withClockworks?: boolean;
  }

  function setupGuild(options: SetupOptions = {}): void {
    memBackend = new MemoryBackend();
    const stacksPlugin = createStacksApparatus(memBackend);
    const apparatusMap = new Map<string, unknown>();

    const fakeGuildConfig: GuildConfig = {
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
      ...(options.astrolabeConfig
        ? { astrolabe: options.astrolabeConfig as Record<string, unknown> }
        : {}),
    };

    const fakeGuild: Guild = {
      home: '/tmp/fake-guild',
      apparatus<T>(name: string): T {
        const a = apparatusMap.get(name);
        if (!a) throw new Error(`Apparatus "${name}" not installed`);
        return a as T;
      },
      config<T>(_pluginId: string): T { return {} as T; },
      writeConfig() {},
      guildConfig() { return fakeGuildConfig; },
      kits: () => [],
      apparatuses: () => [],
      failedPlugins: () => [],
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    const stacksApparatus = (stacksPlugin as {
      apparatus: { start: (ctx: StartupContext) => void; provides: unknown };
    }).apparatus;
    stacksApparatus.start(buildStartupCtx());
    stacks = stacksApparatus.provides as StacksApi;
    apparatusMap.set('stacks', stacks);

    memBackend.ensureBook({ ownerId: 'astrolabe', book: 'plans' }, {
      indexes: ['status', 'codex', 'createdAt'],
    });

    plansBook = stacks.book<PlanDoc>('astrolabe', 'plans');
    apparatusMap.set('clerk', mockClerkApi);

    if (options.withClockworks) {
      apparatusMap.set('clockworks', mockClockworksApi);
    }

    engine = createPlanFinalizeEngine(() => plansBook);
    clerkMockCalls.length = 0;
    clockworksEmitCalls.length = 0;
    clockworksFailNextEmit = false;
  }

  beforeEach(() => { setupGuild({ withClockworks: true }); });
  afterEach(() => { clearGuild(); });

  it('yields spec, patches plan to completed, and does NOT post any writ or link', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-1',
      codex: 'test-codex',
      status: 'writing',
      spec: '# Specification\n\nImplementation details here.',
      createdAt: now,
      updatedAt: now,
    });

    const result = await engine.run({ planId: 'w-pf-1' }, buildRunCtx());

    assert.equal(result.status, 'completed');
    assert.deepEqual(
      (result as { status: 'completed'; yields: { spec: string } }).yields,
      { spec: '# Specification\n\nImplementation details here.' },
    );

    const patched = await plansBook.get('w-pf-1');
    assert.equal(patched?.status, 'completed');

    // The critical invariant: no clerk interaction happened.
    assert.deepEqual(clerkMockCalls, [],
      'plan-finalize must not call any clerk method — no mandate, no link, nothing');
  });

  it('throws when status is not "writing"', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-wrong-status',
      codex: 'test-codex',
      status: 'analyzing',
      spec: 'some spec',
      createdAt: now,
      updatedAt: now,
    });

    await assert.rejects(
      engine.run({ planId: 'w-pf-wrong-status' }, buildRunCtx()),
      /expected plan status "writing" but got "analyzing"/,
    );
  });

  it('throws when spec is missing or empty (fails loud, does not yield empty)', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-no-spec',
      codex: 'test-codex',
      status: 'writing',
      createdAt: now,
      updatedAt: now,
    });
    await assert.rejects(
      engine.run({ planId: 'w-pf-no-spec' }, buildRunCtx()),
      /has no spec/,
    );

    await plansBook.put({
      id: 'w-pf-empty-spec',
      codex: 'test-codex',
      status: 'writing',
      spec: '',
      createdAt: now,
      updatedAt: now,
    });
    await assert.rejects(
      engine.run({ planId: 'w-pf-empty-spec' }, buildRunCtx()),
      /has no spec/,
    );
  });

  it('throws when the plan does not exist', async () => {
    await assert.rejects(
      engine.run({ planId: 'w-does-not-exist' }, buildRunCtx()),
      /Plan "w-does-not-exist" not found/,
    );
  });

  // ── Predicted-files count + soft-warn emission ──────────────────────

  /**
   * Builds a spec containing a `<task-manifest>` with N distinct path
   * tokens spread across one task per path. Tokens are deterministic so
   * the assertions can compare exact counts.
   */
  function specWithNPaths(n: number): string {
    const files = Array.from({ length: n }, (_, i) => `<files>packages/zone/file-${i + 1}.ts</files>`);
    return `# Spec\n\n<task-manifest>\n  <task id="t1">\n    ${files.join('\n    ')}\n  </task>\n</task-manifest>\n`;
  }

  it('records manifestFilesCount: N when the manifest has N distinct paths', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-count',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(7),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-count' }, buildRunCtx());

    const patched = await plansBook.get('w-pf-count');
    assert.equal(patched?.status, 'completed');
    assert.equal(patched?.manifestFilesCount, 7);
  });

  it('records manifestFilesCount: 0 when the spec contains no <task-manifest>', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-no-manifest',
      codex: 'test-codex',
      status: 'writing',
      spec: '# Spec\n\nNo manifest in this one.',
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-no-manifest' }, buildRunCtx());

    const patched = await plansBook.get('w-pf-no-manifest');
    assert.equal(patched?.status, 'completed');
    assert.equal(patched?.manifestFilesCount, 0);
    // No emission for zero counts.
    assert.equal(clockworksEmitCalls.length, 0);
  });

  it('emits exactly one files-over-threshold event when count strictly exceeds the default threshold of 15', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-over',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(20),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-over' }, buildRunCtx());

    // The patch landed first.
    const patched = await plansBook.get('w-pf-over');
    assert.equal(patched?.status, 'completed');
    assert.equal(patched?.manifestFilesCount, 20);

    // Exactly one emission with the prescribed payload.
    assert.equal(clockworksEmitCalls.length, 1);
    assert.equal(clockworksEmitCalls[0].name, 'astrolabe.plan.files-over-threshold');
    assert.equal(clockworksEmitCalls[0].emitter, 'framework');
    assert.deepEqual(clockworksEmitCalls[0].payload, {
      planId: 'w-pf-over',
      count: 20,
      threshold: 15,
    });
  });

  it('does NOT emit when count is exactly at the threshold (strict greater-than per D9)', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-at',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(15),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-at' }, buildRunCtx());

    const patched = await plansBook.get('w-pf-at');
    assert.equal(patched?.manifestFilesCount, 15);
    assert.equal(clockworksEmitCalls.length, 0);
  });

  it('does NOT emit when count is below the threshold', async () => {
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-below',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(5),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-below' }, buildRunCtx());

    const patched = await plansBook.get('w-pf-below');
    assert.equal(patched?.manifestFilesCount, 5);
    assert.equal(clockworksEmitCalls.length, 0);
  });

  it('honours a custom predictedFilesThreshold from guild.json', async () => {
    // Re-setup with a custom threshold of 3 — and Clockworks installed.
    clearGuild();
    setupGuild({
      withClockworks: true,
      astrolabeConfig: { predictedFilesThreshold: 3 },
    });

    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-custom',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(5),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-custom' }, buildRunCtx());

    assert.equal(clockworksEmitCalls.length, 1);
    assert.deepEqual(clockworksEmitCalls[0].payload, {
      planId: 'w-pf-custom',
      count: 5,
      threshold: 3,
    });
  });

  it('throws fail-loud when predictedFilesThreshold is malformed', async () => {
    // Re-setup with a malformed threshold (negative).
    clearGuild();
    setupGuild({
      withClockworks: true,
      astrolabeConfig: { predictedFilesThreshold: -1 },
    });

    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-malformed',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(20),
      createdAt: now,
      updatedAt: now,
    });

    await assert.rejects(
      engine.run({ planId: 'w-pf-malformed' }, buildRunCtx()),
      /predictedFilesThreshold must be a positive integer/,
    );
  });

  it('completes successfully when Clockworks is not installed (soft-dep contract)', async () => {
    // Re-setup without the clockworks mock in the apparatus map.
    clearGuild();
    setupGuild({ withClockworks: false });

    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-no-cw',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(20), // would emit if clockworks were installed
      createdAt: now,
      updatedAt: now,
    });

    const result = await engine.run({ planId: 'w-pf-no-cw' }, buildRunCtx());

    assert.equal(result.status, 'completed');
    const patched = await plansBook.get('w-pf-no-cw');
    assert.equal(patched?.status, 'completed');
    assert.equal(patched?.manifestFilesCount, 20);
    // Without Clockworks there is no event sink — but the engine must not
    // throw nor leave the plan in an inconsistent state.
    assert.equal(clockworksEmitCalls.length, 0);
  });

  it('does not roll back the patch when a Clockworks emit fails (best-effort)', async () => {
    // Capture console.warn so we can assert the breadcrumb fired.
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(a => String(a)).join(' '));
    };

    try {
      clockworksFailNextEmit = true;

      const now = new Date().toISOString();
      await plansBook.put({
        id: 'w-pf-emit-fail',
        codex: 'test-codex',
        status: 'writing',
        spec: specWithNPaths(20),
        createdAt: now,
        updatedAt: now,
      });

      // Engine must not throw despite the emit failure.
      const result = await engine.run({ planId: 'w-pf-emit-fail' }, buildRunCtx());
      assert.equal(result.status, 'completed');

      // Patch still applied — the emit failure does not roll it back.
      const patched = await plansBook.get('w-pf-emit-fail');
      assert.equal(patched?.status, 'completed');
      assert.equal(patched?.manifestFilesCount, 20);

      // The emit was attempted exactly once (the throw counts as a call).
      assert.equal(clockworksEmitCalls.length, 1);

      // Breadcrumb fired with the [astrolabe] tag and the failure reason.
      assert.equal(warnCalls.length, 1);
      assert.match(warnCalls[0], /\[astrolabe\]/);
      assert.match(warnCalls[0], /astrolabe\.plan\.files-over-threshold/);
      assert.match(warnCalls[0], /simulated clockworks emit failure/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('preserves the no-clerk-call invariant across the new emission paths', async () => {
    // Run the over-threshold emission path and re-check that no clerk
    // method was invoked. Belt-and-braces: the emission introduces no new
    // Clerk dependency.
    const now = new Date().toISOString();
    await plansBook.put({
      id: 'w-pf-no-clerk',
      codex: 'test-codex',
      status: 'writing',
      spec: specWithNPaths(20),
      createdAt: now,
      updatedAt: now,
    });

    await engine.run({ planId: 'w-pf-no-clerk' }, buildRunCtx());

    assert.deepEqual(clerkMockCalls, [],
      'plan-finalize must not call any clerk method even when emitting events');
  });
});

// ── Audit: no combined-rig engine can post a mandate ──────────────────

describe('no mandate-posting engine appears in astrolabe.plan-and-ship', () => {
  // This is a grep-style audit: enumerate the designIds in the combined
  // rig, and confirm none of them is the retired spec-publish engine (the
  // only astrolabe engine that ever called clerk.post for a mandate) or
  // any other unknown writ-posting engine.
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
  const template = rigTemplates['plan-and-ship'];

  it('no engine in the combined rig uses the retired spec-publish designId', () => {
    const designIds = template.engines.map(e => e.designId);
    assert.ok(!designIds.includes('astrolabe.spec-publish'),
      `plan-and-ship uses designIds: ${designIds.join(', ')}`);
  });

  it('every designId in the combined rig is either a known planning engine or a Spider engine', () => {
    // Whitelist: astrolabe's own planning engines (all are clerk-read-only
    // or clerk-unused), including the astrolabe-owned reader-analyst that
    // replaces the generic anima-session for that slot + the spec-writer's
    // anima-session (read-only) + the observation-lift engine (posts draft
    // top-level observation writs plus an optional observation-set container,
    // none of which are mandates dispatched by this rig) + the five Spider
    // engines (draft, implement, review, revise, seal — none of which call
    // clerk.post per the Spider codebase).
    const allowed = new Set([
      'astrolabe.plan-init',
      'astrolabe.inventory-check',
      'astrolabe.reader-analyst',
      'astrolabe.patron-anima',
      'astrolabe.decision-review',
      'astrolabe.plan-finalize',
      'astrolabe.observation-lift',
      'anima-session',
      'draft',
      'implement',
      'review',
      'revise',
      'seal',
    ]);
    for (const e of template.engines) {
      assert.ok(allowed.has(e.designId),
        `engine "${e.id}" has designId "${e.designId}" which is not on the mandate-post-safe allowlist`);
    }
  });
});
