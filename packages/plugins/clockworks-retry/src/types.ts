/**
 * Clockworks-retry public types.
 *
 * All types exported from @shardworks/clockworks-retry-apparatus.
 *
 * The substrate this clockwork reads — the plugin-owned `status.spider`
 * sub-slot on a writ — is authoritatively typed by the producer. We
 * re-export that type here so consumers of the retry apparatus have a
 * single import path for the shape the clockwork keys on, and so the
 * retry clockwork itself keys on the producer's type rather than a
 * duplicated local declaration.
 */

export type { SpiderWritStatus } from '@shardworks/spider-apparatus';

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
