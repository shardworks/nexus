/**
 * Two-phase planning rig template tests.
 *
 * Verifies engine count, order, role assignments, prompt content,
 * metadata, givens, and designId consistency with three-phase-planning.
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

// ── Tests ─────────────────────────────────────────────────────────────

describe('two-phase-planning rig template', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
  const template = rigTemplates['two-phase-planning'];

  it('two-phase-planning is registered as a rig template', () => {
    assert.ok(template, 'two-phase-planning template must exist');
  });

  it('has 8 engines', () => {
    assert.equal(template.engines.length, 8);
  });

  it('engine list: plan-init → draft → reader-analyst → inventory-check → decision-review → spec-writer → spec-publish → seal', () => {
    const engineIds = template.engines.map(e => e.id);
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

  it('resolutionEngine is spec-writer', () => {
    assert.equal(template.resolutionEngine, 'spec-writer');
  });

  // ── reader-analyst stage ──────────────────────────────────────────

  it('reader-analyst uses astrolabe.reader-analyst designId', () => {
    // The reader-analyst slot is driven by the astrolabe-owned
    // astrolabe.reader-analyst engine, not the generic anima-session
    // engine — the engine chooses the primer variant at run time from
    // live guild config.
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.designId, 'astrolabe.reader-analyst');
  });

  it('reader-analyst has no hardcoded role given', () => {
    // The astrolabe.reader-analyst engine chooses the primer role itself
    // (sage-primer-attended vs sage-primer-solo) by reading
    // astrolabe.patronRole at engine-run time. Hardcoding a role in the
    // rig would defeat that — assert it is absent.
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.role, undefined,
      'reader-analyst must not have a hardcoded role given — the engine resolves it');
  });

  it('reader-analyst prompt contains planId interpolation', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    const prompt = ra?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.plan-init.planId}'));
  });

  it('reader-analyst prompt does NOT contain MODE:', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    const prompt = ra?.givens?.prompt as string;
    assert.ok(!prompt.includes('MODE:'));
  });

  it('reader-analyst has metadata.engineId = reader-analyst', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    const metadata = ra?.givens?.metadata as { engineId: string } | undefined;
    assert.ok(metadata, 'metadata must be set');
    assert.equal(metadata.engineId, 'reader-analyst');
  });

  it('reader-analyst has writ given', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.writ, '${writ}');
  });

  it('reader-analyst has cwd given from draft', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.cwd, '${yields.draft.path}');
  });

  it('reader-analyst has no conversationId', () => {
    const ra = template.engines.find(e => e.id === 'reader-analyst');
    assert.equal(ra?.givens?.conversationId, undefined);
  });

  // ── spec-writer stage ─────────────────────────────────────────────

  it('spec-writer uses astrolabe.sage-writer role', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    assert.equal(sw?.givens?.role, 'astrolabe.sage-writer');
  });

  it('spec-writer prompt contains planId interpolation', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    const prompt = sw?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.plan-init.planId}'));
  });

  it('spec-writer prompt contains decisionSummary interpolation', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    const prompt = sw?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.decision-review.decisionSummary}'));
  });

  it('spec-writer prompt does NOT contain MODE:', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    const prompt = sw?.givens?.prompt as string;
    assert.ok(!prompt.includes('MODE:'));
  });

  it('spec-writer has metadata.engineId = spec-writer', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    const metadata = sw?.givens?.metadata as { engineId: string } | undefined;
    assert.ok(metadata, 'metadata must be set');
    assert.equal(metadata.engineId, 'spec-writer');
  });

  it('spec-writer has no conversationId', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    assert.equal(sw?.givens?.conversationId, undefined);
  });

  // ── upstream wiring ───────────────────────────────────────────────

  it('inventory-check is downstream of reader-analyst', () => {
    const ic = template.engines.find(e => e.id === 'inventory-check');
    assert.deepEqual(ic?.upstream, ['reader-analyst']);
  });

  it('decision-review is downstream of inventory-check', () => {
    const dr = template.engines.find(e => e.id === 'decision-review');
    assert.deepEqual(dr?.upstream, ['inventory-check']);
  });

  // ── cross-template consistency ────────────────────────────────────

  it('all shared engines use same designIds as three-phase-planning', () => {
    const threePhase = rigTemplates['three-phase-planning'];
    assert.ok(threePhase, 'three-phase-planning template must exist');

    // reader-analyst is intentionally excluded from the shared set: the
    // two-phase rig uses the astrolabe.reader-analyst engine (primer-
    // variant-aware), while three-phase-planning keeps its split
    // reader / analyst stages on the generic anima-session engine.
    const shared = ['plan-init', 'draft', 'inventory-check', 'decision-review', 'spec-publish', 'seal'];
    for (const id of shared) {
      const two = template.engines.find(e => e.id === id);
      const three = threePhase.engines.find(e => e.id === id);
      assert.ok(two, `two-phase must have ${id}`);
      assert.ok(three, `three-phase must have ${id}`);
      assert.equal(two.designId, three.designId,
        `${id} designId must match between templates`);
    }
  });
});
