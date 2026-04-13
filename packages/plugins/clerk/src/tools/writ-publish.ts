import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-publish',
  description: 'Publish a draft writ, transitioning it from new to open',
  instructions:
    'Moves a writ from new (draft) status to open, placing it in the execution queue. ' +
    'Once published, the Spider will pick up the writ on its next crawl tick. ' +
    'Only writs in new status can be published. Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.transition(params.id, 'open');
  },
});
