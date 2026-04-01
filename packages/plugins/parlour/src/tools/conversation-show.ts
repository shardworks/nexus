/**
 * conversation-show tool — show full detail for a conversation.
 *
 * Returns the complete conversation record including all turns,
 * participant list, and aggregate cost.
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ParlourApi } from '../types.ts';

export default tool({
  name: 'conversation-show',
  description: 'Show full detail for a conversation including all turns',
  instructions:
    'Returns the complete conversation record from The Parlour, including ' +
    'participant list, per-turn summaries, and aggregate cost.',
  params: {
    id: z.string().describe('Conversation id'),
  },
  permission: 'read',
  handler: async (params) => {
    const parlour = guild().apparatus<ParlourApi>('parlour');
    const detail = await parlour.show(params.id);
    if (!detail) {
      throw new Error(`Conversation "${params.id}" not found.`);
    }
    return detail;
  },
});
