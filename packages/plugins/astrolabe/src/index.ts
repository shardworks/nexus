/**
 * @shardworks/astrolabe-apparatus — The Astrolabe.
 *
 * Brief-to-specification planning: transforms patron briefs into structured
 * work specifications through a multi-stage pipeline of inventory, analysis,
 * patron review, and specification writing.
 *
 * See: docs/architecture/apparatus/astrolabe.md
 */

// ── Astrolabe API ────────────────────────────────────────────────────

export type {
  PlanDoc,
  ScopeItem,
  Decision,
  DecisionAnalysis,
  PlanStatus,
  PlanFilters,
  AstrolabeConfig,
  AstrolabeApi,
} from './types.ts';

export { createAstrolabe } from './astrolabe.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createAstrolabe } from './astrolabe.ts';
export default createAstrolabe();
