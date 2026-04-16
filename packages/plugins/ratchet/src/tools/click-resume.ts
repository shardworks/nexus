import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-resume',
  description: 'Resume a parked click, returning it to live status',
  instructions:
    'Transitions a click from parked to live status. ' +
    'Only parked clicks can be resumed.',
  params: {
    id: z.string().describe('Click ID or prefix'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.resume(resolvedId);
  },
});
