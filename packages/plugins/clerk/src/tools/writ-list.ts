import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-list',
  description: 'List writs with optional filters',
  instructions:
    'Returns writ summaries ordered by createdAt descending (newest first). ' +
    'Filter by status or type to narrow results.',
  params: {
    status: z
      .enum(['ready', 'active', 'completed', 'failed', 'cancelled'])
      .optional()
      .describe('Filter by writ status'),
    type: z.string().optional().describe('Filter by writ type'),
    limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
    offset: z.number().optional().describe('Number of results to skip'),
  },
  permission: 'clerk:read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.list({
      status: params.status,
      type: params.type,
      limit: params.limit,
      offset: params.offset,
    });
  },
});
