/**
 * inventory-check clockwork engine.
 *
 * Validates that the reader stage produced a non-empty inventory on the PlanDoc.
 * Throws if the plan is missing or has no inventory content.
 * On success, transitions the plan status from 'reading' to 'analyzing' so the
 * scoping-primer stage and subsequent decision-review engine can proceed.
 */

import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { PlanDoc } from '../types.ts';

export function createInventoryCheckEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.inventory-check',

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

      if (typeof plan.inventory !== 'string' || plan.inventory.length === 0) {
        throw new Error(
          `Plan "${planId}" has no inventory — reader stage did not produce output.`,
        );
      }

      await book.patch(planId, {
        status: 'analyzing',
        updatedAt: new Date().toISOString(),
      });

      return {
        status: 'completed',
        yields: {},
      };
    },
  };
}
