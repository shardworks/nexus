/**
 * plan-finalize clockwork engine.
 *
 * Planning-phase terminator for the combined plan-and-ship rig. Does NOT
 * post a mandate writ and does NOT create any clerk links. It merely
 * validates that the spec-writer stage produced a spec, yields the spec
 * verbatim for downstream engines (specifically the `implement` engine,
 * whose `prompt` given is wired to `${yields.plan-finalize.spec}`), and
 * transitions the plan's status from `writing` to `completed`.
 *
 * Preconditions:
 *   - plan.status must be 'writing'
 *   - plan.spec must be a non-empty string
 */

import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { PlanDoc } from '../types.ts';

export function createPlanFinalizeEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.plan-finalize',

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

      // Validate status
      if (plan.status !== 'writing') {
        throw new Error(
          `plan-finalize: expected plan status "writing" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      // Validate spec exists
      if (typeof plan.spec !== 'string' || plan.spec.length === 0) {
        throw new Error(
          `Plan "${planId}" has no spec — spec-writer stage did not produce output.`,
        );
      }

      const spec = plan.spec;

      // Mark the plan completed. The combined rig still has implementation
      // work to do downstream of this engine, but from Astrolabe's POV the
      // planning phase is done the moment the spec is ready for handoff.
      const now = new Date().toISOString();
      await book.patch(planId, {
        status: 'completed',
        updatedAt: now,
      });

      return {
        status: 'completed',
        yields: { spec },
      };
    },
  };
}
