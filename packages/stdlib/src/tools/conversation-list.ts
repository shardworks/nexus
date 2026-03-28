import { tool, listConversations } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'conversation-list',
  description: 'List conversations (multi-turn interactions with animas)',
  instructions: 'Returns conversation summaries including participants, turn count, and cost. Use for reviewing active or past consultations and convene sessions.',
  params: {
    status: z.enum(['active', 'concluded', 'abandoned']).optional().describe('Filter by status'),
    kind: z.enum(['consult', 'convene']).optional().describe('Filter by kind'),
    limit: z.number().optional().default(20).describe('Maximum results'),
  },
  handler: (params, { home }) => {
    return listConversations(home, {
      status: params.status,
      kind: params.kind,
      limit: params.limit,
    });
  },
});
