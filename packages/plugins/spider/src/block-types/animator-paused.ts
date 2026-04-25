/**
 * Built-in block type: animator-paused.
 *
 * Blocks until the Animator's rate-limit back-off machine transitions
 * back to `running` OR the persisted `pausedUntil` window has elapsed.
 *
 * Condition shape is deliberately minimal: the block carries no window
 * parameters because the authoritative state lives on the Animator's
 * status book. We identify the triggering session for diagnostic /
 * audit purposes only — the checker always asks the Animator for the
 * current state, never the condition itself.
 *
 * See: commission c-moceibx2 (rate-limit-aware scheduling).
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { isDispatchable } from '@shardworks/animator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { BlockType, CheckResult } from '../types.ts';

// The outer object is `.optional()` so legacy engines persisted under
// the pre-`attempts[]` schema — `holdReason: 'animator-paused'` with no
// `holdCondition` — resolve quietly through `check()` instead of
// throwing a ZodError that the dispatch predicate's catch logs as a
// warning. Populated conditions still validate against the inner shape;
// malformed payloads (e.g. `{ sessionId: 42 }`) are still rejected.
const conditionSchema = z
  .object({
    /** Session id that triggered the pause — informational. */
    sessionId: z.string().optional(),
  })
  .optional();

const animatorPausedBlockType: BlockType = {
  id: 'animator-paused',
  conditionSchema,
  // Poll every 10s: fast enough to pick up resume quickly, slow enough
  // not to hammer the status book. The block clears on the next tick
  // after `pausedUntil` elapses.
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<CheckResult> {
    conditionSchema.parse(condition);
    let animator: AnimatorApi;
    try {
      animator = guild().apparatus<AnimatorApi>('animator');
    } catch {
      // Animator not installed — the block cannot be resolved
      // authoritatively; keep the engine blocked rather than failing
      // or clearing it arbitrarily.
      return { status: 'pending' };
    }
    const status = await animator.getStatus();
    // Delegate to the canonical predicate from the animator package so
    // this checker stays in lockstep with the back-off machine, the
    // crawl-gate, and the Oculus banner.
    return { status: isDispatchable(status) ? 'cleared' : 'pending' };
  },
};

export default animatorPausedBlockType;
