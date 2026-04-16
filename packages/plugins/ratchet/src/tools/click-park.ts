import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-park',
  description: 'Park a live click, pausing work on it',
  instructions:
    'Transitions a click from live to parked status. ' +
    'Only live clicks can be parked.',
  params: {
    id: z.string().describe('Click ID or prefix'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.park(resolvedId);
  },
});
