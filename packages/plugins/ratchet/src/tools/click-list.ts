import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-list',
  description: 'List clicks with optional filters',
  instructions:
    'Returns clicks ordered by createdAt descending (newest first). ' +
    'Filter by status or parentId to narrow results.',
  params: {
    status: z
      .union([
        z.enum(['live', 'parked', 'concluded', 'dropped']),
        z.array(z.enum(['live', 'parked', 'concluded', 'dropped'])).min(1),
      ])
      .optional()
      .describe('Filter by click status (repeatable — pass multiple to match any)'),
    parentId: z.string().optional().describe('Filter to children of this parent click'),
    limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
    offset: z.number().optional().describe('Number of results to skip'),
  },
  permission: 'read',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    return ratchet.list({
      status: params.status,
      parentId: params.parentId,
      limit: params.limit,
      offset: params.offset,
    });
  },
});
