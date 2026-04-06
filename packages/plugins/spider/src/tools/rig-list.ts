/**
 * rig-list tool — list rigs with optional filters.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, RigStatus } from '../types.ts';

export default tool({
  name: 'rig-list',
  description: 'List rigs with optional filters',
  instructions:
    'Returns rigs ordered by createdAt descending (newest first). ' +
    'Optionally filter by status and control pagination with limit and offset.',
  params: {
    status: z
      .enum(['running', 'completed', 'failed', 'blocked'])
      .optional()
      .describe('Filter by rig status.'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of results (default: 20).'),
    offset: z
      .number()
      .optional()
      .describe('Number of results to skip.'),
  },
  permission: 'read',
  handler: async (params) => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.list({
      status: params.status as RigStatus | undefined,
      limit: params.limit,
      offset: params.offset,
    });
  },
});
