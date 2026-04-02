import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-accept',
  description: 'Accept a writ, transitioning it from ready to active',
  instructions:
    'Accepts the writ, signalling that work has begun. ' +
    'Only writs in ready status can be accepted. ' +
    'Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.accept(params.id);
  },
});
