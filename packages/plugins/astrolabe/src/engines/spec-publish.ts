/**
 * spec-publish clockwork engine.
 *
 * Posts the generated specification as a mandate writ, links it back to
 * the originating brief via a 'refines' link, records generatedWritId on
 * the PlanDoc, and transitions the plan to 'completed'.
 *
 * The engine always posts the full spec verbatim — including any
 * `<task-manifest>` block the spec-writer produced. The planning pipeline
 * does not fan the manifest out into child `piece` writs; the implementing
 * artificer (or a downstream tool) is responsible for acting on the
 * manifest if it chooses to. This keeps spec-publish a pure "publish what
 * was written" step with no hidden surgery on the mandate body.
 *
 * Preconditions:
 *   - plan.status must be 'writing'
 *   - plan.spec must be a non-empty string
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { PlanDoc } from '../types.ts';

export function createSpecPublishEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.spec-publish',

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
          `spec-publish: expected plan status "writing" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      // Validate spec exists
      if (typeof plan.spec !== 'string' || plan.spec.length === 0) {
        throw new Error(
          `Plan "${planId}" has no spec — spec-writer stage did not produce output.`,
        );
      }

      const clerk = guild().apparatus<ClerkApi>('clerk');

      // Read the brief writ for its title
      const briefWrit = await clerk.show(planId);

      // Post the mandate with the full spec verbatim (task-manifest included if present).
      const generatedWrit = await clerk.post({
        type: 'mandate',
        title: briefWrit.title,
        body: plan.spec,
        codex: plan.codex,
      });

      // Link: mandate (source) → brief (target), type 'refines'
      await clerk.link(generatedWrit.id, planId, 'refines');

      // Update PlanDoc
      const now = new Date().toISOString();
      await book.patch(planId, {
        generatedWritId: generatedWrit.id,
        status: 'completed',
        updatedAt: now,
      });

      return {
        status: 'completed',
        yields: { generatedWritId: generatedWrit.id },
      };
    },
  };
}
