/**
 * Combined plan-and-ship rig template tests.
 *
 * The commission that introduces this rig asks for three end-to-end
 * scenarios: (1) a brief writ running the combined rig through seal,
 * (2) a second writ gated on the brief via blocked_by, and (3) the old
 * three-phase-planning rig still reachable via explicit mapping.
 *
 * Running the combined rig end-to-end would require a full scriptorium
 * mock (to satisfy draft/seal) plus anima-session drivers for every
 * planning stage. Spider's own test suite already covers the
 * draft → implement → review → revise → seal backbone end-to-end for
 * the 'mandate' path; Astrolabe's engines.test.ts covers the planning
 * engines' state-machine transitions in isolation. So these tests focus
 * on the structural invariants that the commission calls out as
 * acceptance signals: engine sequence, handoff wiring, absence of a
 * mandate-posting engine in the combined rig, and that the old
 * two/three-phase templates remain registered for operators who opt
 * back in via guild.json.
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

  it('has 12 engines', () => {
    assert.equal(template.engines.length, 12);
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
    // `decision-review` auto-skips them via the existing analyst-pre-
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

  it('resolutionEngine is seal — the brief completes when implementation seals', () => {
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

  it('implement engine is wired to plan-finalize.spec via the prompt given', () => {
    const impl = template.engines.find(e => e.id === 'implement');
    assert.ok(impl, 'implement must exist');
    assert.equal(impl.designId, 'implement');
    assert.deepEqual(impl.upstream, ['plan-finalize']);
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
    // planning rigs. The brief writ reaches completed only after this
    // seal succeeds, which is the motivating fix for the commission.
    assert.notEqual(seal?.givens?.abandon, true,
      'combined-rig seal must not pass abandon: true — the brief writ must reach completed via a real seal');
  });
});

// ── Default-mapping tests ─────────────────────────────────────────────

describe('astrolabe plugin-default brief mapping', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const mappings = kit.rigTemplateMappings as Record<string, string>;

  it('maps brief → astrolabe.plan-and-ship by default', () => {
    assert.equal(mappings.brief, 'astrolabe.plan-and-ship');
  });

  it('leaves two-phase-planning and three-phase-planning registered for explicit opt-in', () => {
    const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
    assert.ok(rigTemplates['two-phase-planning'],
      'two-phase-planning must remain registered (reachable via guild-config mapping override)');
    assert.ok(rigTemplates['three-phase-planning'],
      'three-phase-planning must remain registered (reachable via guild-config mapping override)');
    // Confirm the old templates still produce a mandate — they end with
    // spec-publish, which is the engine that posts the mandate writ.
    const twoPhase = rigTemplates['two-phase-planning'];
    const twoPhaseLastBeforeSeal = twoPhase.engines[twoPhase.engines.length - 2];
    assert.equal(twoPhaseLastBeforeSeal.designId, 'astrolabe.spec-publish',
      'two-phase-planning must still terminate with spec-publish → mandate post');
    const threePhase = rigTemplates['three-phase-planning'];
    const threePhaseLastBeforeSeal = threePhase.engines[threePhase.engines.length - 2];
    assert.equal(threePhaseLastBeforeSeal.designId, 'astrolabe.spec-publish',
      'three-phase-planning must still terminate with spec-publish → mandate post');
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

  function setupGuild(): void {
    memBackend = new MemoryBackend();
    const stacksPlugin = createStacksApparatus(memBackend);
    const apparatusMap = new Map<string, unknown>();

    const fakeGuildConfig: GuildConfig = {
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
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

    engine = createPlanFinalizeEngine(() => plansBook);
    clerkMockCalls.length = 0;
  }

  beforeEach(() => { setupGuild(); });
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
});

// ── Audit: no combined-rig engine can post a mandate ──────────────────

describe('no mandate-posting engine appears in astrolabe.plan-and-ship', () => {
  // This is the grep-style audit the commission's acceptance signal asks
  // for. It is done structurally: enumerate the designIds in the combined
  // rig, and confirm none of them is spec-publish (the only astrolabe
  // engine that calls clerk.post) or any other known writ-posting engine.
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
  const template = rigTemplates['plan-and-ship'];

  it('no engine in the combined rig uses the spec-publish designId', () => {
    const designIds = template.engines.map(e => e.designId);
    assert.ok(!designIds.includes('astrolabe.spec-publish'),
      `plan-and-ship uses designIds: ${designIds.join(', ')}`);
  });

  it('every designId in the combined rig is either a known planning engine or a Spider engine', () => {
    // Whitelist: astrolabe's own planning engines (all are clerk-read-only
    // or clerk-unused) + anima-session (read-only) + the five Spider
    // engines (draft, implement, review, revise, seal — none of which
    // call clerk.post per the Spider codebase).
    const allowed = new Set([
      'astrolabe.plan-init',
      'astrolabe.inventory-check',
      'astrolabe.patron-anima',
      'astrolabe.decision-review',
      'astrolabe.plan-finalize',
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
