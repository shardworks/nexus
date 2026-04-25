/**
 * Astrolabe supportKit shape tests.
 *
 * Verifies that the apparatus's supportKit declares the correct books,
 * roles, engines, rigTemplates, rigTemplateMappings, and tools. Writ
 * types (`piece`, `observation-set`) are now registered with the Clerk
 * via `ClerkApi.registerWritType` from astrolabe's own `start()`, not
 * contributed via the kit channel.
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

  it('declares recommends: spider, loom, fabricator, oculus, ratchet, animator', () => {
    assert.deepEqual(apparatus.recommends, ['spider', 'loom', 'fabricator', 'oculus', 'ratchet', 'animator']);
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

  it('does not contribute writTypes via the kit channel', () => {
    const kit = getKit(plugin);
    // The kit-channel writTypes contribution has been removed; piece and
    // observation-set are registered with the Clerk via
    // `ClerkApi.registerWritType` from astrolabe's own `start()` instead.
    assert.equal(
      (kit as { writTypes?: unknown }).writTypes,
      undefined,
      'kit must not declare writTypes',
    );
  });

  // ── linkKinds ──────────────────────────────────────────────────────

  it('contributes astrolabe.lifted-from link kind', () => {
    const kit = getKit(plugin);
    const linkKinds = kit.linkKinds as Array<{ id: string; description?: string }>;
    assert.ok(Array.isArray(linkKinds), 'linkKinds must be an array');
    assert.equal(linkKinds.length, 1, 'must have exactly one link kind');
    const liftedFrom = linkKinds.find(k => k.id === 'astrolabe.lifted-from');
    assert.ok(liftedFrom, 'astrolabe.lifted-from link kind must exist');
    assert.ok(liftedFrom.description && liftedFrom.description.length > 0);
  });

  it('observation-set writ type is non-dispatchable (no rigTemplateMappings entry)', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(
      mappings['observation-set'], undefined,
      'observation-set must not map to a rig template — it is a pure container type',
    );
  });

  // ── R6: roles ──────────────────────────────────────────────────────

  it('contributes sage-primer-reader role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-primer-reader'], 'sage-primer-reader role must exist');
    assert.deepEqual(roles['sage-primer-reader'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read']);
    assert.equal(roles['sage-primer-reader'].strict, true);
    assert.equal(roles['sage-primer-reader'].instructionsFile, 'sage-primer-reader.md');
  });

  it('contributes sage-primer-scoping role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-primer-scoping'], 'sage-primer-scoping role must exist');
    assert.deepEqual(roles['sage-primer-scoping'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read']);
    assert.equal(roles['sage-primer-scoping'].strict, true);
    assert.equal(roles['sage-primer-scoping'].instructionsFile, 'sage-primer-scoping.md');
  });

  it('contributes sage-writer role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-writer'], 'sage-writer role must exist');
    assert.deepEqual(roles['sage-writer'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read']);
    assert.equal(roles['sage-writer'].strict, true);
    assert.equal(roles['sage-writer'].instructionsFile, 'sage-writer.md');
  });

  it('contributes sage-primer-solo role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-primer-solo'], 'sage-primer-solo role must exist');
    assert.deepEqual(roles['sage-primer-solo'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read']);
    assert.equal(roles['sage-primer-solo'].strict, true);
    assert.equal(roles['sage-primer-solo'].instructionsFile, 'sage-primer-solo.md');
  });

  it('contributes sage-primer-attended role with correct permissions', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, {
      permissions: string[];
      strict?: boolean;
      instructionsFile?: string;
    }>;
    assert.ok(roles?.['sage-primer-attended'], 'sage-primer-attended role must exist');
    assert.deepEqual(roles['sage-primer-attended'].permissions, ['astrolabe:read', 'astrolabe:write', 'clerk:read', 'ratchet:read']);
    assert.equal(roles['sage-primer-attended'].strict, true);
    assert.equal(roles['sage-primer-attended'].instructionsFile, 'sage-primer-attended.md');
  });

  it('does not contribute the legacy sage-reading-analyst / sage-analyst / sage-reader roles', () => {
    const kit = getKit(plugin);
    const roles = kit.roles as Record<string, unknown>;
    assert.equal(roles['sage-reading-analyst'], undefined,
      'sage-reading-analyst is retired in favour of sage-primer-solo / sage-primer-attended');
    assert.equal(roles['sage-analyst'], undefined,
      'sage-analyst is retired — scoping primer is now sage-primer-scoping');
    assert.equal(roles['sage-reader'], undefined,
      'sage-reader is retired — reader primer is now sage-primer-reader');
  });

  // ── R7: engines ────────────────────────────────────────────────────

  it('contributes all engine designs', () => {
    const kit = getKit(plugin);
    const engines = kit.engines as Record<string, { id: string; run: unknown }>;
    assert.equal(Object.keys(engines).length, 7, 'must have exactly 7 engine designs');
    assert.ok(engines?.['astrolabe.plan-init'], 'plan-init engine must exist');
    assert.ok(engines?.['astrolabe.inventory-check'], 'inventory-check engine must exist');
    assert.ok(engines?.['astrolabe.patron-anima'], 'patron-anima engine must exist');
    assert.ok(engines?.['astrolabe.decision-review'], 'decision-review engine must exist');
    assert.ok(engines?.['astrolabe.plan-finalize'], 'plan-finalize engine must exist');
    assert.ok(engines?.['astrolabe.observation-lift'], 'observation-lift engine must exist');
    assert.ok(engines?.['astrolabe.reader-analyst'], 'reader-analyst engine must exist');

    // Retired by the two/three-phase rig retirement commission.
    assert.equal(engines['astrolabe.spec-publish'], undefined,
      'spec-publish engine is retired and must not be registered');

    assert.equal(engines['astrolabe.plan-init'].id, 'astrolabe.plan-init');
    assert.equal(engines['astrolabe.inventory-check'].id, 'astrolabe.inventory-check');
    assert.equal(engines['astrolabe.patron-anima'].id, 'astrolabe.patron-anima');
    assert.equal(engines['astrolabe.decision-review'].id, 'astrolabe.decision-review');
    assert.equal(engines['astrolabe.plan-finalize'].id, 'astrolabe.plan-finalize');
    assert.equal(engines['astrolabe.observation-lift'].id, 'astrolabe.observation-lift');
    assert.equal(engines['astrolabe.reader-analyst'].id, 'astrolabe.reader-analyst');

    assert.equal(typeof engines['astrolabe.plan-init'].run, 'function');
    assert.equal(typeof engines['astrolabe.inventory-check'].run, 'function');
    assert.equal(typeof engines['astrolabe.patron-anima'].run, 'function');
    assert.equal(typeof engines['astrolabe.decision-review'].run, 'function');
    assert.equal(typeof engines['astrolabe.plan-finalize'].run, 'function');
    assert.equal(typeof engines['astrolabe.observation-lift'].run, 'function');
    assert.equal(typeof engines['astrolabe.reader-analyst'].run, 'function');
  });

  // ── R8: rigTemplates and rigTemplateMappings ───────────────────────

  it('does not register the retired two-phase-planning or three-phase-planning templates', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, unknown>;
    assert.equal(rigTemplates['two-phase-planning'], undefined,
      'two-phase-planning template is retired and must not be registered');
    assert.equal(rigTemplates['three-phase-planning'], undefined,
      'three-phase-planning template is retired and must not be registered');
  });

  it('contributes plan-and-ship rig template with 13 engines', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
      resolutionEngine?: string;
    }>;
    assert.ok(rigTemplates?.['plan-and-ship'], 'plan-and-ship template must exist');

    const templateEngines = rigTemplates['plan-and-ship'].engines;
    assert.equal(templateEngines.length, 13);

    const engineIds = templateEngines.map(e => e.id);
    assert.deepEqual(engineIds, [
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
    ]);

    assert.equal(rigTemplates['plan-and-ship'].resolutionEngine, 'seal');
  });

  it('observation-lift appears exactly once in the plan-and-ship rig template', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
    }>;
    const engines = rigTemplates['plan-and-ship'].engines;
    const count = engines.filter(e => e.designId === 'astrolabe.observation-lift').length;
    assert.equal(
      count,
      1,
      `plan-and-ship must list astrolabe.observation-lift exactly once (found ${count})`,
    );
  });

  it('observation-lift placement preserves non-terminal mandate writ phase', () => {
    // Clerk rejects child-writ creation under a terminal parent, so
    // observation-lift must run before the seal engine that transitions
    // the mandate writ to `completed`.
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; designId: string }>;
    }>;
    const engines = rigTemplates['plan-and-ship'].engines;
    const obsIdx = engines.findIndex(e => e.designId === 'astrolabe.observation-lift');
    const sealIdx = engines.findIndex(e => e.designId === 'seal');
    assert.ok(obsIdx >= 0, 'plan-and-ship must include observation-lift');
    assert.ok(sealIdx >= 0, 'plan-and-ship must include seal');
    assert.ok(
      obsIdx < sealIdx,
      `plan-and-ship: observation-lift (index ${obsIdx}) must run before seal (index ${sealIdx})`,
    );
  });

  it('maps mandate to astrolabe.plan-and-ship', () => {
    const kit = getKit(plugin);
    const mappings = kit.rigTemplateMappings as Record<string, string>;
    assert.equal(mappings?.mandate, 'astrolabe.plan-and-ship');
    assert.equal(mappings?.brief, undefined, 'brief mapping must not be contributed');
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
      const eng = rigTemplates['plan-and-ship'].engines.find(e => e.id === id);
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

  it('no engine in plan-and-ship has a conversationId given', () => {
    const kit = getKit(plugin);
    const rigTemplates = kit.rigTemplates as Record<string, {
      engines: Array<{ id: string; givens?: Record<string, unknown> }>;
    }>;

    const engines = rigTemplates['plan-and-ship'].engines;
    for (const eng of engines) {
      assert.equal(
        eng.givens?.conversationId, undefined,
        `Engine "${eng.id}" in plan-and-ship must not have conversationId`,
      );
    }
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

  it('all five sage roles resolve all expected tools after bare-level normalization', () => {
    const kit = getKit(plugin);
    const tools = kit.tools as Array<{ name: string; permission?: string }>;
    const roles = kit.roles as Record<string, { permissions: string[]; strict?: boolean }>;

    const roleNames = [
      'sage-primer-reader',
      'sage-primer-scoping',
      'sage-writer',
      'sage-primer-solo',
      'sage-primer-attended',
    ];
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

});
