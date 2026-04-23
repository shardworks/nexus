/**
 * Reckoner predicates — the decision logic that selects which writ
 * transitions are pulse-worthy.
 *
 * Kept separate from the CDC wiring so they can be unit-tested directly.
 *
 * Two main decisions live here:
 *
 *   - `isTerminalStuck` — terminal non-success stuck test. A stuck writ
 *     whose `status.spider.retryable !== true` OR whose rigs-for-writ
 *     count is at or above the clockworks-retry cap is "terminal" from
 *     the Reckoner's viewpoint (clockworks-retry will not requeue it).
 *     This is the complement of clockworks-retry's requeue condition.
 *   - `parseChildFailures` — extract leaf child-writ short ids from a
 *     parent's cascade-built resolution string so the context payload
 *     can surface them.
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

/**
 * Parse the child short-ids out of a Clerk-cascaded resolution string.
 *
 * Clerk's upward cascade writes the parent resolution as:
 *
 *     Child "w-abc123-deadbeef" failed: {child resolution}
 *
 * When a cascade is nested (child of child of root), the resolution text
 * carries the full quoted child id. We extract every distinct `w-…` id
 * that appears inside `Child "…" failed:` segments.
 *
 * Returns an empty array for resolutions that do not follow the cascade
 * pattern (e.g. an operator-supplied resolution string).
 */
export function parseChildFailures(resolution: string | undefined): string[] {
  if (!resolution) return [];
  const ids: string[] = [];
  const re = /Child "([^"]+)" failed:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(resolution)) !== null) {
    const id = m[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
