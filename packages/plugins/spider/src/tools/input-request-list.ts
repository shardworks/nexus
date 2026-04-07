/**
 * input-request-list tool — list input requests.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc, InputRequestStatus } from '../types.ts';

export default tool({
  name: 'input-request-list',
  description: 'List input requests',
  instructions:
    'Returns input requests ordered by createdAt descending (newest first). ' +
    'Defaults to filtering by status "pending". ' +
    'Use --status to see completed or rejected requests.',
  params: {
    status: z
      .enum(['pending', 'completed', 'rejected'])
      .optional()
      .default('pending')
      .describe('Filter by request status (default: pending).'),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('Maximum number of results (default: 20).'),
    offset: z
      .number()
      .optional()
      .describe('Number of results to skip.'),
  },
  permission: 'read',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.readBook<InputRequestDoc>('spider', 'input-requests');
    const status: InputRequestStatus = (params.status ?? 'pending') as InputRequestStatus;
    const limit: number = params.limit ?? 20;
    return book.find({
      where: [['status', '=', status]],
      orderBy: ['createdAt', 'desc'],
      limit,
      ...(params.offset ? { offset: params.offset } : {}),
    });
  },
});
