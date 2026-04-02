import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-show',
  description: 'Show full detail for a writ',
  instructions: 'Returns the complete writ record including its current status, assignee, timestamps, and body text.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'clerk:read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const writ = await clerk.show(params.id);
    if (!writ) {
      throw new Error(`Writ "${params.id}" not found.`);
    }
    return writ;
  },
});
