/**
 * Reckoner public types.
 *
 * The Reckoner is a narrow MVP observer: a Phase 2 CDC watcher on
 * `clerk/writs` that emits Lattice pulses for three trigger types
 * (`reckoner.writ-stuck`, `reckoner.writ-failed`, `reckoner.queue-drained`).
 * It has no persistent state and no user-facing configuration.
 */

/**
 * Runtime API exposed by the Reckoner.
 *
 * The Reckoner runs autonomously via CDC; its public API is intentionally
 * small — just enough for surfaces that want to list or inspect the trigger
 * types the Reckoner produces.
 */
export interface ReckonerApi {
  /** Emitter plugin id — stamped on `pulse.source` for every pulse this observer emits. */
  readonly source: string;
  /** The three trigger types this observer produces. */
  readonly triggerTypes: readonly string[];
}

// ── Context payloads per trigger type (D30) ──────────────────────

/**
 * Dedupe-identity field present on every Reckoner context payload.
 *
 * The triggering writ's `updatedAt` stamp — every Clerk transition bumps
 * `updatedAt`, so `(writId, triggerType, writUpdatedAt)` is a true
 * per-transition identity. A CDC replay fires with the same `updatedAt`
 * and is suppressed by the emitter's idempotency guard; a legitimate
 * re-visit of the same phase pair gets a fresh `updatedAt` and a fresh
 * pulse. See `docs/architecture/apparatus/sentinel.md` §"Idempotency
 * under replay".
 *
 * For `QueueDrainedContext`, this carries the triggering (terminal)
 * writ's `updatedAt` alongside the existing `lastTerminalWritId`.
 */

/** Context payload for `reckoner.writ-stuck`. */
export interface WritStuckContext {
  /** Two-segment short id (`w-abc123`). */
  writShortId: string;
  /** Phase at emit time — always `'stuck'` here. */
  writPhase: 'stuck';
  /** Current title of the writ. */
  writTitle: string;
  /** Writ type. */
  writType: string;
  /** Dedupe-identity: triggering writ's `updatedAt` at emit time. */
  writUpdatedAt: string;
  /** Stuck cause written by Spider, when available. */
  stuckCause?: string;
}

/**
 * Per-attempt summary entry surfaced on `WritFailedContext.engineFailure.attemptsSummary`.
 *
 * Mirrors a Spider `EngineAttempt` row, less the `yields` payload — the
 * pulse is a diagnostic surface, not an audit log, and yields can balloon
 * the context size without serving a named consumer.
 *
 * Every field is optional because the source `EngineAttempt` row keeps
 * them optional while an attempt is in flight or terminates without a
 * session id.
 */
export interface EngineAttemptSummary {
  /** ISO timestamp when the attempt started. */
  startedAt?: string;
  /** ISO timestamp when the attempt terminated; absent while in-flight. */
  endedAt?: string;
  /**
   * Terminal attempt status — only the two terminal outcomes a single
   * attempt can reach. Absent while the attempt is still in-flight.
   */
  status?: 'completed' | 'failed';
  /** Error message if the attempt terminated in `'failed'`. */
  error?: string;
  /** Animator session id associated with this attempt, if any. */
  sessionId?: string;
}

/**
 * Engine-failure enrichment block on `WritFailedContext`.
 *
 * Present only when the failed root mandate has a rig in `failed` status
 * with at least one engine in `failed` status. Surfaces the design-click
 * diagnostic fields so a patron reading the pulse can identify the failed
 * engine, attempt count, and per-attempt error trail without dropping
 * into `nsg rig show`.
 */
export interface EngineFailureContext {
  /** Rig id whose failed engine produced this enrichment. */
  rigId: string;
  /** Engine instance id within the rig (e.g. 'draft', 'implement'). */
  engineId: string;
  /** Engine design id — the Fabricator design key. */
  engineDesignId: string;
  /**
   * Retry budget consumed by the failed engine. Absent on rigs whose
   * failed engine never had its retry counter incremented (rare: a
   * fail-fast engine with `maxAttempts: 0`).
   */
  attemptCount?: number;
  /**
   * Most recent attempt's error message — the `error` field on the tail
   * `EngineAttempt` row when its `status === 'failed'`. Absent when the
   * tail attempt has no error string.
   */
  lastError?: string;
  /**
   * Ordered list of attempt summaries copied from the engine's
   * `attempts[]` array. Empty when the engine has never been dispatched
   * (which would be unusual on a `failed` engine but is tolerated).
   */
  attemptsSummary: EngineAttemptSummary[];
}

/** Context payload for `reckoner.writ-failed`. */
export interface WritFailedContext {
  /** Two-segment short id. */
  writShortId: string;
  /** Current title of the writ. */
  writTitle: string;
  /** Writ type. */
  writType: string;
  /** Dedupe-identity: triggering writ's `updatedAt` at emit time. */
  writUpdatedAt: string;
  /** Resolution string recorded on the failed transition. */
  resolution?: string;
  /** Short ids of failed child writs referenced by the resolution, when parseable. */
  childFailures?: string[];
  /**
   * Optional engine-failure enrichment block. Present when the failed
   * mandate has a `failed` rig with a `failed` engine; absent for
   * patron-driven failures, cascade-only failures, and rigs whose engines
   * are all in non-failed terminal states.
   */
  engineFailure?: EngineFailureContext;
}

/** Context payload for `reckoner.queue-drained`. */
export interface QueueDrainedContext {
  /** ISO timestamp of the drain event. */
  drainedAt: string;
  /** Id of the writ whose terminal transition brought the queue to drain. */
  lastTerminalWritId: string;
  /**
   * Dedupe-identity: the triggering (terminal) writ's `updatedAt` at
   * emit time. Combined with `lastTerminalWritId`, this identifies the
   * drain-evaluating transition uniquely across a CDC replay.
   */
  writUpdatedAt: string;
}

// ── Trigger type ids ────────────────────────────────────────────

export const TRIGGER_WRIT_STUCK = 'reckoner.writ-stuck';
export const TRIGGER_WRIT_FAILED = 'reckoner.writ-failed';
export const TRIGGER_QUEUE_DRAINED = 'reckoner.queue-drained';

/** Plugin id stamped on `pulse.source`. Matches the package's apparatus id. */
export const RECKONER_PLUGIN_ID = 'reckoner';
