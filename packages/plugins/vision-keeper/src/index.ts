/**
 * @shardworks/vision-keeper-apparatus — The Vision-keeper.
 *
 * Canonical worked-example petitioner from
 * `docs/architecture/petitioner-registration.md` §11. Emits vision-vs-
 * reality drift snapshots and proactive elaboration nudges through the
 * Reckoner, holds the outstanding-petition lifecycle in process memory,
 * and contributes a decline-feedback relay so a declined keeper writ
 * can route back into operator-visible logging via the Clockworks
 * standing-order surface.
 *
 * v0 ships the petitioner side only. The vision-artifact storage,
 * the drift-detection rig, and the rig that processes vision-keeper
 * writs remain owned by separate commissions; the Reckoner CDC
 * approval handler now lands in the Reckoner package and drives
 * keeper petitions out of `new` automatically.
 *
 * See: packages/plugins/vision-keeper/README.md and
 * docs/architecture/petitioner-registration.md §§1, 3, 4, 9, 11.
 */

// ── Public types ─────────────────────────────────────────────────────

export type {
  VisionKeeperApi,
  VisionSnapshotPayload,
  VisionSnapshotRequest,
} from './types.ts';

// ── Public constants ─────────────────────────────────────────────────

export {
  DECLINE_RELAY_NAME,
  VISION_ID_LABEL_KEY,
  VISION_KEEPER_SOURCE,
} from './constants.ts';

// ── Factory ──────────────────────────────────────────────────────────

export { createVisionKeeper, __internal } from './vision-keeper.ts';

// ── Default export: the apparatus plugin ─────────────────────────────

import { createVisionKeeper } from './vision-keeper.ts';
export default createVisionKeeper();
