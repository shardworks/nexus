/**
 * surveyor-create-pieces — batch piece creation tool for surveyor rigs.
 *
 * All pieces in one batch share a common parentId. Each item may carry
 * independent hints and supersedes links. The entire batch executes inside
 * one outer `stacks.transaction`.
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

const pieceItemSchema = z.object({
  title:      z.string().describe('Short title for this piece'),
  body:       z.string().describe('Detail text stored on the writ body'),
  codex:      z.string().optional().describe("Target codex (defaults to parent's codex)"),
  hints:      hintsSchema.describe('Optional priority hints'),
  supersedes: z.string().optional().describe('Optional id of an existing piece this one supersedes'),
});

export default tool({
  name: 'surveyor-create-pieces',
  description: 'Batch-create pieces under a charge or piece (surveyor rig tool)',
  instructions:
    'Creates multiple pieces under a single parent in one atomic transaction. ' +
    'All items share the same parentId. Returns an array of created PieceDoc objects.',
  params: {
    parentId: z.string().describe('Parent charge or piece id all pieces belong to'),
    pieces:   z.array(pieceItemSchema).min(1).describe('Array of piece definitions to create'),
  },
  permission: 'create-piece',
  callableBy: ['anima'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk      = guild().apparatus<ClerkApi>('clerk');
    const stacks     = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const results = [];
      for (const item of params.pieces) {
        const piece = await cartograph.createPiece({
          parentId: params.parentId,
          title:    item.title,
          body:     item.body,
          ...(item.codex !== undefined ? { codex: item.codex } : {}),
        });

        if (item.hints !== undefined) {
          const hints: SurveyorExt = item.hints;
          await clerk.setWritExt(piece.id, SURVEYOR_PLUGIN_ID, hints);
        }

        if (item.supersedes !== undefined) {
          await clerk.link(piece.id, item.supersedes, 'supersedes', 'surveyor.supersedes');
        }

        results.push(piece);
      }
      return results;
    });
  },
});
