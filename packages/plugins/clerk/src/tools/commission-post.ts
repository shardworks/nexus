import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'commission-post',
  description: 'Post a new commission, creating a writ in ready status',
  instructions:
    'Creates a new writ and places it in ready status awaiting acceptance. ' +
    'The writ type must be a type declared in the guild config, or a built-in type (mandate, summon). ' +
    'If type is omitted, the guild\'s configured default type is used (defaults to "mandate").',
  params: {
    title: z.string().describe('Short human-readable title describing the work'),
    body: z.string().optional().describe('Optional detail text or description'),
    type: z.string().optional().describe('Writ type (default: guild defaultType or "mandate")'),
    assignee: z.string().optional().describe('Assignee name or id'),
  },
  permission: 'clerk:write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.postCommission({
      title: params.title,
      body: params.body,
      type: params.type,
      assignee: params.assignee,
    });
  },
});
