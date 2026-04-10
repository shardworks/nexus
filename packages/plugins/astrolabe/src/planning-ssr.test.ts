/**
 * planning-ssr rig template tests.
 *
 * Verifies that the experimental single-shot reader template is correctly
 * registered, maps from brief-ssr, and differs from planning only in
 * the reader engine's prompt.
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

type EngineEntry = {
  id: string;
  designId: string;
  upstream?: string[];
  givens?: Record<string, unknown>;
};

type TemplateShape = {
  engines: EngineEntry[];
  resolutionEngine?: string;
};

function getKit(plugin: unknown): Record<string, unknown> {
  const kit = (plugin as AnyApparatus).apparatus.supportKit;
  assert.ok(kit, 'supportKit must be defined');
  return kit;
}

function getTemplates(plugin: unknown): Record<string, TemplateShape> {
  const kit = getKit(plugin);
  return kit.rigTemplates as Record<string, TemplateShape>;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('planning-ssr rig template', () => {
  const plugin = createAstrolabe();

  // ── Registration ──────────────────────────────────────────────────

  it('is registered as a rig template on the astrolabe plugin', () => {
    const templates = getTemplates(plugin);
    assert.ok(templates['planning-ssr'], 'planning-ssr template must exist');
  });

  it('has 9 engines — same count as planning', () => {
    const templates = getTemplates(plugin);
    assert.equal(templates['planning-ssr'].engines.length, 9);
    assert.equal(templates.planning.engines.length, 9);
  });

  it('uses spec-writer as its resolution engine', () => {
    const templates = getTemplates(plugin);
    assert.equal(templates['planning-ssr'].resolutionEngine, 'spec-writer');
  });

  // ── Engine list parity ────────────────────────────────────────────

  it('has the same engine id sequence as planning', () => {
    const templates = getTemplates(plugin);
    const planningIds = templates.planning.engines.map(e => e.id);
    const ssrIds = templates['planning-ssr'].engines.map(e => e.id);
    assert.deepEqual(ssrIds, planningIds);
  });

  it('has the same engine designIds as planning', () => {
    const templates = getTemplates(plugin);
    const planningDesigns = templates.planning.engines.map(e => e.designId);
    const ssrDesigns = templates['planning-ssr'].engines.map(e => e.designId);
    assert.deepEqual(ssrDesigns, planningDesigns);
  });

  it('has the same upstream wiring as planning', () => {
    const templates = getTemplates(plugin);
    const planningUpstreams = templates.planning.engines.map(e => [e.id, e.upstream]);
    const ssrUpstreams = templates['planning-ssr'].engines.map(e => [e.id, e.upstream]);
    assert.deepEqual(ssrUpstreams, planningUpstreams);
  });

  // ── Reader prompt divergence ──────────────────────────────────────

  it('reader engine has a different prompt than planning', () => {
    const templates = getTemplates(plugin);
    const planningReader = templates.planning.engines.find(e => e.id === 'reader')!;
    const ssrReader = templates['planning-ssr'].engines.find(e => e.id === 'reader')!;
    assert.notEqual(
      ssrReader.givens?.prompt,
      planningReader.givens?.prompt,
      'SSR reader prompt must differ from planning reader prompt',
    );
  });

  it('reader prompt includes planId interpolation', () => {
    const templates = getTemplates(plugin);
    const ssrReader = templates['planning-ssr'].engines.find(e => e.id === 'reader')!;
    const prompt = ssrReader.givens?.prompt as string;
    assert.ok(
      prompt.includes('${yields.plan-init.planId}'),
      'SSR reader prompt must include planId interpolation',
    );
  });

  it('reader prompt instructs single-shot / batch behavior', () => {
    const templates = getTemplates(plugin);
    const ssrReader = templates['planning-ssr'].engines.find(e => e.id === 'reader')!;
    const prompt = (ssrReader.givens?.prompt as string).toLowerCase();
    // Must mention parallel/batch tool calls and turn budget
    assert.ok(prompt.includes('parallel'), 'prompt must instruct parallel tool calls');
    assert.ok(prompt.includes('inventory-write'), 'prompt must reference inventory-write');
    assert.ok(
      prompt.includes('single') || prompt.includes('1') || prompt.includes('one'),
      'prompt must reference single-shot or 1-turn target',
    );
  });

  it('reader engine uses same role and designId as planning', () => {
    const templates = getTemplates(plugin);
    const planningReader = templates.planning.engines.find(e => e.id === 'reader')!;
    const ssrReader = templates['planning-ssr'].engines.find(e => e.id === 'reader')!;
    assert.equal(ssrReader.designId, planningReader.designId);
    assert.equal(ssrReader.givens?.role, planningReader.givens?.role);
  });

  it('reader engine has writ given', () => {
    const templates = getTemplates(plugin);
    const ssrReader = templates['planning-ssr'].engines.find(e => e.id === 'reader')!;
    assert.equal(ssrReader.givens?.writ, '${writ}');
  });

  // ── Non-reader engines are identical ──────────────────────────────

  it('all non-reader engines have identical givens to planning', () => {
    const templates = getTemplates(plugin);
    const nonReaderIds = ['plan-init', 'draft', 'inventory-check', 'analyst', 'decision-review', 'spec-writer', 'spec-publish', 'seal'];
    for (const id of nonReaderIds) {
      const planningEng = templates.planning.engines.find(e => e.id === id)!;
      const ssrEng = templates['planning-ssr'].engines.find(e => e.id === id)!;
      assert.deepEqual(
        ssrEng.givens,
        planningEng.givens,
        `Engine "${id}" givens must be identical between planning and planning-ssr`,
      );
    }
  });
});

describe('brief-ssr writ type', () => {
  const plugin = createAstrolabe();

  it('is registered as a writ type', () => {
    const kit = getKit(plugin);
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    const briefSsr = writTypes.find(w => w.name === 'brief-ssr');
    assert.ok(briefSsr, 'brief-ssr writ type must exist');
    assert.ok(briefSsr.description, 'brief-ssr must have a description');
  });

  it('maps to astrolabe.planning-ssr', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings['brief-ssr'], 'astrolabe.planning-ssr');
  });

  it('does not modify the existing brief mapping', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings.brief, 'astrolabe.planning');
  });

  it('does not modify the existing brief writ type', () => {
    const kit = getKit(plugin);
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    const brief = writTypes.find(w => w.name === 'brief');
    assert.ok(brief, 'brief writ type must still exist');
    assert.equal(brief.name, 'brief');
  });
});

describe('planning template is untouched', () => {
  const plugin = createAstrolabe();

  it('planning template still has exactly 9 engines in the original order', () => {
    const templates = getTemplates(plugin);
    const engineIds = templates.planning.engines.map(e => e.id);
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

  it('planning reader prompt is the original multi-turn prompt', () => {
    const templates = getTemplates(plugin);
    const reader = templates.planning.engines.find(e => e.id === 'reader')!;
    const prompt = reader.givens?.prompt as string;
    assert.ok(prompt.startsWith('MODE: READER'));
    assert.ok(prompt.includes('Use plan-show to read the plan'));
    assert.ok(prompt.includes('inventory the codebase and write the inventory'));
    // Must NOT contain single-shot instructions
    assert.ok(!prompt.toLowerCase().includes('single response'), 'planning reader must not have SSR instructions');
    assert.ok(!prompt.toLowerCase().includes('parallel batch'), 'planning reader must not have SSR instructions');
  });
});
