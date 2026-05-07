/**
 * surveyor-create-charge — single-charge creation tool for surveyor rigs.
 *
 * Wraps `cartograph.createCharge` + optional `clerk.setWritExt('surveyor', hints)`
 * + optional `clerk.link(newId, supersedes, 'supersedes', 'surveyor.supersedes')`
 * inside one outer `stacks.transaction`.
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

export default tool({
  name: 'surveyor-create-charge',
  description: 'Create a single charge under a vision (surveyor rig tool)',
  instructions:
    'Creates a charge under a vision inside one atomic transaction, optionally stamping ' +
    "`ext['surveyor']` priority hints and recording a supersedes link. " +
    'Use surveyor-create-charges for batch creation.',
  params: {
    parentId:   z.string().describe('Vision id this charge belongs to'),
    title:      z.string().describe('Short human-readable title for the charge'),
    body:       z.string().describe('Detail text stored on the writ body'),
    codex:      z.string().optional().describe('Target codex (defaults to parent vision codex)'),
    hints:      hintsSchema.describe('Optional priority hints stamped onto ext["surveyor"]'),
    supersedes: z.string().optional().describe('Optional id of an existing charge this one supersedes'),
  },
  permission: 'create-charge',
  callableBy: ['anima'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk      = guild().apparatus<ClerkApi>('clerk');
    const stacks     = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const charge = await cartograph.createCharge({
        parentId: params.parentId,
        title:    params.title,
        body:     params.body,
        ...(params.codex !== undefined ? { codex: params.codex } : {}),
      });

      if (params.hints !== undefined) {
        const hints: SurveyorExt = params.hints;
        await clerk.setWritExt(charge.id, SURVEYOR_PLUGIN_ID, hints);
      }

      if (params.supersedes !== undefined) {
        await clerk.link(charge.id, params.supersedes, 'supersedes', 'surveyor.supersedes');
      }

      return charge;
    });
  },
});
