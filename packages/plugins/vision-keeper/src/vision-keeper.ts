/**
 * The Vision-keeper apparatus — petitioner-side worked example.
 *
 * Implements the three caller-facing methods (drift snapshot,
 * elaboration nudge, explicit supersede) declared on `VisionKeeperApi`,
 * plus the auto-supersede invariant (D10) that holds the keeper's
 * outstanding-petition map to at-most-one writ per `visionId`.
 *
 * The Reckoner handle is resolved once at `start()` and closed over by
 * every subsequent call (D23). Reckoner is a hard `requires` (D21), so
 * the framework guarantees readiness before this apparatus's `start()`
 * runs.
 *
 * The runtime never calls Clerk directly — every petition / withdrawal
 * routes through the cached `reckoner.petition` / `reckoner.withdraw`
 * handles. That keeps the `ext.reckoner` slot single-sourced through
 * the petition-helper boundary and avoids drift if the Reckoner later
 * grows additional pre-write enrichment.
 *
 * See: docs/architecture/petitioner-registration.md §11 (worked
 * example), §1 (helper API), §3 (priority dimensions), §4 (complexity).
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type {
  ComplexityTier,
  PetitionRequest,
  Priority,
  ReckonerApi,
} from '@shardworks/reckoner-apparatus';

import {
  DECLINE_RELAY_NAME,
  VISION_ID_LABEL_KEY,
  VISION_KEEPER_SOURCE,
} from './constants.ts';
import { createDeclineRelay } from './decline-relay.ts';
import type {
  VisionKeeperApi,
  VisionSnapshotPayload,
  VisionSnapshotRequest,
} from './types.ts';

// ── Petitioner descriptor (verbatim from the brief, D4) ──────────────

/**
 * Description string declared in the petitioner kit contribution. The
 * brief supplies the exact words; tests assert the verbatim match
 * against the registered descriptor (Acceptance Signal "kit declaration
 * round-trips").
 */
const VISION_KEEPER_DESCRIPTION =
  'Vision-vs-reality snapshots emitted when the keeper observes drift worth surfacing.';

// ── Auto-supersede reason (D10) ──────────────────────────────────────

/** Reason recorded on the prior writ when the keeper auto-supersedes. */
const AUTO_SUPERSEDE_REASON =
  'superseded by newer snapshot from the vision-keeper.';

// ── Dimension presets (D5, D6) ───────────────────────────────────────

/**
 * Drift-snapshot default priority dimensions. Quoted from the brief's
 * worked example: a drift observation is by construction a vision
 * violation, the contract default decay flag is `true` (drift sentinel
 * exhibit A), and the domain tag is `quality`.
 *
 * `severity` and `scope` callers can override per-call (the contract
 * document calls out the "or critical for severe drift" escalation).
 * `time.deadline` stays `null` because drift detection is decay-driven,
 * not deadline-driven; if a downstream consumer needs deadlines, the
 * Reckoner's per-call partial-priority merge handles it.
 */
function driftDimensionPreset(): Priority {
  return {
    visionRelation: 'vision-violator',
    severity: 'serious',
    scope: 'major-area',
    time: { decay: true, deadline: null },
    domain: ['quality'],
  };
}

/** Default complexity for drift snapshots — `'bounded'` per the brief. */
const DRIFT_DEFAULT_COMPLEXITY: ComplexityTier = 'bounded';

/**
 * Elaboration-nudge default priority dimensions. A proactive
 * elaboration is by construction vision-advancing, with no decay
 * (the elaboration is not actively drifting), and a `feature` domain
 * tag. The brief specifies omitting complexity by default — the keeper
 * surfaces the per-call override only.
 */
function elaborationDimensionPreset(): Priority {
  return {
    visionRelation: 'vision-advancer',
    severity: 'moderate',
    scope: 'minor-area',
    time: { decay: false, deadline: null },
    domain: ['feature'],
  };
}

/**
 * Apply per-call overrides to a dimension preset. Field-by-field merge
 * to mirror the Reckoner's `mergePriorityWithDefaults` behavior — a
 * caller specifying a single dimension lets the rest fall through to
 * the situation's default.
 */
function applyOverrides(
  base: Priority,
  overrides: { severity?: Priority['severity']; scope?: Priority['scope'] },
): Priority {
  return {
    visionRelation: base.visionRelation,
    severity: overrides.severity ?? base.severity,
    scope: overrides.scope ?? base.scope,
    time: { decay: base.time.decay, deadline: base.time.deadline },
    domain: [...base.domain],
  };
}

// ── Apparatus factory ────────────────────────────────────────────────

/**
 * Build the Vision-keeper apparatus.
 *
 * Closure-scoped state:
 *   - `reckoner` — Reckoner handle resolved at `start()` (D23).
 *   - `outstandingByVision` — in-memory `Map<visionId, writId>`. The
 *     auto-supersede invariant holds this to at most one entry per
 *     `visionId` at any time. Persistence across restart is a
 *     separate follow-up (D9 limitation).
 */
export function createVisionKeeper(): Plugin {
  let reckoner: ReckonerApi | undefined;
  const outstandingByVision = new Map<string, string>();

  /**
   * Resolve the Reckoner handle. `start()` populates it; calls before
   * `start()` (or against a malformed apparatus map) throw a clear
   * diagnostic naming the package — saves the caller a layer of
   * stack-trace digging.
   */
  function reckonerOrThrow(): ReckonerApi {
    if (!reckoner) {
      throw new Error(
        '[vision-keeper] Reckoner handle is not yet resolved. The apparatus must be started before any submitDriftSnapshot/submitElaborationNudge/superseded call.',
      );
    }
    return reckoner;
  }

  /**
   * Common emit path shared between drift snapshots and elaboration
   * nudges. Builds the typed payload, applies the dimension preset
   * (with per-call overrides), runs the auto-supersede check, and
   * routes through `reckoner.petition()`.
   *
   * On success the keeper records the new writ id under
   * `outstandingByVision[visionId]` so the next emit on the same
   * vision auto-supersedes this one.
   */
  async function emit(
    request: VisionSnapshotRequest,
    preset: Priority,
    defaultComplexity: ComplexityTier | undefined,
  ): Promise<WritDoc> {
    if (typeof request.visionId !== 'string' || request.visionId.length === 0) {
      // Required on every call (D8). Fail-loud at the helper boundary;
      // a missing visionId would silently route the snapshot under a
      // wrong key in `outstandingByVision` (it would key as `''`).
      throw new Error(
        '[vision-keeper] visionId is required on every emit call and must be a non-empty string.',
      );
    }

    const r = reckonerOrThrow();

    // Auto-supersede (D10): if there is an outstanding petition for
    // this vision, withdraw it before posting the new one. We do this
    // first so a failure withdrawing the prior surfaces before any
    // new writ is created.
    const prior = outstandingByVision.get(request.visionId);
    if (prior !== undefined) {
      // Forget the entry first so a withdraw failure doesn't leave a
      // stale entry pointing to an in-limbo writ — the failure path's
      // diagnostic is the single source of truth.
      outstandingByVision.delete(request.visionId);
      await r.withdraw(prior, AUTO_SUPERSEDE_REASON);
    }

    // Auto-fill the typed payload's keeper-controlled fields.
    const payload: VisionSnapshotPayload = {
      visionId: request.visionId,
      snapshotTimestamp: new Date().toISOString(),
      visionVsRealityDelta: request.visionVsRealityDelta,
      metricValues: request.metricValues,
    };

    // Apply caller overrides over the situation's preset.
    const priority = applyOverrides(preset, {
      severity: request.severity,
      scope: request.scope,
    });

    // Complexity: caller override > situation default. Elaboration
    // nudges have no situation default — `defaultComplexity` arrives
    // as `undefined` and the keeper omits the field unless the caller
    // supplied one.
    const complexity =
      request.complexity !== undefined ? request.complexity : defaultComplexity;

    const petitionRequest: PetitionRequest = {
      source: VISION_KEEPER_SOURCE,
      title: request.title,
      body: request.body,
      priority,
      payload,
      labels: { [VISION_ID_LABEL_KEY]: request.visionId },
      ...(complexity !== undefined ? { complexity } : {}),
      ...(request.codex !== undefined ? { codex: request.codex } : {}),
      ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
    };

    const writ = await r.petition(petitionRequest);
    outstandingByVision.set(request.visionId, writ.id);
    return writ;
  }

  const api: VisionKeeperApi = {
    submitDriftSnapshot(request: VisionSnapshotRequest): Promise<WritDoc> {
      return emit(request, driftDimensionPreset(), DRIFT_DEFAULT_COMPLEXITY);
    },

    submitElaborationNudge(request: VisionSnapshotRequest): Promise<WritDoc> {
      // Elaboration nudges omit complexity by default (D6). Callers
      // can still provide it via `request.complexity`; the third
      // argument here is `undefined` so the situation default does
      // not stamp one.
      return emit(request, elaborationDimensionPreset(), undefined);
    },

    async superseded(
      visionId: string,
      reason?: string,
    ): Promise<WritDoc | null> {
      if (typeof visionId !== 'string' || visionId.length === 0) {
        throw new Error(
          '[vision-keeper] superseded(): visionId must be a non-empty string.',
        );
      }
      const r = reckonerOrThrow();
      const writId = outstandingByVision.get(visionId);
      if (writId === undefined) {
        // Idempotent no-op (D9): callers can use this as an "ensure no
        // outstanding petition" lever without checking first.
        return null;
      }
      outstandingByVision.delete(visionId);
      return r.withdraw(writId, reason);
    },
  };

  // ── Plugin ─────────────────────────────────────────────────────────

  const plugin: Plugin = {
    apparatus: {
      // Reckoner is a hard `requires` (D21): without it the keeper
      // cannot petition at all. Clockworks is a soft `recommends`
      // because the keeper still works for emit/withdraw without
      // standing orders — only the decline-feedback channel needs it.
      requires: ['reckoner'],
      recommends: ['clockworks'],

      // The keeper is a producer of kit-contributed petitioner and
      // relay descriptors via supportKit; it is not a consumer of any
      // kit type.
      provides: api,

      supportKit: {
        // Petitioner kit declaration — the Reckoner consumes this
        // contribution under the `petitioners` kit type and registers
        // the descriptor in its kit-static registry. The description
        // is the verbatim brief text (D4).
        petitioners: [
          {
            source: VISION_KEEPER_SOURCE,
            description: VISION_KEEPER_DESCRIPTION,
          },
        ],
        // Decline-feedback relay — the Clockworks consumes this
        // contribution under the `relays` kit type. Operators wire a
        // standing order against `book.clerk.writs.updated` with
        // `run: 'vision-keeper-on-decline'` (see README); the relay
        // module owns the filter.
        relays: [createDeclineRelay()],
      },

      start(_ctx: StartupContext): void {
        // Resolve the Reckoner handle once and close over it. The
        // `requires: ['reckoner']` declaration guarantees the
        // Reckoner has already started by the time we run.
        reckoner = guild().apparatus<ReckonerApi>('reckoner');
      },
    },
  };

  return plugin;
}

// ── Test-only internals (D20) ────────────────────────────────────────

/**
 * Internal helpers exported for tests. Not part of the public package
 * surface — the package's `index.ts` re-exports these via the same
 * `__internal` named export so unit tests can drive the dimension-
 * preset builders without booting an apparatus.
 */
export const __internal = {
  driftDimensionPreset,
  elaborationDimensionPreset,
  applyOverrides,
  AUTO_SUPERSEDE_REASON,
  VISION_KEEPER_DESCRIPTION,
  DRIFT_DEFAULT_COMPLEXITY,
  DECLINE_RELAY_NAME,
};
