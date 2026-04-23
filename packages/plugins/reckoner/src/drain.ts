/**
 * Drain detection — the "queue drained" predicate.
 *
 * Per D7 in the brief, the queue is "drained" when:
 *
 *   - there are zero writs in `open` phase, AND
 *   - there are zero rigs in `running` or `blocked` status.
 *
 * Stuck writs are excluded: retryable stucks flip back to open within one
 * retry tick; terminal stucks are effectively drained from the
 * auto-dispatcher's viewpoint (Spider will not try to spawn a new rig).
 *
 * This module owns the definition; the Reckoner's observer calls into it
 * after every terminal transition. There is intentionally no dedupe
 * across bursts — false-positive drain pulses are an accepted MVP limit.
 */

import type { ReadOnlyBook } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

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
 * Returns true iff both counts are zero: open writs and active rigs.
 */
export async function isQueueDrained(
  writs: ReadOnlyBook<WritDoc>,
  rigs: ReadOnlyBook<RigRow>,
): Promise<boolean> {
  const [openWrits, activeRigs] = await Promise.all([
    writs.count([['phase', '=', 'open']]),
    rigs.count([['status', 'IN', ['running', 'blocked']]]),
  ]);
  return openWrits === 0 && activeRigs === 0;
}
