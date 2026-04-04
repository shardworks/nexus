import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-unlink',
  description: 'Remove a link between two writs',
  instructions:
    'Removes the directional link of the given type from source to target. ' +
    'Idempotent — no error if the link does not exist.',
  params: {
    sourceId: z.string().describe('The writ that is the origin of the relationship'),
    targetId: z.string().describe('The writ that is the target of the relationship'),
    type: z.string().describe('Relationship type to remove'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    await clerk.unlink(params.sourceId, params.targetId, params.type);
    return { ok: true };
  },
});
