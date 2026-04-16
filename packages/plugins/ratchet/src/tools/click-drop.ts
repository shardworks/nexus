import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-drop',
  description: 'Drop a click, marking it as abandoned or no longer needed',
  instructions:
    'Transitions a click from live or parked to dropped status. ' +
    'A non-empty conclusion string is required.',
  params: {
    id: z.string().describe('Click ID or prefix'),
    conclusion: z.string().describe('Reason for dropping this click'),
    resolvedSessionId: z.string().optional().describe('Session ID that resolved this click'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.drop(resolvedId, {
      conclusion: params.conclusion,
      resolvedSessionId: params.resolvedSessionId,
    });
  },
});
