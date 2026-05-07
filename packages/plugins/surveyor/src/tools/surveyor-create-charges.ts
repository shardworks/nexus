/**
 * surveyor-create-charges — batch charge creation tool for surveyor rigs.
 *
 * All charges in one batch share a common parentId. Each item may carry
 * independent hints and supersedes links. The entire batch executes inside
 * one outer `stacks.transaction`.
 *
 * Permission: `'create-charge'` (D9).
 * callableBy: `['anima']` (D21).
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { CartographApi } from '@shardworks/cartograph-apparatus';
import type { SurveyorExt } from '../types.ts';
import { SURVEYOR_PLUGIN_ID } from '../types.ts';

const hintsSchema = z.object({
  severity:   z.enum(['moderate', 'serious', 'critical']).optional(),
  deadline:   z.string().optional(),
  decay:      z.boolean().optional(),
  complexity: z.enum(['mechanical', 'bounded', 'exploratory', 'open-ended']).optional(),
}).optional();

const chargeItemSchema = z.object({
  title:      z.string().describe('Short title for this charge'),
  body:       z.string().describe('Detail text stored on the writ body'),
  codex:      z.string().optional().describe('Target codex (defaults to parent vision codex)'),
  hints:      hintsSchema.describe('Optional priority hints'),
  supersedes: z.string().optional().describe('Optional id of an existing charge this one supersedes'),
});

export default tool({
  name: 'surveyor-create-charges',
  description: 'Batch-create charges under a vision (surveyor rig tool)',
  instructions:
    'Creates multiple charges under a single vision in one atomic transaction. ' +
    'All items share the same parentId. Returns an array of created ChargeDoc objects.',
  params: {
    parentId: z.string().describe('Vision id all charges belong to'),
    charges:  z.array(chargeItemSchema).min(1).describe('Array of charge definitions to create'),
  },
  permission: 'create-charge',
  callableBy: ['anima'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk      = guild().apparatus<ClerkApi>('clerk');
    const stacks     = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const results = [];
      for (const item of params.charges) {
        const charge = await cartograph.createCharge({
          parentId: params.parentId,
          title:    item.title,
          body:     item.body,
          ...(item.codex !== undefined ? { codex: item.codex } : {}),
        });

        if (item.hints !== undefined) {
          const hints: SurveyorExt = item.hints;
          await clerk.setWritExt(charge.id, SURVEYOR_PLUGIN_ID, hints);
        }

        if (item.supersedes !== undefined) {
          await clerk.link(charge.id, item.supersedes, 'supersedes', 'surveyor.supersedes');
        }

        results.push(charge);
      }
      return results;
    });
  },
});
