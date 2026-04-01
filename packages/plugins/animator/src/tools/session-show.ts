/**
 * session-show tool — show full detail for a single session by id.
 *
 * Reads the complete session record from The Animator's `sessions` book
 * in The Stacks, including tokenUsage, metadata, and all indexed fields.
 *
 * See: docs/architecture/apparatus/animator.md § session-show tool
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '../types.ts';

export default tool({
  name: 'session-show',
  description: 'Show full detail for a single session by id',
  instructions:
    'Returns the complete session record from The Stacks, including ' +
    'tokenUsage, metadata, and all indexed fields.',
  params: {
    id: z.string().describe('Session id'),
  },
  permission: 'read',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');

    const session = await sessions.get(params.id);
    if (!session) {
      throw new Error(`Session "${params.id}" not found.`);
    }
    return session;
  },
});
