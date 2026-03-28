import { tool, listSessions } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'session-list',
  description: 'List recent sessions with optional filters',
  instructions: 'Returns session summaries. Use for investigating recent activity, debugging, or reporting.',
  params: {
    anima: z.string().optional().describe('Filter by anima name or ID'),
    workshop: z.string().optional().describe('Filter by workshop name'),
    trigger: z.string().optional().describe('Filter by trigger type (consult, summon, brief, convene)'),
    status: z.enum(['active', 'completed']).optional().describe('Filter by active or completed'),
    limit: z.number().optional().default(20).describe('Maximum results'),
  },
  handler: (params, { home }) => {
    return listSessions(home, {
      anima: params.anima,
      workshop: params.workshop,
      trigger: params.trigger,
      status: params.status,
      limit: params.limit,
    });
  },
});
