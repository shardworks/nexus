import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-cancel',
  description: 'Cancel a writ, transitioning it from ready or active to cancelled',
  instructions:
    'Cancels the writ. Both ready and active writs can be cancelled. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.cancel(params.id);
  },
});
