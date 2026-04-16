import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi, LinkType } from '../types.ts';

export default tool({
  name: 'click-link',
  description: 'Create a typed link between two clicks or cross-substrate entities',
  instructions:
    'Creates a directional link from source to target with the given type. ' +
    'Same-substrate links (both c- prefixed) validate both exist. ' +
    'Cross-substrate targets are stored without validation. Idempotent.',
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
    return ratchet.link({
      sourceId,
      targetId,
      linkType: params.linkType as LinkType,
    });
  },
});
