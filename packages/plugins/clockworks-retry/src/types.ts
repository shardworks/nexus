/**
 * Clockworks-retry public types.
 *
 * All types exported from @shardworks/clockworks-retry-apparatus.
 */

/**
 * Shape of the `status.spider.stuck` sub-object the retry clockwork reads.
 *
 * Populated by the sibling commission that introduces the `retryable` flag
 * — the observability substrate the clockwork keys on. Absent (or with
 * `retryable !== true`) means the stuck transition is not a retry candidate.
 */
export interface RetryableStuckStatus {
  /** Whether this stuck transition is a retry candidate. */
  retryable?: boolean;
  /** Optional stuck-cause identifier (e.g. 'engine-failure'). */
  cause?: string;
  /** ISO timestamp recorded at the moment the stuck transition was taken. */
  observedAt?: string;
}

/**
 * Runtime API exposed by the retry clockwork apparatus.
 *
 * The clockwork runs autonomously via a CDC watcher on the writs book; the
 * public API is intentionally small — it exposes the cap constant and a
 * self-reported name for diagnostic surfaces.
 */
export interface ClockworksRetryApi {
  /**
   * The maximum number of attempts (rigs) allowed before the clockwork
   * stops requeuing a retryable-stuck writ. Exposed for tests and for
   * surfaces that want to display the cap alongside the attempt count.
   */
  readonly maxAttempts: number;
}

/**
 * The single global cap on retry attempts — counted as `rigs.length` on
 * the writ. If the count is at or above this cap when the stuck fires,
 * the clockwork does not requeue the writ; it stays stuck for human
 * attention. See commission `c-mo814q`.
 */
export const MAX_RETRY_ATTEMPTS = 2;
