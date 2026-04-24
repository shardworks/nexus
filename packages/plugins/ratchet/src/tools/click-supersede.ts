import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-supersede',
  description: 'Atomically create a new click and a supersedes link from it to an existing click',
  instructions:
    'Creates a new click and a `supersedes` link from the new click to the target ' +
    'in a single transaction — if either write fails, neither is persisted. Use this ' +
    'as the canonical post-conclusion correction pattern: amend is refused on sealed ' +
    '(concluded / dropped) clicks, but supersede works regardless of target status. ' +
    'The new click is parent-less by default — pass --parent-id to nest it.',
  params: {
    targetId: z
      .string()
      .describe('Click ID (or prefix) being superseded by the new click'),
    goal: z.string().describe('Goal text for the new click (non-empty)'),
    parentId: z
      .string()
      .optional()
      .describe('Optional parent click ID for the new click. Omit for a root click.'),
    createdSessionId: z
      .string()
      .optional()
      .describe('Session ID recorded on the new click'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedTargetId = await ratchet.resolveId(params.targetId);
    let resolvedParentId: string | undefined;
    if (params.parentId) {
      resolvedParentId = await ratchet.resolveId(params.parentId);
    }
    return ratchet.supersede(resolvedTargetId, {
      goal: params.goal,
      parentId: resolvedParentId,
      createdSessionId: params.createdSessionId,
    });
  },
});
