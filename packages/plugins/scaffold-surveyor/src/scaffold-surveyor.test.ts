/**
 * scaffold-surveyor — unit tests.
 *
 * Pins the kit-shape invariants required by the commission spec.
 *
 * These tests are purely static — they import the plugin module and assert
 * on its exported values. No guild setup, no filesystem IO, no async
 * operations are required. All assertions run synchronously (the one
 * `createRequire` call is sync) except for the test runner's own scheduling.
 *
 * Coverage:
 *   T4-a  descriptor.id = 'scaffold-surveyor'
 *   T4-b  descriptor.description matches D22 verbatim
 *   T4-c  descriptor.version = package.json version (read at test time)
 *   T4-d  descriptor.rigTemplates shares object identity with kit.rigTemplates (D26)
 *   T4-e  kit.rigTemplates has three layer keys
 *   T4-f  kit.rigTemplateMappings uses fully-qualified names (D10)
 *   T4-g  kit.roles has three entries (model, strict, permissions, instructionsFile) (D21)
 *   T4-h  engine id is 'scaffold-surveyor.summon', referenced by every template (D19)
 *   T4-i  each rig template sets resolutionEngine = 'survey' (D19)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import scaffoldSurveyorPlugin, {
  summonEngine,
  surveyVisionTemplate,
  surveyChargeTemplate,
  surveyPieceTemplate,
} from './scaffold-surveyor.ts';
import { SUMMON_ENGINE_ID } from './engine.ts';

// ── Package version (read at test time so they stay in sync) ──────────

const _require = createRequire(import.meta.url);
const PKG = _require(
  path.join(fileURLToPath(import.meta.url), '..', '..', 'package.json'),
) as { version: string };

// ── Shared references ─────────────────────────────────────────────────

const { kit } = scaffoldSurveyorPlugin;
const descriptor = kit.surveyors[0];
const { rigTemplates, rigTemplateMappings, roles, engines } = kit;

const LAYERS = ['survey-vision', 'survey-charge', 'survey-piece'] as const;

// ── T4-a/b/c/d: SurveyorDescriptor ───────────────────────────────────

describe('SurveyorDescriptor', () => {
  it('id is scaffold-surveyor (T4-a)', () => {
    assert.equal(descriptor.id, 'scaffold-surveyor');
  });

  it('description matches D22 verbatim (T4-b)', () => {
    assert.equal(
      descriptor.description,
      'First-light scaffold surveyor: minimal LLM-driven decomposition for vision/charge/piece layers; designed to be replaced.',
    );
  });

  it('version equals package.json version (T4-c)', () => {
    assert.equal(descriptor.version, PKG.version);
  });

  it('descriptor.rigTemplates contains all three layer keys', () => {
    assert.ok('survey-vision' in descriptor.rigTemplates, 'missing survey-vision');
    assert.ok('survey-charge' in descriptor.rigTemplates, 'missing survey-charge');
    assert.ok('survey-piece'  in descriptor.rigTemplates, 'missing survey-piece');
  });

  it('descriptor.rigTemplates shares object identity with kit.rigTemplates (D26 / T4-d)', () => {
    for (const layer of LAYERS) {
      assert.strictEqual(
        descriptor.rigTemplates[layer],
        rigTemplates[layer],
        `descriptor.rigTemplates["${layer}"] must be the same object as kit.rigTemplates["${layer}"]`,
      );
    }
  });

  it('kit.surveyors has exactly one entry', () => {
    assert.equal(kit.surveyors.length, 1);
  });
});

// ── T4-e: kit.rigTemplates ────────────────────────────────────────────

describe('kit.rigTemplates', () => {
  it('has exactly three layer keys (T4-e)', () => {
    assert.deepEqual(
      Object.keys(rigTemplates).sort(),
      ['survey-charge', 'survey-piece', 'survey-vision'],
    );
  });

  it('survey-vision template is the named export', () => {
    assert.strictEqual(rigTemplates['survey-vision'], surveyVisionTemplate);
  });

  it('survey-charge template is the named export', () => {
    assert.strictEqual(rigTemplates['survey-charge'], surveyChargeTemplate);
  });

  it('survey-piece template is the named export', () => {
    assert.strictEqual(rigTemplates['survey-piece'], surveyPieceTemplate);
  });

  it('every template has exactly one engine entry', () => {
    for (const layer of LAYERS) {
      const tpl = rigTemplates[layer];
      assert.equal(
        tpl.engines.length, 1,
        `"${layer}" template must have exactly 1 engine`,
      );
    }
  });

  it('every template engine uses SUMMON_ENGINE_ID as designId', () => {
    for (const layer of LAYERS) {
      const { designId } = rigTemplates[layer].engines[0];
      assert.equal(
        designId, SUMMON_ENGINE_ID,
        `"${layer}" template engine designId must equal SUMMON_ENGINE_ID`,
      );
    }
  });

  it('every template engine has id "survey"', () => {
    for (const layer of LAYERS) {
      const { id } = rigTemplates[layer].engines[0];
      assert.equal(id, 'survey', `"${layer}" template engine id must be "survey"`);
    }
  });

  it('every template sets resolutionEngine = "survey" (D19 / T4-i)', () => {
    for (const layer of LAYERS) {
      assert.equal(
        rigTemplates[layer].resolutionEngine, 'survey',
        `"${layer}" template resolutionEngine must be "survey"`,
      );
    }
  });
});

// ── T4-f: kit.rigTemplateMappings (D10) ──────────────────────────────

describe('kit.rigTemplateMappings', () => {
  it('survey-vision maps to fully-qualified name', () => {
    assert.equal(rigTemplateMappings['survey-vision'], 'scaffold-surveyor.survey-vision');
  });

  it('survey-charge maps to fully-qualified name', () => {
    assert.equal(rigTemplateMappings['survey-charge'], 'scaffold-surveyor.survey-charge');
  });

  it('survey-piece maps to fully-qualified name', () => {
    assert.equal(rigTemplateMappings['survey-piece'], 'scaffold-surveyor.survey-piece');
  });

  it('has exactly three entries', () => {
    assert.equal(Object.keys(rigTemplateMappings).length, 3);
  });
});

// ── T4-g: kit.roles (D21) ────────────────────────────────────────────

describe('kit.roles', () => {
  it('has exactly three role entries', () => {
    assert.deepEqual(
      Object.keys(roles).sort(),
      ['survey-charge', 'survey-piece', 'survey-vision'],
    );
  });

  it('all roles use model "sonnet"', () => {
    for (const layer of LAYERS) {
      assert.equal(roles[layer].model, 'sonnet', `"${layer}" role must use model "sonnet"`);
    }
  });

  it('all roles have strict: true', () => {
    for (const layer of LAYERS) {
      assert.equal(roles[layer].strict, true, `"${layer}" role must have strict: true`);
    }
  });

  it('survey-vision permissions match D21', () => {
    assert.deepEqual(roles['survey-vision'].permissions, ['surveyor:create-charge', 'clerk:read']);
  });

  it('survey-charge permissions match D21 (piece-producing only)', () => {
    assert.deepEqual(
      roles['survey-charge'].permissions,
      ['surveyor:create-piece', 'clerk:read'],
    );
  });

  it('survey-piece permissions match D21', () => {
    assert.deepEqual(roles['survey-piece'].permissions, ['surveyor:create-mandate', 'clerk:read']);
  });

  it('survey-vision instructionsFile is loom-roles/survey-vision.md', () => {
    assert.equal(roles['survey-vision'].instructionsFile, 'loom-roles/survey-vision.md');
  });

  it('survey-charge instructionsFile is loom-roles/survey-charge.md', () => {
    assert.equal(roles['survey-charge'].instructionsFile, 'loom-roles/survey-charge.md');
  });

  it('survey-piece instructionsFile is loom-roles/survey-piece.md', () => {
    assert.equal(roles['survey-piece'].instructionsFile, 'loom-roles/survey-piece.md');
  });
});

// ── T4-h: summonEngine (D19) ──────────────────────────────────────────

describe('summonEngine and SUMMON_ENGINE_ID', () => {
  it('SUMMON_ENGINE_ID is "scaffold-surveyor.summon"', () => {
    assert.equal(SUMMON_ENGINE_ID, 'scaffold-surveyor.summon');
  });

  it('summonEngine.id equals SUMMON_ENGINE_ID', () => {
    assert.equal(summonEngine.id, SUMMON_ENGINE_ID);
  });

  it('kit.engines has exactly one entry keyed by SUMMON_ENGINE_ID', () => {
    assert.deepEqual(Object.keys(engines), [SUMMON_ENGINE_ID]);
  });

  it('kit.engines[SUMMON_ENGINE_ID] is the summonEngine object', () => {
    assert.strictEqual(engines[SUMMON_ENGINE_ID], summonEngine as object);
  });

  it('all rig template engines reference SUMMON_ENGINE_ID (T4-h)', () => {
    for (const layer of LAYERS) {
      for (const engine of rigTemplates[layer].engines) {
        assert.equal(
          engine.designId, SUMMON_ENGINE_ID,
          `"${layer}" engine must reference SUMMON_ENGINE_ID`,
        );
      }
    }
  });
});

// ── Kit shape invariants ──────────────────────────────────────────────

describe('kit shape invariants', () => {
  it('scaffoldSurveyorPlugin is a kit plugin (has .kit, no .apparatus)', () => {
    assert.ok('kit' in scaffoldSurveyorPlugin, 'must have .kit');
    assert.ok(!('apparatus' in scaffoldSurveyorPlugin), 'must NOT have .apparatus');
  });

  it('kit.requires covers all referenced apparatuses', () => {
    const requires = kit.requires as string[];
    assert.ok(requires.includes('surveyor'),  'must require surveyor');
    assert.ok(requires.includes('spider'),    'must require spider');
    assert.ok(requires.includes('animator'),  'must require animator');
    assert.ok(requires.includes('loom'),      'must require loom');
    assert.ok(requires.includes('clerk'),     'must require clerk');
  });
});
