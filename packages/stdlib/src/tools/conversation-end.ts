import { tool, endConversation } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'conversation-end',
  description: 'End an active conversation',
  instructions: 'Ends a conversation by setting its status to concluded or abandoned. Idempotent — no error if already ended.',
  params: {
    id: z.string().describe('Conversation ID (conv_xxxx)'),
    reason: z.enum(['concluded', 'abandoned']).optional().default('concluded')
      .describe('Why the conversation ended'),
  },
  handler: (params, { home }) => {
    endConversation(home, params.id, params.reason);
    return { id: params.id, status: params.reason };
  },
});
