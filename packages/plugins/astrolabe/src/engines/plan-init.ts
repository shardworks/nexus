/**
 * plan-init clockwork engine.
 *
 * Creates a PlanDoc keyed by the brief writ ID. Validates that the writ
 * has a codex and that no plan already exists for this writ.
 */

import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { PlanDoc } from '../types.ts';

export function createPlanInitEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.plan-init',

    async run(
      givens: Record<string, unknown>,
      _context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const writ = givens.writ as WritDoc;
      const book = getPlansBook();

      // Validate codex
      if (!writ.codex || typeof writ.codex !== 'string' || writ.codex.trim() === '') {
        throw new Error(`Writ "${writ.id}" has no codex — cannot create a plan.`);
      }

      // Check for duplicate
      const existing = await book.get(writ.id);
      if (existing !== null) {
        throw new Error(`Plan "${writ.id}" already exists.`);
      }

      // Create plan
      const now = new Date().toISOString();
      const plan: PlanDoc = {
        id: writ.id,
        codex: writ.codex,
        status: 'reading',
        createdAt: now,
        updatedAt: now,
      };

      await book.put(plan);

      return {
        status: 'completed',
        yields: { planId: writ.id },
      };
    },
  };
}
