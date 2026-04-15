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

  it('contributes exactly one brief writType', () => {
    const kit = getKit(plugin);
    const writTypes = kit.writTypes as Array<{ name: string; description?: string }>;
    assert.ok(Array.isArray(writTypes), 'writTypes must be an array');
    assert.equal(writTypes.length, 1, 'must have exactly one writ type');
    const brief = writTypes.find(w => w.name === 'brief');
    assert.ok(brief, 'brief writType must exist');
    assert.ok(brief.description);
  });

  // ── R6: roles ──────────────────────────────────────────────────────

  it('contributes sage-reader role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-reader'], 'sage-reader role must exist');
    assert.deepEqual(roles['sage-reader'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read']);
    assert.equal(roles['sage-reader'].strict, true);
    assert.equal(roles['sage-reader'].instructionsFile, 'sage-reader.md');
  });

  it('contributes sage-analyst role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-analyst'], 'sage-analyst role must exist');
    assert.deepEqual(roles['sage-analyst'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read']);
    assert.equal(roles['sage-analyst'].strict, true);
    assert.equal(roles['sage-analyst'].instructionsFile, 'sage-analyst.md');
  });

  it('contributes sage-writer role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-writer'], 'sage-writer role must exist');
    assert.deepEqual(roles['sage-writer'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read']);
    assert.equal(roles['sage-writer'].strict, true);
    assert.equal(roles['sage-writer'].instructionsFile, 'sage-writer.md');
  });

  it('contributes sage-reading-analyst role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-reading-analyst'], 'sage-reading-analyst role must exist');
    assert.deepEqual(roles['sage-reading-analyst'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read']);
    assert.equal(roles['sage-reading-analyst'].strict, true);
    assert.equal(roles['sage-reading-analyst'].instructionsFile, 'sage-reading-analyst.md');
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

  it('contributes two-phase-planning rig template with 8 engines', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
      resolutionEngine?: string;
    }>;
    assert.ok(rigTemplates?.['two-phase-planning'], 'two-phase-planning template must exist');

    const templateEngines = rigTemplates['two-phase-planning'].engines;
    assert.equal(templateEngines.length, 8);

    const engineIds = templateEngines.map(e => e.id);
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

    assert.equal(rigTemplates['two-phase-planning'].resolutionEngine, 'spec-writer');
  });

  it('contributes three-phase-planning rig template with 9 engines', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
      resolutionEngine?: string;
    }>;
    assert.ok(rigTemplates?.['three-phase-planning'], 'three-phase-planning template must exist');

    const templateEngines = rigTemplates['three-phase-planning'].engines;
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

    assert.equal(rigTemplates['three-phase-planning'].resolutionEngine, 'spec-writer');
  });

  it('maps brief to astrolabe.two-phase-planning', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings?.brief, 'astrolabe.two-phase-planning');
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

  it('read tools use bare-level read permission', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const readTools = ['plan-show', 'plan-list'];
    for (const name of readTools) {
      const t = tools.find(x => x.name === name);
      assert.ok(t, `Tool "${name}" must exist`);
      assert.equal(t.permission, 'read', `Tool "${name}" must have bare-level 'read' permission`);
    }
  });

  it('write tools use bare-level write permission', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const writeTools = ['inventory-write', 'scope-write', 'decisions-write', 'observations-write', 'spec-write'];
    for (const name of writeTools) {
      const t = tools.find(x => x.name === name);
      assert.ok(t, `Tool "${name}" must exist`);
      assert.equal(t.permission, 'write', `Tool "${name}" must have bare-level 'write' permission`);
    }
  });

  // ── R8: rig template wiring ────────────────────────────────────────

  it('anima session engines have writ givens and non-empty prompts', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;
    const animaEngines = ['reader-analyst', 'spec-writer'];
    for (const id of animaEngines) {
      const eng = rigTemplates['two-phase-planning'].engines.find(e => e.id === id);
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

  it('no engine in either template has a conversationId given', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;

    for (const templateName of ['two-phase-planning', 'three-phase-planning']) {
      const engines = rigTemplates[templateName].engines;
      for (const eng of engines) {
        assert.equal(
          eng.givens?.conversationId, undefined,
          `Engine "${eng.id}" in ${templateName} must not have conversationId`,
        );
      }
    }
  });

  it('spec-publish engine is upstream of seal', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; upstream?: string[] }>;
    }>;
    const seal = rigTemplates['two-phase-planning'].engines.find(e => e.id === 'seal');
    assert.deepEqual(seal?.upstream, ['spec-publish']);
  });

  // ── Bare-level permission convention ──────────────────────────────

  it('all tool permissions use bare-level form (no colons)', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    for (const t of tools) {
      if (t.permission) {
        assert.ok(
          !t.permission.includes(':'),
          `Tool "${t.name}" has permission "${t.permission}" which contains a colon. ` +
          `Permissions must be bare levels like "read" or "write".`,
        );
      }
    }
  });

  it('all four roles resolve all expected tools after bare-level normalization', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const roles = kit.roles as Record<string, { permissions: string[]; strict?: boolean }>;

    const roleNames = ['sage-reader', 'sage-analyst', 'sage-writer', 'sage-reading-analyst'];
    for (const roleName of roleNames) {
      const role = roles[roleName];
      assert.ok(role, `${roleName} role must exist`);

      // Parse grants
      const grants = role.permissions.map(g => {
        const idx = g.indexOf(':');
        return idx === -1 ? null : { plugin: g.slice(0, idx), level: g.slice(idx + 1) };
      }).filter(Boolean) as Array<{ plugin: string; level: string }>;

      // Simulate permission matching for astrolabe tools
      const matched = tools.filter(t => {
        if (!t.permission) return false;
        return grants.some(g =>
          (g.plugin === 'astrolabe' && g.level === t.permission) ||
          (g.plugin === 'astrolabe' && g.level === '*') ||
          (g.plugin === '*' && g.level === t.permission) ||
          (g.plugin === '*' && g.level === '*'),
        );
      });

      const matchedNames = matched.map(t => t.name).sort();
      assert.deepEqual(matchedNames, [
        'decisions-write',
        'inventory-write',
        'observations-write',
        'plan-list',
        'plan-show',
        'scope-write',
        'spec-write',
      ], `${roleName} must resolve all 7 tools`);
    }
  });

  // ── Negative assertions: old identifiers must not appear ──────────

  it('old identifiers do not appear in roles', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, unknown>;
    assert.equal(roles.sage, undefined, 'sage role must not exist');
  });

  it('old identifiers do not appear in rigTemplates', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, unknown>;
    assert.equal(rigTemplates.planning, undefined, 'planning template must not exist');
    assert.equal(rigTemplates['planning-mra'], undefined, 'planning-mra template must not exist');
  });

  it('old identifiers do not appear in rigTemplateMappings', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings['brief-mra'], undefined, 'brief-mra mapping must not exist');
  });

  it('old identifiers do not appear in writTypes', () => {
    const kit = getKit(plugin);
    const writTypes = kit.writTypes as Array<{ name: string }>;
    const briefMra = writTypes.find(w => w.name === 'brief-mra');
    assert.equal(briefMra, undefined, 'brief-mra writ type must not exist');
  });
});
