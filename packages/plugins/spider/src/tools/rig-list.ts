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
import type { SpiderApi, RigView } from '../types.ts';
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
    // The four new-model statuses plus 'stuck' / 'blocked' as deprecated
    // legacy values. Legacy rigs persisted before this commission may
    // still carry those strings — operators need a way to inspect them
    // via the normal filter. New rigs never write either value.
    status: z
      .enum(['running', 'completed', 'failed', 'cancelled', 'stuck', 'blocked'])
      .optional()
      .describe(
        'Filter by rig status. Values: running | completed | failed | cancelled. ' +
          'The deprecated values "stuck" and "blocked" are also accepted to let ' +
          'operators inspect rigs that predate the engine-level retry reshape; ' +
          'new rigs never write those values.',
      ),
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
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });
    return enrichRigViews(rigs);
  },
});
