import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-complete',
  description: 'Complete a writ, transitioning it from open to completed',
  instructions:
    'Marks the writ as successfully completed. ' +
    'Writs in open phase can be completed. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    resolution: z.string().describe('Summary of how the writ was completed'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return clerk.transition(resolvedId, 'completed', { resolution: params.resolution });
  },
});
