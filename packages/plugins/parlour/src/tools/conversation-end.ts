/**
 * conversation-end tool — end an active conversation.
 *
 * Sets conversation status to 'concluded' or 'abandoned'.
 * Idempotent — no error if the conversation is already ended.
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ParlourApi } from '../types.ts';

export default tool({
  name: 'conversation-end',
  description: 'End an active conversation',
  instructions:
    'Ends the conversation with the given reason. Use "concluded" for normal ' +
    'endings and "abandoned" for timeouts, disconnects, or explicit cancellation. ' +
    'Idempotent — safe to call on already-ended conversations.',
  params: {
    id: z.string().describe('Conversation id'),
    reason: z.enum(['concluded', 'abandoned']).optional().default('concluded')
      .describe('Why the conversation ended (default: "concluded")'),
  },
  permission: 'write',
  handler: async (params) => {
    const parlour = guild().apparatus<ParlourApi>('parlour');
    await parlour.end(params.id, params.reason);
    return { status: 'ok', conversationId: params.id, reason: params.reason };
  },
});
