import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Create a charge under a vision. The typed API rejects when the parent
 * is not a vision; the tool resolves a short-prefix `--parent-id` via
 * `clerk.resolveId` (D21) before calling the API. Lands the writ at
 * `phase: new` and stamps `ext['cartograph'] = { stage: 'draft' }`
 * (D14 — no auto-transition).
 */
export default tool({
  name: 'charge-create',
  description: 'Create a new charge under a vision',
  instructions:
    'Creates a charge under an existing vision. The parent must be a vision in a ' +
    "non-terminal state. The writ lands in `phase: new` with " +
    "`ext['cartograph'] = { stage: 'draft' }`. Use `charge-transition` to advance the " +
    'lifecycle. Title and body live on the writ row; edit them via `nsg writ edit`.',
  params: {
    parentId: z.string().describe('Parent vision id (or short prefix)'),
    title: z.string().describe('Short human-readable title describing the charge'),
    body: z.string().describe('Detail text, stored on the writ body'),
    codex: z.string().optional().describe('Optional target codex (defaults to parent vision codex)'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedParentId = await clerk.resolveId(params.parentId);
    return cartograph.createCharge({
      parentId: resolvedParentId,
      title: params.title,
      body: params.body,
      ...(params.codex !== undefined ? { codex: params.codex } : {}),
    });
  },
});
