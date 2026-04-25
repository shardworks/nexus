/**
 * Reckoner predicates — the decision logic that selects which writ
 * transitions are pulse-worthy.
 *
 * Kept separate from the CDC wiring so it can be unit-tested directly.
 *
 * One decision lives here:
 *
 *   - `isTerminalStuck` — terminal non-success stuck test. A stuck writ
 *     whose `status.spider.retryable !== true` OR whose rigs-for-writ
 *     count is at or above the clockworks-retry cap is "terminal" from
 *     the Reckoner's viewpoint (clockworks-retry will not requeue it).
 *     This is the complement of clockworks-retry's requeue condition.
 *
 * Leaf-cause surfacing for cascaded pulses is no longer a predicate
 * responsibility: the Clerk's children-behavior cascade engine writes the
 * triggering child id under the parent's `status['clerk']` sub-slot and
 * the Reckoner walks that chain at emit time (see
 * `chaseTriggeringChildren` in `reckoner.ts`).
 */

/**
 * Minimal shape of the Spider-owned sub-slot this module reads.
 *
 * Re-declared here (rather than imported from `@shardworks/spider-apparatus`)
 * to keep the Reckoner's import graph narrow — Spider is a recommend, not
 * a require. A writ whose `status.spider` slot is absent is still handled
 * correctly: `isTerminalStuck` treats missing-flag as terminal (the writ
 * will never be requeued by clockworks-retry's fail-safe behavior).
 */
export interface SpiderStuckStatus {
  stuckCause?: string;
  retryable?: boolean;
  detail?: string;
}

/**
 * Decide whether a stuck writ should trigger a `reckoner.writ-stuck` pulse.
 *
 * Returns true when:
 *   - `status.spider.retryable !== true` (definitional non-retryable OR
 *     missing flag — clockworks-retry's fail-safe: stays stuck).
 *   - OR the rigs-for-writ count is at or above the max-attempts cap.
 *
 * When `maxAttempts` is `undefined` (clockworks-retry not installed), every
 * stuck is terminal from the Reckoner's viewpoint — there is no retry to
 * rescue it. D16 in the commission brief.
 *
 * @param spiderStatus  The value of `writ.status?.spider`, or undefined.
 * @param rigCount      Number of rigs on this writ.
 * @param maxAttempts   The retry cap resolved at emit time, or undefined
 *                      if clockworks-retry is not installed.
 */
export function isTerminalStuck(
  spiderStatus: SpiderStuckStatus | undefined,
  rigCount: number,
  maxAttempts: number | undefined,
): boolean {
  // No clockworks-retry installed → no retry → every stuck is terminal.
  if (maxAttempts === undefined) return true;

  // Non-retryable (or missing retryable flag) → clockworks-retry leaves it.
  if (spiderStatus?.retryable !== true) return true;

  // Cap reached → clockworks-retry will not requeue.
  if (rigCount >= maxAttempts) return true;

  return false;
}

