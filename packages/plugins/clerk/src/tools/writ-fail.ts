import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-fail',
  description: 'Fail a writ, transitioning it from active to failed',
  instructions:
    'Marks the writ as failed. Record a resolution explaining why it failed. ' +
    'Only writs in active status can be failed. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    resolution: z.string().describe('Summary of why the writ failed'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.transition(params.id, 'failed', { resolution: params.resolution });
  },
});
