/**
 * observation-lift clockwork engine.
 *
 * Walks the plan's `observations` array once it has reached its final
 * state and creates one draft mandate writ per record as a child of the
 * originating mandate. This turns the sage's "things we noticed but
 * didn't action" output from an inert note into commissionable drafts
 * visible in the same writ surfaces as any other mandate — a downstream
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
 *   - Otherwise, iterates the array in order and, per record:
 *       1. Calls `clerk.post({ type: 'mandate', title, body, codex,
 *          parentId, draft })` to create a draft mandate writ as a
 *          child of the originating mandate. The mandate writ must
 *          still be in a non-terminal phase at this point — the engine
 *          runs before seal, which is what finally transitions the
 *          mandate to `completed`.
 *       2. Calls `clerk.link(newWritId, planId, 'depends on',
 *          'spider.follows')` to install a precedence-dependency edge
 *          from the newly posted draft back to the originating mandate.
 *          The lifted observations describe concerns that presume the
 *          originating mandate has shipped; this link enlists the
 *          Spider's `trySpawn` gate to hold each lifted writ until the
 *          originating mandate reaches a terminal state (release on
 *          `completed`/`cancelled`, cascade to `stuck` on `failed`).
 *   - Emits two complementary edges per observation: the parent-child
 *     edge from `clerk.post` (provenance / audit trail) and the
 *     `spider.follows` edge from `clerk.link` (precedence gating).
 *   - Fails fast on the first error from either `clerk.post` or
 *     `clerk.link`. Already-created post+link pairs persist under the
 *     mandate; if the failure is in `clerk.link`, the writ for the
 *     current observation persists as a draft without the dependency
 *     edge — the loud failure is itself the signal for curator
 *     reconciliation. Drafts persist as `new`-status writs under the
 *     mandate; they are invisible to the Spider until a curator
 *     publishes them, and the precedence edge then takes effect.
 *   - Does not mutate the plandoc — the parent-child edge from
 *     `clerk.post` and the `spider.follows` edge from `clerk.link`
 *     together form the audit trail.
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
        // Per-record: post then link before the next iteration. Errors
        // from either call propagate immediately. Already-created
        // drafts (and their links) persist under the mandate — rollback
        // is not attempted; a curator reconciles by hand if needed.
        const writ = await clerk.post({
          type: 'mandate',
          title: observation.title,
          body: observation.body,
          codex: plan.codex,
          parentId: planId,
          draft: true,
        });
        writIds.push(writ.id);

        // Install the precedence-dependency edge back to the
        // originating mandate so the Spider's `trySpawn` gate holds the
        // lifted writ until the mandate reaches a terminal state. The
        // newly posted draft is the precedence-successor (source); the
        // originating mandate is the blocker (target). A failure here
        // is surfaced loudly — the gate is the whole point of the lift.
        await clerk.link(writ.id, planId, 'depends on', 'spider.follows');
      }

      return {
        status: 'completed',
        yields: { writIds },
      };
    },
  };
}
