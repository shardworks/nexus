import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-complete',
  description: 'Complete a writ, transitioning it from ready or active to completed',
  instructions:
    'Marks the writ as successfully completed. ' +
    'Writs in ready or active status can be completed. ' +
    'Undispatched writ types (e.g. quest) typically transition ready → completed directly; ' +
    'dispatch-bound writs (e.g. mandate) usually flow ready → active → completed. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    resolution: z.string().describe('Summary of how the writ was completed'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.transition(params.id, 'completed', { resolution: params.resolution });
  },
});
