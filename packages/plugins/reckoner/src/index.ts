/**
 * @shardworks/reckoner-apparatus — The Reckoner.
 *
 * Petitioner registry and `petition()` / `withdraw()` helper
 * apparatus. v0 contract surface only — see the package README
 * and the contract document at
 * `docs/architecture/petitioner-registration.md`.
 */

// ── Public types ──────────────────────────────────────────────────────

export type {
  Priority,
  ComplexityTier,
  ReckonerExt,
  PetitionRequest,
  PetitionerDescriptor,
  ReckonerConfig,
  ReckonerApi,
  ReckoningDoc,
  ReckoningOutcome,
  ReckoningDeclineReason,
  ReckoningDeferReason,
  ReckoningVisionRelation,
  ReckoningSeverity,
} from './types.ts';

export {
  VISION_RELATION_VALUES,
  SEVERITY_VALUES,
  SCOPE_VALUES,
  DOMAIN_VALUES,
} from './types.ts';

// ── Factory ───────────────────────────────────────────────────────────

export { createReckoner } from './reckoner.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createReckoner } from './reckoner.ts';
export default createReckoner();
