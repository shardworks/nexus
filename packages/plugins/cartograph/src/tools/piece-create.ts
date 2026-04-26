import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Create a piece under a charge or another piece. The typed API rejects
 * any other parent type. Resolves a short-prefix `--parent-id` via
 * `clerk.resolveId` (D21) before calling the API. Lands the writ at
 * `phase: new` and the companion doc at `stage: draft` (D14 — no
 * auto-transition).
 */
export default tool({
  name: 'piece-create',
  description: 'Create a new piece under a charge or piece',
  instructions:
    'Creates a piece under an existing charge or piece. The parent must be a charge ' +
    'or piece in a non-terminal state. The writ lands in `phase: new` and the companion ' +
    'doc in `stage: draft`. Use `piece-transition` to advance the lifecycle. Title and ' +
    'body live on the writ row; edit them via `nsg writ edit`.',
  params: {
    parentId: z.string().describe('Parent charge or piece id (or short prefix)'),
    title: z.string().describe('Short human-readable title describing the piece'),
    body: z.string().describe('Detail text, stored on the writ body'),
    codex: z.string().optional().describe("Optional target codex (defaults to parent's codex)"),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedParentId = await clerk.resolveId(params.parentId);
    return cartograph.createPiece({
      parentId: resolvedParentId,
      title: params.title,
      body: params.body,
      ...(params.codex !== undefined ? { codex: params.codex } : {}),
    });
  },
});
