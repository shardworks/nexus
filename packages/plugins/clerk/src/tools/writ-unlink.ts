import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-unlink',
  description: 'Remove a link between two writs',
  instructions:
    'Removes the directional link of the given label from source to target. ' +
    'Idempotent — no error if the link does not exist.',
  params: {
    sourceId: z.string().describe('The writ that is the origin of the relationship'),
    targetId: z.string().describe('The writ that is the target of the relationship'),
    label: z.string().describe('Relationship label to remove'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const [resolvedSource, resolvedTarget] = await Promise.all([
      clerk.resolveId(params.sourceId),
      clerk.resolveId(params.targetId),
    ]);
    await clerk.unlink(resolvedSource, resolvedTarget, params.label);
    return { ok: true };
  },
});
