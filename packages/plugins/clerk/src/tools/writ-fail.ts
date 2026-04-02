import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-fail',
  description: 'Fail a writ, transitioning it from active to failed',
  instructions:
    'Marks the writ as failed. Optionally record a reason for the failure. ' +
    'Only writs in active status can be failed. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    reason: z.string().optional().describe('Optional reason for failure'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.fail(params.id, params.reason);
  },
});
