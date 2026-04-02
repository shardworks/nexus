import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-complete',
  description: 'Complete a writ, transitioning it from active to completed',
  instructions:
    'Marks the writ as successfully completed. ' +
    'Only writs in active status can be completed. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.complete(params.id);
  },
});
