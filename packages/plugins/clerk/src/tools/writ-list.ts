import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritStatus } from '../types.ts';

export default tool({
  name: 'writ-list',
  description: 'List writs with optional filters',
  instructions:
    'Returns writ summaries ordered by postedAt descending (newest first). ' +
    'Filter by status, type, or assignee to narrow results.',
  params: {
    status: z
      .enum(['ready', 'active', 'completed', 'failed', 'cancelled'])
      .optional()
      .describe('Filter by writ status'),
    type: z.string().optional().describe('Filter by writ type'),
    assignee: z.string().optional().describe('Filter by assignee'),
    limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
  },
  permission: 'clerk:read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.list({
      status: params.status as WritStatus | undefined,
      type: params.type,
      assignee: params.assignee,
      limit: params.limit,
    });
  },
});
