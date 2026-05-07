/**
 * surveyor-create-piece — single-piece creation tool for surveyor rigs.
 *
 * Wraps `cartograph.createPiece` + optional `clerk.setWritExt('surveyor', hints)`
 * + optional `clerk.link(newId, supersedes, 'supersedes', 'surveyor.supersedes')`
 * inside one outer `stacks.transaction`.
 *
 * Permission: `'create-piece'` (D9).
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
  name: 'surveyor-create-piece',
  description: 'Create a single piece under a charge or piece (surveyor rig tool)',
  instructions:
    'Creates a piece under an existing charge or piece inside one atomic transaction, ' +
    "optionally stamping `ext['surveyor']` priority hints and recording a supersedes link. " +
    'Use surveyor-create-pieces for batch creation.',
  params: {
    parentId:   z.string().describe('Parent charge or piece id'),
    title:      z.string().describe('Short human-readable title for the piece'),
    body:       z.string().describe('Detail text stored on the writ body'),
    codex:      z.string().optional().describe("Target codex (defaults to parent's codex)"),
    hints:      hintsSchema.describe('Optional priority hints stamped onto ext["surveyor"]'),
    supersedes: z.string().optional().describe('Optional id of an existing piece this one supersedes'),
  },
  permission: 'create-piece',
  callableBy: ['anima'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk      = guild().apparatus<ClerkApi>('clerk');
    const stacks     = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const piece = await cartograph.createPiece({
        parentId: params.parentId,
        title:    params.title,
        body:     params.body,
        ...(params.codex !== undefined ? { codex: params.codex } : {}),
      });

      if (params.hints !== undefined) {
        const hints: SurveyorExt = params.hints;
        await clerk.setWritExt(piece.id, SURVEYOR_PLUGIN_ID, hints);
      }

      if (params.supersedes !== undefined) {
        await clerk.link(piece.id, params.supersedes, 'supersedes', 'surveyor.supersedes');
      }

      return piece;
    });
  },
});
