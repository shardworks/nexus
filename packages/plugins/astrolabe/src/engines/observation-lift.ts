/**
 * observation-lift clockwork engine.
 *
 * Walks the plan's `observations` array once it has reached its final
 * state and creates one draft brief writ per record as a child of the
 * originating brief. This turns the sage's "things we noticed but
 * didn't action" output from an inert note into commissionable drafts
 * visible in the same writ surfaces as any other brief — a downstream
 * curator (human or automated) promotes each draft to `open` by hand
 * or via writ-publish.
 *
 * Behavior:
 *   - Validates that the plan exists and its status is `completed`.
 *     (Placement inside the plan-and-ship rig guarantees this —
 *     observation-lift runs after plan-finalize, which transitions the
 *     plan to `completed`.)
 *   - Silently no-ops if `plan.observations` is not an array (legacy
 *     string-shaped plandocs) or is an empty array.
 *   - Otherwise, iterates the array in order and calls
 *     `clerk.post({ type: 'brief', title, body, codex, parentId, draft })`
 *     once per record. The brief writ must still be in a non-terminal
 *     phase at this point — the engine runs before seal, which is what
 *     finally transitions the brief to `completed`.
 *   - Fails fast on the first `clerk.post` error. Already-created
 *     drafts persist as `new`-status writs under the brief; they are
 *     invisible to the Spider until a curator publishes them.
 *   - Does not mutate the plandoc — the parentId relationship on the
 *     created writs is the sole audit trail.
 *
 * Yields:
 *   `{ writIds }` — the ids of the draft writs created, in the same
 *   order as the observation records. Empty when the engine no-ops.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { PlanDoc } from '../types.ts';

export function createObservationLiftEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.observation-lift',

    async run(
      givens: Record<string, unknown>,
      _context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const planId = givens.planId as string;
      const book = getPlansBook();

      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      if (plan.status !== 'completed') {
        throw new Error(
          `observation-lift: expected plan status "completed" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      const observations = plan.observations;
      if (!Array.isArray(observations) || observations.length === 0) {
        // Legacy string-shaped plandocs or empty arrays: no-op.
        return {
          status: 'completed',
          yields: { writIds: [] as string[] },
        };
      }

      const clerk = guild().apparatus<ClerkApi>('clerk');
      const writIds: string[] = [];

      for (const observation of observations) {
        // Fail-fast: any clerk.post error propagates immediately.
        // Previously-created drafts persist (invisible to Spider) and
        // a curator can reconcile manually — rollback is not attempted.
        const writ = await clerk.post({
          type: 'brief',
          title: observation.title,
          body: observation.body,
          codex: plan.codex,
          parentId: planId,
          draft: true,
        });
        writIds.push(writ.id);
      }

      return {
        status: 'completed',
        yields: { writIds },
      };
    },
  };
}
