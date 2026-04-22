/**
 * Three-phase planning rig template tests.
 *
 * Verifies engine count, order, role assignments, prompt content,
 * metadata, givens, and absence of conversationId chaining.
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

describe('three-phase-planning rig template', () => {
  const plugin = createAstrolabe();
  const kit = getKit(plugin);
  const rigTemplates = kit.rigTemplates as Record<string, RigTemplateShape>;
  const template = rigTemplates['three-phase-planning'];

  it('three-phase-planning is registered as a rig template', () => {
    assert.ok(template, 'three-phase-planning template must exist');
  });

  it('has 9 engines', () => {
    assert.equal(template.engines.length, 9);
  });

  it('engine list: plan-init → draft → reader → inventory-check → analyst → decision-review → spec-writer → spec-publish → seal', () => {
    const engineIds = template.engines.map(e => e.id);
    assert.deepEqual(engineIds, [
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
  });

  it('resolutionEngine is spec-writer', () => {
    assert.equal(template.resolutionEngine, 'spec-writer');
  });

  // ── reader stage ──────────────────────────────────────────────────

  it('reader uses astrolabe.sage-primer-reader role', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    assert.equal(reader?.givens?.role, 'astrolabe.sage-primer-reader');
  });

  it('reader prompt contains planId interpolation', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    const prompt = reader?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.plan-init.planId}'));
  });

  it('reader prompt does NOT contain MODE:', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    const prompt = reader?.givens?.prompt as string;
    assert.ok(!prompt.includes('MODE:'));
  });

  it('reader has metadata.engineId = reader', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    const metadata = reader?.givens?.metadata as { engineId: string } | undefined;
    assert.ok(metadata, 'metadata must be set');
    assert.equal(metadata.engineId, 'reader');
  });

  it('reader has writ and cwd givens', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    assert.equal(reader?.givens?.writ, '${writ}');
    assert.equal(reader?.givens?.cwd, '${yields.draft.path}');
  });

  it('reader has no conversationId', () => {
    const reader = template.engines.find(e => e.id === 'reader');
    assert.equal(reader?.givens?.conversationId, undefined);
  });

  // ── analyst stage ─────────────────────────────────────────────────

  it('analyst slot uses astrolabe.sage-primer-scoping role (analyst slot id preserved for backward compatibility)', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    assert.equal(analyst?.givens?.role, 'astrolabe.sage-primer-scoping');
  });

  it('analyst prompt contains planId interpolation', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    const prompt = analyst?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.plan-init.planId}'));
  });

  it('analyst prompt does NOT contain MODE:', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    const prompt = analyst?.givens?.prompt as string;
    assert.ok(!prompt.includes('MODE:'));
  });

  it('analyst has metadata.engineId = analyst', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    const metadata = analyst?.givens?.metadata as { engineId: string } | undefined;
    assert.ok(metadata, 'metadata must be set');
    assert.equal(metadata.engineId, 'analyst');
  });

  it('analyst has writ and cwd givens', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    assert.equal(analyst?.givens?.writ, '${writ}');
    assert.equal(analyst?.givens?.cwd, '${yields.draft.path}');
  });

  it('analyst has no conversationId', () => {
    const analyst = template.engines.find(e => e.id === 'analyst');
    assert.equal(analyst?.givens?.conversationId, undefined);
  });

  // ── spec-writer stage ─────────────────────────────────────────────

  it('spec-writer uses astrolabe.sage-writer role', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    assert.equal(sw?.givens?.role, 'astrolabe.sage-writer');
  });

  it('spec-writer prompt contains planId and decisionSummary interpolation', () => {
    const sw = template.engines.find(e => e.id === 'spec-writer');
    const prompt = sw?.givens?.prompt as string;
    assert.ok(prompt.includes('${yields.plan-init.planId}'));
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

  it('spec-publish is upstream of seal', () => {
    const seal = template.engines.find(e => e.id === 'seal');
    assert.deepEqual(seal?.upstream, ['spec-publish']);
  });
});
