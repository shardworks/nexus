/**
 * planning-mra template and brief-mra writ type registration tests.
 *
 * Verifies the experimental merged reader/analyst rig template is correctly
 * registered alongside the production planning template without modifying it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAstrolabe } from './astrolabe.ts';

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

// ── Tests ─────────────────────────────────────────────────────────────

describe('planning-mra rig template registration', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, {
    engines: Array<{ id: string; designId: string; upstream?: string[]; givens?: Record<string, unknown> }>;
    resolutionEngine?: string;
  }>;

  it('planning-mra is registered as a rig template', () => {
    assert.ok(rigTemplates?.['planning-mra'], 'planning-mra template must exist');
  });

  it('production planning template is unchanged', () => {
    assert.ok(rigTemplates?.planning, 'planning template must still exist');
    const planningEngineIds = rigTemplates.planning.engines.map(e => e.id);
    assert.deepEqual(planningEngineIds, [
      'plan-init',
      'draft',
      'reader',
      'inventory-check',
      'analyst',
      'decision-review',
      'spec-writer',
      'spec-publish',
      'seal',
    ]);
    assert.equal(rigTemplates.planning.resolutionEngine, 'spec-writer');
  });

  it('planning-mra engine list matches spec: plan-init -> draft -> reader-analyst -> inventory-check -> decision-review -> spec-writer -> spec-publish -> seal', () => {
    const engineIds = rigTemplates['planning-mra'].engines.map(e => e.id);
    assert.deepEqual(engineIds, [
      'plan-init',
      'draft',
      'reader-analyst',
      'inventory-check',
      'decision-review',
      'spec-writer',
      'spec-publish',
      'seal',
    ]);
  });

  it('planning-mra has 8 engines (one fewer than planning)', () => {
    assert.equal(rigTemplates['planning-mra'].engines.length, 8);
    assert.equal(rigTemplates.planning.engines.length, 9);
  });

  it('planning-mra resolutionEngine is spec-writer', () => {
    assert.equal(rigTemplates['planning-mra'].resolutionEngine, 'spec-writer');
  });

  it('reader-analyst stage uses anima-session designId', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    assert.ok(ra, 'reader-analyst engine must exist');
    assert.equal(ra.designId, 'anima-session');
  });

  it('reader-analyst stage uses astrolabe.sage role', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.role, 'astrolabe.sage');
  });

  it('reader-analyst prompt contains MODE: READER-ANALYST', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    const prompt = ra?.givens?.prompt as string;
    assert.ok(prompt.includes('MODE: READER-ANALYST'), 'prompt must include mode');
  });

  it('reader-analyst prompt includes planId interpolation', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    const prompt = ra?.givens?.prompt as string;
    assert.ok(
      prompt.includes('${yields.plan-init.planId}'),
      'prompt must include planId interpolation',
    );
  });

  it('reader-analyst has no conversationId (fresh session)', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.conversationId, undefined);
  });

  it('reader-analyst emits metadata.engineId for profiling', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    const metadata = ra?.givens?.metadata as { engineId: string } | undefined;
    assert.ok(metadata, 'metadata must be set');
    assert.equal(metadata.engineId, 'reader-analyst');
  });

  it('reader-analyst has writ given', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.writ, '${writ}');
  });

  it('reader-analyst has cwd given from draft', () => {
    const ra = rigTemplates['planning-mra'].engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.cwd, '${yields.draft.path}');
  });

  it('inventory-check is upstream of decision-review (no analyst in between)', () => {
    const dr = rigTemplates['planning-mra'].engines.find(e => e.id === 'decision-review');
    assert.deepEqual(dr?.upstream, ['inventory-check']);
  });

  it('inventory-check is downstream of reader-analyst', () => {
    const ic = rigTemplates['planning-mra'].engines.find(e => e.id === 'inventory-check');
    assert.deepEqual(ic?.upstream, ['reader-analyst']);
  });

  it('spec-writer in planning-mra does not chain conversationId from analyst', () => {
    const sw = rigTemplates['planning-mra'].engines.find(e => e.id === 'spec-writer');
    assert.equal(sw?.givens?.conversationId, undefined,
      'spec-writer should start a fresh session (no analyst conversationId to continue)');
  });

  it('spec-writer prompt includes decisionSummary interpolation', () => {
    const sw = rigTemplates['planning-mra'].engines.find(e => e.id === 'spec-writer');
    const prompt = sw?.givens?.prompt as string;
    assert.ok(
      prompt.includes('${yields.decision-review.decisionSummary}'),
      'spec-writer prompt must include decisionSummary interpolation',
    );
  });

  it('all shared engines use same designIds as production template', () => {
    const shared = ['plan-init', 'draft', 'inventory-check', 'decision-review', 'spec-publish', 'seal'];
    for (const id of shared) {
      const prod = rigTemplates.planning.engines.find(e => e.id === id);
      const mra = rigTemplates['planning-mra'].engines.find(e => e.id === id);
      assert.ok(prod, `production template must have ${id}`);
      assert.ok(mra, `planning-mra template must have ${id}`);
      assert.equal(mra.designId, prod.designId,
        `${id} designId must match between templates`);
    }
  });
});

describe('brief-mra writ type registration', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);

  it('brief-mra is registered as a writ type', () => {
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    const briefMra = writTypes.find(w => w.name === 'brief-mra');
    assert.ok(briefMra, 'brief-mra writ type must exist');
    assert.ok(briefMra.description, 'brief-mra must have a description');
  });

  it('brief-mra maps to astrolabe.planning-mra', () => {
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings['brief-mra'], 'astrolabe.planning-mra');
  });

  it('production brief mapping is unchanged', () => {
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings.brief, 'astrolabe.planning');
  });

  it('production brief writ type is unchanged', () => {
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    const brief = writTypes.find(w => w.name === 'brief');
    assert.ok(brief, 'brief writ type must still exist');
  });
});

describe('decision-review compatibility with planning-mra', () => {
  // Verify decision-review has no implicit assumptions about separate
  // reader and analyst sessions. This is a structural check — the engine
  // only reads plan.status and plan.decisions/scope from the PlanDoc.

  it('decision-review engine does not reference conversationId in its design', () => {
    // decision-review's givens in planning-mra only need planId,
    // same as in the production template.
    const plugin = createAstrolabe();
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;

    const drProd = rigTemplates.planning.engines.find(e => e.id === 'decision-review');
    const drMra = rigTemplates['planning-mra'].engines.find(e => e.id === 'decision-review');

    // Both templates pass only planId to decision-review
    assert.deepEqual(drProd?.givens, drMra?.givens,
      'decision-review givens must be identical in both templates');
  });

  it('inventory-check givens are identical in both templates', () => {
    const plugin = createAstrolabe();
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;

    const icProd = rigTemplates.planning.engines.find(e => e.id === 'inventory-check');
    const icMra = rigTemplates['planning-mra'].engines.find(e => e.id === 'inventory-check');

    assert.deepEqual(icProd?.givens, icMra?.givens,
      'inventory-check givens must be identical in both templates');
  });
});
