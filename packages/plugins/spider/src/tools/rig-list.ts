/**
 * rig-list tool — list rigs with optional filters.
 *
 * The returned shape is `RigView[]` — the persisted RigDoc plus a
 * derived `costSummary` and per-engine `engineCosts` map (see ../rig-view.ts).
 * Callers that only need the persisted RigDoc fields can ignore the extras.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, RigStatus, RigView } from '../types.ts';
import { enrichRigViews } from '../rig-view.ts';

export default tool({
  name: 'rig-list',
  description: 'List rigs with optional filters',
  instructions:
    'Returns rigs ordered by createdAt descending (newest first). ' +
    'Optionally filter by status and control pagination with limit and offset. ' +
    'Each entry includes an aggregated costSummary and engineCosts map derived ' +
    'from the animator sessions book — useful for dashboards; safe to ignore.',
  params: {
    status: z
      .enum(['running', 'stuck', 'completed', 'failed', 'blocked'])
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
  handler: async (params): Promise<RigView[]> => {
    const g = guild();
    const spider = g.apparatus<SpiderApi>('spider');
    const rigs = await spider.list({
      status: params.status as RigStatus | undefined,
      limit: params.limit,
      offset: params.offset,
    });
    return enrichRigViews(rigs);
  },
});
