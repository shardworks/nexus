import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-fail',
  description: 'Fail a writ, transitioning it from open or stuck to failed',
  instructions:
    'Marks the writ as failed. Record a resolution explaining why it failed. ' +
    'Writs in open or stuck status can be failed. ' +
    'If the writ has non-terminal children, they will be automatically cancelled. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    resolution: z.string().describe('Summary of why the writ failed'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return clerk.transition(resolvedId, 'failed', { resolution: params.resolution });
  },
});
