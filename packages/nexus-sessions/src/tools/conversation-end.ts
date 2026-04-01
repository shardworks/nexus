/**
 * conversation-end tool — end an active conversation.
 *
 * Replaces the stdlib conversation-end tool that called endConversation()
 * from @shardworks/nexus-core. The rig now owns this operation.
 */

import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { endConversation } from '../lib/conversation-api.js';

export default tool({
  name: 'conversation-end',
  description: 'End an active conversation',
  instructions:
    'Ends a conversation by setting its status to concluded or abandoned. ' +
    'Idempotent — no error if already ended.',
  params: {
    id: z.string().describe('Conversation ID (conv-xxxx)'),
    reason: z.enum(['concluded', 'abandoned']).optional().default('concluded')
      .describe('Why the conversation ended'),
  },
  handler: (params) => {
    const { home } = guild();
    endConversation(home, params.id, params.reason);
    return { id: params.id, status: params.reason };
  },
});
