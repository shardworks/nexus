/**
 * session-show tool — show full detail for a single session by id.
 *
 * Reads the complete session record from The Animator's `sessions` book
 * in The Stacks, including tokenUsage, metadata, and all indexed fields.
 *
 * Why this tool stays standalone (post-reducer audit): `session-show`
 * is a pure read — it never writes a SessionDoc, never triggers a
 * lifecycle transition, and never touches `lastActivityAt` or the
 * `cancelHandle`. The `reduceSessionTransition` reducer encodes write
 * invariants (preserve startedAt/provider, refresh lastActivityAt only
 * from per-variant payload, no-op on terminal regression); none of
 * those apply to a read-by-id surface. Folding this tool through the
 * reducer would mean inventing a no-op variant whose only behaviour is
 * `return existing`, which is what the underlying `book.get(id)` call
 * already does. The tool's only responsibility above `book.get` is
 * translating "row not found" into a thrown Error so the tool runtime
 * surfaces a 404-shaped failure to the caller.
 *
 * See: docs/specification.md (animator § session-show tool)
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
