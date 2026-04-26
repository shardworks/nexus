/**
 * Drain detection — the "queue drained" predicate.
 *
 * The queue is "drained" when:
 *
 *   - the Clerk's classification-aware `countActive()` is zero (no writ
 *     of any registered type is currently in an `active`-classified
 *     state), AND
 *   - there are zero rigs in `running` or `blocked` status.
 *
 * `countActive()` is the post-T4 successor to the prior `phase = 'open'`
 * count. It is type-agnostic — every registered writ type contributes
 * its declared `active` states. Mandate's `stuck` is classified
 * `active`, so a stuck mandate now holds drain back; that is the
 * intended classification-driven semantic and is a behavior shift from
 * the pre-T4 phase-literal predicate (covered by `drain.test.ts`).
 *
 * This module owns the predicate; the Reckoner's observer calls into it
 * after every terminal transition. There is intentionally no dedupe
 * across bursts — false-positive drain pulses are an accepted MVP
 * limit.
 */

import type { ReadOnlyBook } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Minimal shape of a Spider rig row — the only field we read is `status`.
 * Kept local to avoid importing `RigDoc` from `@shardworks/spider-apparatus`
 * (Spider is a recommend, not a require).
 */
interface RigRow extends Record<string, unknown> {
  id: string;
  status: string;
}

/**
 * Evaluate the drain predicate.
 *
 * Returns true iff both counts are zero: classification-driven active
 * writs (across every registered writ type) and Spider-side active rigs.
 */
export async function isQueueDrained(
  clerk: ClerkApi,
  rigs: ReadOnlyBook<RigRow>,
): Promise<boolean> {
  const [activeWrits, activeRigs] = await Promise.all([
    clerk.countActive(),
    rigs.count([['status', 'IN', ['running', 'blocked']]]),
  ]);
  return activeWrits === 0 && activeRigs === 0;
}
