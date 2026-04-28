/**
 * Vision-keeper public types.
 *
 * The Vision-keeper is the canonical worked-example petitioner from
 * `docs/architecture/petitioner-registration.md` §11. It emits
 * vision-vs-reality snapshots through the Reckoner whenever it observes
 * drift worth surfacing, and proactive elaboration nudges when it sees
 * an opportunity to push the product further along the vision.
 *
 * v0 ships the petitioner side only — vision-artifact storage, drift
 * detection, the rig that processes vision-keeper writs, and the
 * Reckoner CDC approval handler are all owned by separate commissions.
 *
 * This file is the single source of public-symbol truth for downstream
 * consumers: every type that crosses the package boundary lives here,
 * including `VisionKeeperApi` (the apparatus's `provides` shape).
 *
 * See: docs/architecture/petitioner-registration.md (§11 worked example;
 * §1 helper API; §3 priority dimensions; §4 complexity; §9 Channel-1
 * standing-order feedback).
 */

import type { WritDoc } from '@shardworks/clerk-apparatus';
import type {
  ComplexityTier,
  Priority,
} from '@shardworks/reckoner-apparatus';

// ── Snapshot payload ─────────────────────────────────────────────────

/**
 * The typed payload the keeper stamps into every petition's
 * `ext.reckoner.payload` slot.
 *
 * The four fields are enumerated by the contract document's worked
 * example (§11). Future rigs that consume vision-keeper writs import
 * this type to bind their input shape; type-checking catches a missing
 * field at compile time rather than at first run.
 *
 * `visionId` and `snapshotTimestamp` are auto-filled by the keeper from
 * arguments the caller already supplies — the keeper never asks the
 * caller for the timestamp, and `visionId` is required on every emit
 * call (D8) so it is always present.
 *
 * `visionVsRealityDelta` and `metricValues` are the situation-specific
 * payload data the caller supplies. The keeper does not introspect
 * either field; the contract is between the caller and the rig.
 */
export interface VisionSnapshotPayload {
  /** Identifier of the vision this snapshot pertains to. */
  visionId: string;
  /** ISO timestamp the keeper stamped at emit time. */
  snapshotTimestamp: string;
  /**
   * Free-shape description of the gap between the vision and the
   * observed reality. The rig that processes the writ interprets this
   * field; the keeper stores it verbatim.
   */
  visionVsRealityDelta: unknown;
  /**
   * Bag of metric readings supporting the snapshot. The rig and the
   * caller agree on the shape; the keeper stores it verbatim.
   */
  metricValues: unknown;
}

// ── Caller-supplied request shapes ───────────────────────────────────

/**
 * Caller-supplied input for `submitDriftSnapshot()` /
 * `submitElaborationNudge()`.
 *
 * The keeper auto-fills the `visionId` and `snapshotTimestamp` fields
 * of the typed payload, so the caller hands in `visionId` once
 * (alongside the rest of the request) and the payload-data fields
 * separately. Title and body are caller-supplied required arguments —
 * the keeper has no model for descriptive text (D11).
 *
 * `severity`, `scope`, and `complexity` are optional per-call overrides
 * over the situation's hardcoded dimension preset (D5, D6). Callers
 * can also supply `codex` and `parentId` which pass straight through to
 * the underlying `reckoner.petition()` call (D12).
 */
export interface VisionSnapshotRequest {
  /** Identifier of the vision this snapshot pertains to. Required (D8). */
  visionId: string;
  /** Short human-readable title describing the snapshot. */
  title: string;
  /** Detail text. */
  body: string;
  /**
   * Free-shape description of the gap between the vision and observed
   * reality. Auto-stamped onto the typed payload's
   * `visionVsRealityDelta` field.
   */
  visionVsRealityDelta: unknown;
  /**
   * Metric readings supporting this snapshot. Auto-stamped onto the
   * typed payload's `metricValues` field.
   */
  metricValues: unknown;
  /** Per-call override of the situation's default severity (D6). */
  severity?: Priority['severity'];
  /** Per-call override of the situation's default scope (D6). */
  scope?: Priority['scope'];
  /**
   * Per-call override of the situation's default complexity. Drift-
   * snapshot petitions default to `'bounded'`; elaboration nudges
   * omit complexity entirely (D6).
   */
  complexity?: ComplexityTier;
  /** Optional target codex name. Passes through to `reckoner.petition()`. */
  codex?: string;
  /**
   * Optional parent writ id. Passes through to `reckoner.petition()`.
   * Vision-keeper itself imposes no nesting requirement; preserving
   * the Reckoner contract closes no doors for future consumers (D12).
   */
  parentId?: string;
}

// ── Apparatus API surface ────────────────────────────────────────────

/**
 * The Vision-keeper's runtime API — retrieved via
 * `guild().apparatus<VisionKeeperApi>('vision-keeper')`.
 *
 * Three methods, one per situation kind plus the explicit-supersede
 * lever (D5, D9):
 *
 *   - `submitDriftSnapshot()` — observed drift the keeper considers
 *     worth surfacing. Carries the brief's drift-default dimensions
 *     (vision-violator / serious / major-area, decay:true,
 *     domain:['quality'], complexity:'bounded').
 *
 *   - `submitElaborationNudge()` — proactive suggestion that the
 *     product can advance further along the vision. Carries the
 *     brief's elaboration-default dimensions (vision-advancer /
 *     moderate / minor-area, decay:false, domain:['feature']) and
 *     omits complexity by default.
 *
 *   - `superseded()` — explicit lever to withdraw the keeper's current
 *     outstanding petition for a given vision when the keeper's own
 *     observation has become stale (e.g. the underlying drift was
 *     resolved out-of-band). Unrelated to the auto-supersede that
 *     fires when the keeper emits a second petition for the same
 *     vision while one is still outstanding (D10).
 *
 * Both emit methods implement the auto-supersede invariant (D10): when
 * the keeper has an outstanding petition for the same `visionId`, the
 * prior writ is withdrawn (with a "superseded by newer snapshot"
 * reason) before the new one is created. The keeper holds the
 * outstanding-petition map in process memory only; persistence across
 * restart is a separate follow-up (D9).
 */
export interface VisionKeeperApi {
  /**
   * Emit a vision-vs-reality drift snapshot for `visionId`.
   *
   * Default dimensions (overridable per-call via the request):
   *   - visionRelation: 'vision-violator'
   *   - severity: 'serious'
   *   - scope: 'major-area'
   *   - time: { decay: true, deadline: null }
   *   - domain: ['quality']
   *   - complexity: 'bounded'
   *
   * Auto-supersede behavior (D10): if an outstanding petition already
   * exists for this `visionId`, the keeper withdraws it (with a
   * superseded-reason) before posting the new one.
   *
   * Returns the resulting writ — `phase: 'new'`, with
   * `ext.reckoner.source = 'vision-keeper.snapshot'`, the typed
   * `VisionSnapshotPayload` on `ext.reckoner.payload`, and the
   * `vision-keeper.io/vision-id` label on `ext.reckoner.labels`.
   */
  submitDriftSnapshot(request: VisionSnapshotRequest): Promise<WritDoc>;

  /**
   * Emit a proactive elaboration nudge for `visionId`.
   *
   * Default dimensions (overridable per-call via the request):
   *   - visionRelation: 'vision-advancer'
   *   - severity: 'moderate'
   *   - scope: 'minor-area'
   *   - time: { decay: false, deadline: null }
   *   - domain: ['feature']
   *   - complexity: omitted by default
   *
   * Auto-supersede behavior is identical to `submitDriftSnapshot()` —
   * the keeper tracks outstanding petitions per `visionId` regardless
   * of the situation kind that produced them.
   */
  submitElaborationNudge(request: VisionSnapshotRequest): Promise<WritDoc>;

  /**
   * Withdraw the keeper's outstanding petition for `visionId`, if any.
   *
   * No-op when no outstanding petition exists for the given vision —
   * the keeper does not throw on the empty case so callers can use it
   * as an idempotent "ensure no outstanding petition for this vision"
   * lever.
   *
   * Returns the withdrawn writ when one was actually withdrawn, or
   * `null` when there was nothing to withdraw.
   *
   * `reason` is passed through to `reckoner.withdraw()` verbatim;
   * undefined stays undefined.
   */
  superseded(visionId: string, reason?: string): Promise<WritDoc | null>;
}
