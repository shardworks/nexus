/**
 * @shardworks/scaffold-surveyor — first-light scaffold surveyor plugin.
 *
 * A pure kit plugin (D1) that contributes:
 *   - One `SurveyorDescriptor` to the `surveyor` substrate.
 *   - Three `RigTemplate` entries to Spider (one per cartograph layer).
 *   - Three `rigTemplateMappings` entries binding survey writ types to
 *     their qualified template names.
 *   - The `scaffold-surveyor.summon` `EngineDesign` to the Fabricator.
 *   - Three `KitRoleDefinition` entries to Loom (one per layer).
 *
 * All design decisions are documented in the commission brief.
 * This package is explicitly designed to be replaced — see README.
 */

import type { KitRoleDefinition } from '@shardworks/loom-apparatus';
import type { RigTemplate } from '@shardworks/spider-apparatus';
import type { SurveyorDescriptor } from '@shardworks/surveyor-apparatus';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';

import { summonEngine, SUMMON_ENGINE_ID } from './engine.ts';

// ── Package version (sync with package.json via require) ──────────────
//
// Import the version from package.json so descriptor.version stays in
// sync with the npm package version without manual duplication.
// NOTE: Node's --experimental-transform-types passes JSON imports through;
// if this causes issues in a particular node version, fall back to the
// literal string '0.0.0'.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = path.join(fileURLToPath(import.meta.url), '..', '..', 'package.json');
const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = require(pkgPath) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ── Engine design ─────────────────────────────────────────────────────
//
// Exported for use in tests. The engine is shared across all three
// rig templates; kit.engines registers it once under its id.

export { summonEngine };

// ── Rig templates ─────────────────────────────────────────────────────
//
// Each layer gets its own template so prompt shapes can diverge
// cleanly as the surveyor is iterated (D5). Single engine per template
// (no multi-stage pipeline — D, no separate read/decide/create stages).
//
// The `resolutionEngine` is set explicitly to document intent (D19).
//
// The `givens.prompt` is a minimal id-only kickoff (D11): the session
// calls `writ-show` to fetch the full parent writ content.
//
// `givens.cwd` is omitted; the engine falls back to guild().home (D3).

/** Rig template for surveying a vision (survey-vision writ type). */
export const surveyVisionTemplate: RigTemplate = {
  engines: [
    {
      id: 'survey',
      designId: SUMMON_ENGINE_ID,
      givens: {
        role: 'scaffold-surveyor.survey-vision',
        prompt: 'Survey writ id: ${writ.id}\nParent vision id: ${writ.parentId}',
        writ: '${writ}',
      },
    },
  ],
  resolutionEngine: 'survey',
};

/** Rig template for surveying a charge (survey-charge writ type). */
export const surveyChargeTemplate: RigTemplate = {
  engines: [
    {
      id: 'survey',
      designId: SUMMON_ENGINE_ID,
      givens: {
        role: 'scaffold-surveyor.survey-charge',
        prompt: 'Survey writ id: ${writ.id}\nParent charge id: ${writ.parentId}',
        writ: '${writ}',
      },
    },
  ],
  resolutionEngine: 'survey',
};

/** Rig template for surveying a piece (survey-piece writ type). */
export const surveyPieceTemplate: RigTemplate = {
  engines: [
    {
      id: 'survey',
      designId: SUMMON_ENGINE_ID,
      givens: {
        role: 'scaffold-surveyor.survey-piece',
        prompt: 'Survey writ id: ${writ.id}\nParent piece id: ${writ.parentId}',
        writ: '${writ}',
      },
    },
  ],
  resolutionEngine: 'survey',
};

// ── Surveyor descriptor ───────────────────────────────────────────────
//
// D22: verbatim description string.
// D7: version matches package.json.
// D26: rigTemplates share the same object references as kit.rigTemplates.

const descriptor: SurveyorDescriptor = {
  id: 'scaffold-surveyor',
  description:
    'First-light scaffold surveyor: minimal LLM-driven decomposition for vision/charge/piece layers; designed to be replaced.',
  version: PACKAGE_VERSION,
  rigTemplates: {
    'survey-vision': surveyVisionTemplate,
    'survey-charge': surveyChargeTemplate,
    'survey-piece': surveyPieceTemplate,
  },
};

// ── Role definitions ──────────────────────────────────────────────────
//
// D6: model: 'sonnet' — bare string per Loom docstring convention.
// D8: instructionsFile in loom-roles/ subdirectory.
// D20: strict: true — tight tool surface, no permissionless tool leakage.
// D21: per-layer permission grants (patron-locked; no cartograph:read).
//
// Loom resolves instructionsFile relative to the npm package root:
//   path.join(home, 'node_modules', '@shardworks/scaffold-surveyor', instructionsFile)

const visionRole: KitRoleDefinition = {
  permissions: ['surveyor:create-charge', 'clerk:read'],
  strict: true,
  model: 'sonnet',
  instructionsFile: 'loom-roles/survey-vision.md',
};

const chargeRole: KitRoleDefinition = {
  permissions: ['surveyor:create-piece', 'surveyor:create-mandate', 'clerk:read'],
  strict: true,
  model: 'sonnet',
  instructionsFile: 'loom-roles/survey-charge.md',
};

const pieceRole: KitRoleDefinition = {
  permissions: ['surveyor:create-mandate', 'clerk:read'],
  strict: true,
  model: 'sonnet',
  instructionsFile: 'loom-roles/survey-piece.md',
};

// ── Kit plugin ────────────────────────────────────────────────────────
//
// D1: pure kit shape (no apparatus, no start()).
// Kit `requires` covers every apparatus the contributions reference.
// The custom engine design is registered under `engines` for the
// Fabricator to pick up — mirroring astrolabe's engine contribution.

const scaffoldSurveyorPlugin = {
  kit: {
    requires: ['surveyor', 'spider', 'animator', 'loom', 'clerk'],

    // Surveyor substrate contribution (D4: id = pluginId).
    surveyors: [descriptor],

    // Engine design for the Fabricator registry.
    engines: {
      [SUMMON_ENGINE_ID]: summonEngine as EngineDesign,
    },

    // Spider rig templates (bare names; Spider stores as pluginId.name).
    rigTemplates: {
      'survey-vision': surveyVisionTemplate,
      'survey-charge': surveyChargeTemplate,
      'survey-piece': surveyPieceTemplate,
    },

    // Spider writ-type → qualified template name (D10).
    rigTemplateMappings: {
      'survey-vision': 'scaffold-surveyor.survey-vision',
      'survey-charge': 'scaffold-surveyor.survey-charge',
      'survey-piece': 'scaffold-surveyor.survey-piece',
    },

    // Loom role definitions (D6/D8/D20/D21).
    roles: {
      'survey-vision': visionRole,
      'survey-charge': chargeRole,
      'survey-piece': pieceRole,
    } satisfies Record<string, KitRoleDefinition>,
  },
};

export default scaffoldSurveyorPlugin;
