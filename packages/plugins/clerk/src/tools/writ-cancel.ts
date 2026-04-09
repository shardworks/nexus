import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-cancel',
  description: 'Cancel a writ, transitioning it from new, ready, active, or waiting to cancelled',
  instructions:
    'Cancels the writ. Writs in new (draft), ready, active, or waiting status can all be cancelled. ' +
    'Optionally record a resolution explaining why. ' +
    'If the writ has non-terminal children, they will be automatically cancelled. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    resolution: z.string().optional().describe('Optional summary of why the writ was cancelled'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.transition(
      params.id,
      'cancelled',
      params.resolution !== undefined ? { resolution: params.resolution } : undefined,
    );
  },
});
