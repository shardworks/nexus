/**
 * conversation-show tool — show full detail for a conversation.
 *
 * Replaces the stdlib conversation-show tool that called showConversation()
 * from @shardworks/nexus-core. The rig now owns this operation.
 */

import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { showConversation } from '../lib/conversation-api.js';

export default tool({
  name: 'conversation-show',
  description: 'Show full detail for a conversation including all turns',
  instructions:
    'Returns conversation detail with participants, metrics, and full turn history. ' +
    'Each turn includes the prompt (human message in a consult) and session reference ' +
    'for the anima response.',
  params: {
    id: z.string().describe('Conversation ID (conv-xxxx)'),
  },
  handler: (params) => {
    const { home } = guild();
    const detail = showConversation(home, params.id);
    if (!detail) {
      throw new Error(`Conversation "${params.id}" not found.`);
    }
    return detail;
  },
});
