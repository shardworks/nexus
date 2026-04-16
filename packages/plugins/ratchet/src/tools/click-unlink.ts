import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi, LinkType } from '../types.ts';

export default tool({
  name: 'click-unlink',
  description: 'Remove a typed link between two entities',
  instructions:
    'Removes the directional link of the given type from source to target. ' +
    'Throws if the link does not exist.',
  params: {
    sourceId: z.string().describe('Source click ID or prefix (resolved if c- prefixed)'),
    targetId: z.string().describe('Target ID or prefix (resolved if c- prefixed)'),
    linkType: z.enum(['related', 'commissioned', 'supersedes', 'depends-on']).describe('Relationship type'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    let sourceId = params.sourceId;
    let targetId = params.targetId;
    if (sourceId.startsWith('c-')) {
      sourceId = await ratchet.resolveId(sourceId);
    }
    if (targetId.startsWith('c-')) {
      targetId = await ratchet.resolveId(targetId);
    }
    await ratchet.unlink({
      sourceId,
      targetId,
      linkType: params.linkType as LinkType,
    });
    return { ok: true };
  },
});
