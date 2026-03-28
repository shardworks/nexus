import { tool, showConversation } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'conversation-show',
  description: 'Show full detail for a conversation including all turns',
  instructions: 'Returns conversation detail with participants, metrics, and full turn history. Each turn includes the prompt (human message in a consult) and session reference for the anima response.',
  params: {
    id: z.string().describe('Conversation ID (conv_xxxx)'),
  },
  handler: (params, { home }) => {
    const detail = showConversation(home, params.id);
    if (!detail) {
      throw new Error(`Conversation "${params.id}" not found.`);
    }
    return detail;
  },
});
