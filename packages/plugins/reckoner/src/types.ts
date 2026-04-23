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
  /** Stuck cause written by Spider, when available. */
  stuckCause?: string;
  /** Spider-reported retryable flag. */
  retryable?: boolean;
  /** Human-readable detail string, when available. */
  detail?: string;
}

/** Context payload for `reckoner.writ-failed`. */
export interface WritFailedContext {
  /** Two-segment short id. */
  writShortId: string;
  /** Current title of the writ. */
  writTitle: string;
  /** Writ type. */
  writType: string;
  /** Resolution string recorded on the failed transition. */
  resolution?: string;
  /** Short ids of failed child writs referenced by the resolution, when parseable. */
  childFailures?: string[];
}

/** Context payload for `reckoner.queue-drained`. */
export interface QueueDrainedContext {
  /** ISO timestamp of the drain event. */
  drainedAt: string;
  /** Id of the writ whose terminal transition brought the queue to drain. */
  lastTerminalWritId: string;
}

// ── Trigger type ids ────────────────────────────────────────────

export const TRIGGER_WRIT_STUCK = 'reckoner.writ-stuck';
export const TRIGGER_WRIT_FAILED = 'reckoner.writ-failed';
export const TRIGGER_QUEUE_DRAINED = 'reckoner.queue-drained';

/** Plugin id stamped on `pulse.source`. Matches the package's apparatus id. */
export const RECKONER_PLUGIN_ID = 'reckoner';
