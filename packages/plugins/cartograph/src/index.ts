/**
 * @shardworks/cartograph-apparatus — The Cartograph.
 *
 * Decomposition-ladder data substrate: contributes the `vision`, `charge`,
 * and `piece` writ types to the Clerk and exposes a typed API that
 * enforces the ladder's parent invariants.
 *
 * See: README.md
 */

// ── Cartograph public types ────────────────────────────────────────────

export type {
  // Companion projections
  VisionDoc,
  ChargeDoc,
  PieceDoc,

  // Stage enums
  VisionStage,
  ChargeStage,
  PieceStage,

  // ext sub-slot
  CartographExt,

  // Filters
  VisionFilters,
  ChargeFilters,
  PieceFilters,

  // Create requests
  CreateVisionRequest,
  CreateChargeRequest,
  CreatePieceRequest,

  // Transition requests
  TransitionVisionRequest,
  TransitionChargeRequest,
  TransitionPieceRequest,

  // API surface
  CartographApi,
} from './types.ts';

export { createCartograph } from './cartograph.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createCartograph } from './cartograph.ts';
export default createCartograph();
