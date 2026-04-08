/**
 * Astrolabe supportKit shape tests.
 *
 * Verifies that the apparatus's supportKit declares the correct books,
 * writTypes, roles, engines, rigTemplates, rigTemplateMappings, and tools.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAstrolabe } from './astrolabe.ts';

// ── Helpers ───────────────────────────────────────────────────────────

type AnyApparatus = {
  apparatus: {
    requires?: string[];
    recommends?: string[];
    consumes?: string[];
    supportKit?: Record<string, unknown>;
    provides?: unknown;
  };
};

function getKit(plugin: unknown): Record<string, unknown> {
  const kit = (plugin as AnyApparatus).apparatus.supportKit;
  assert.ok(kit, 'supportKit must be defined');
  return kit;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Astrolabe supportKit shape', () => {
  const plugin = createAstrolabe();
  const apparatus = (plugin as AnyApparatus).apparatus;

  // ── R3: requires / recommends ──────────────────────────────────────

  it('declares requires: stacks and clerk', () => {
    assert.deepEqual(apparatus.requires, ['stacks', 'clerk']);
  });

  it('declares recommends: spider, loom, fabricator, oculus', () => {
    assert.deepEqual(apparatus.recommends, ['spider', 'loom', 'fabricator', 'oculus']);
  });

  it('does not declare consumes', () => {
    assert.equal((apparatus as { consumes?: unknown }).consumes, undefined);
  });

  // ── R4: books ──────────────────────────────────────────────────────

  it('declares plans book with correct indexes', () => {
    const kit = getKit(plugin);
    const books = kit.books as Record<string, { indexes: unknown[] }>;
    assert.ok(books?.plans, 'plans book must exist');
    assert.deepEqual(books.plans.indexes, ['status', 'codex', 'createdAt']);
  });

  // ── R5: writTypes ──────────────────────────────────────────────────

  it('contributes brief writType', () => {
    const kit = getKit(plugin);
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    assert.ok(Array.isArray(writTypes), 'writTypes must be an array');
    assert.equal(writTypes.length, 1);
    assert.equal(writTypes[0].name, 'brief');
    assert.ok(writTypes[0].description);
  });

  // ── R6: roles ──────────────────────────────────────────────────────

  it('contributes sage role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.sage, 'sage role must exist');
    assert.deepEqual(roles.sage.permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read']);
    assert.equal(roles.sage.strict, true);
    assert.ok(roles.sage.instructionsFile, 'instructionsFile must be set');
  });

  // ── R7: engines ────────────────────────────────────────────────────

  it('contributes all four engine designs', () => {
    const kit = getKit(plugin);
    const engines = kit.engines as Record<string, { id: string; run: unknown }>;
    assert.ok(engines?.['astrolabe.plan-init'], 'plan-init engine must exist');
    assert.ok(engines?.['astrolabe.inventory-check'], 'inventory-check engine must exist');
    assert.ok(engines?.['astrolabe.decision-review'], 'decision-review engine must exist');
    assert.ok(engines?.['astrolabe.spec-publish'], 'spec-publish engine must exist');

    assert.equal(engines['astrolabe.plan-init'].id, 'astrolabe.plan-init');
    assert.equal(engines['astrolabe.inventory-check'].id, 'astrolabe.inventory-check');
    assert.equal(engines['astrolabe.decision-review'].id, 'astrolabe.decision-review');
    assert.equal(engines['astrolabe.spec-publish'].id, 'astrolabe.spec-publish');

    assert.equal(typeof engines['astrolabe.plan-init'].run, 'function');
    assert.equal(typeof engines['astrolabe.inventory-check'].run, 'function');
    assert.equal(typeof engines['astrolabe.decision-review'].run, 'function');
    assert.equal(typeof engines['astrolabe.spec-publish'].run, 'function');
  });

  // ── R8: rigTemplates and rigTemplateMappings ───────────────────────

  it('contributes planning rig template with 9 engines', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
      resolutionEngine?: string;
    }>;
    assert.ok(rigTemplates?.planning, 'planning template must exist');

    const templateEngines = rigTemplates.planning.engines;
    assert.equal(templateEngines.length, 9);

    const engineIds = templateEngines.map(e => e.id);
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

    assert.equal(rigTemplates.planning.resolutionEngine, 'spec-writer');
  });

  it('maps brief to astrolabe.planning', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings?.brief, 'astrolabe.planning');
  });

  // ── R9: tools ──────────────────────────────────────────────────────

  it('contributes all 7 tools', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string; instructions?: string }>;
    assert.ok(Array.isArray(tools), 'tools must be an array');
    assert.equal(tools.length, 7);

    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('plan-show'));
    assert.ok(toolNames.includes('plan-list'));
    assert.ok(toolNames.includes('inventory-write'));
    assert.ok(toolNames.includes('scope-write'));
    assert.ok(toolNames.includes('decisions-write'));
    assert.ok(toolNames.includes('observations-write'));
    assert.ok(toolNames.includes('spec-write'));
  });

  it('all tools have non-empty instructions', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; instructions?: string }>;
    for (const t of tools) {
      assert.ok(t.instructions && t.instructions.length > 0, `Tool "${t.name}" must have instructions`);
    }
  });

  it('read tools use astrolabe:read permission', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const readTools = ['plan-show', 'plan-list'];
    for (const name of readTools) {
      const t = tools.find(x => x.name === name);
      assert.ok(t, `Tool "${name}" must exist`);
      assert.equal(t.permission, 'astrolabe:read', `Tool "${name}" must have astrolabe:read permission`);
    }
  });

  it('write tools use astrolabe:write permission', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const writeTools = ['inventory-write', 'scope-write', 'decisions-write', 'observations-write', 'spec-write'];
    for (const name of writeTools) {
      const t = tools.find(x => x.name === name);
      assert.ok(t, `Tool "${name}" must exist`);
      assert.equal(t.permission, 'astrolabe:write', `Tool "${name}" must have astrolabe:write permission`);
    }
  });

  // ── R8: rig template wiring ────────────────────────────────────────

  it('anima session engines have writ givens and non-empty prompts', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;
    const animaEngines = ['reader', 'analyst', 'spec-writer'];
    for (const id of animaEngines) {
      const eng = rigTemplates.planning.engines.find(e => e.id === id);
      assert.ok(eng, `Engine "${id}" must exist`);
      assert.ok(eng.givens?.writ, `Engine "${id}" must have writ given`);
      assert.ok(eng.givens?.prompt, `Engine "${id}" must have prompt given`);
      assert.ok(
        typeof eng.givens.prompt === 'string' && (eng.givens.prompt as string).length > 0,
        `Engine "${id}" prompt must be non-empty`,
      );
      assert.ok(
        (eng.givens.prompt as string).includes('${yields.plan-init.planId}'),
        `Engine "${id}" prompt must include planId interpolation`,
      );
    }
  });

  it('analyst and spec-writer chain conversationId from upstream', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;
    const analyst = rigTemplates.planning.engines.find(e => e.id === 'analyst');
    assert.equal(analyst?.givens?.conversationId, '${yields.reader.conversationId}');

    const specWriter = rigTemplates.planning.engines.find(e => e.id === 'spec-writer');
    assert.equal(specWriter?.givens?.conversationId, '${yields.analyst.conversationId}');
  });

  it('reader has no conversationId', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;
    const reader = rigTemplates.planning.engines.find(e => e.id === 'reader');
    assert.equal(reader?.givens?.conversationId, undefined);
  });

  it('spec-publish engine is upstream of seal', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; upstream?: string[] }>;
    }>;
    const seal = rigTemplates.planning.engines.find(e => e.id === 'seal');
    assert.deepEqual(seal?.upstream, ['spec-publish']);
  });

  it('spec-writer prompt includes decisionSummary interpolation', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;
    const specWriter = rigTemplates.planning.engines.find(e => e.id === 'spec-writer');
    const prompt = specWriter?.givens?.prompt as string;
    assert.ok(
      prompt.includes('${yields.decision-review.decisionSummary}'),
      'spec-writer prompt must include decisionSummary interpolation',
    );
  });
});
