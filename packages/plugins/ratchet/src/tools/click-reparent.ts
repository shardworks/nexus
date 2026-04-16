import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-reparent',
  description: 'Move a click to a new parent or to root level',
  instructions:
    'Moves a click under a new parent click, or to root level if no parentId is provided. ' +
    'Circular parentage is detected and rejected.',
  params: {
    id: z.string().describe('Click ID or prefix to reparent'),
    parentId: z.string().optional().describe('New parent click ID or prefix (omit to move to root)'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    let resolvedParentId: string | undefined;
    if (params.parentId) {
      resolvedParentId = await ratchet.resolveId(params.parentId);
    }
    return ratchet.reparent(resolvedId, { parentId: resolvedParentId });
  },
});
