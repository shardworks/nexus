/**
 * session-list tool — list recent sessions with optional filters.
 *
 * Queries The Animator's `sessions` book in The Stacks.
 * Returns session summaries ordered by startedAt descending (newest first).
 *
 * See: docs/specification.md (animator § session-list tool)
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { StacksApi, WhereCondition } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '../types.ts';

export default tool({
  name: 'session-list',
  description: 'List recent sessions with optional filters',
  instructions:
    'Returns session summaries ordered by start time (newest first). ' +
    'Use for investigating recent activity, debugging, or reporting. ' +
    'Filters by indexed fields only — use Stacks queries directly for metadata fields.',
  params: {
    status: z
      .enum(['running', 'completed', 'failed', 'timeout', 'cancelled', 'rate-limited'])
      .optional()
      .describe('Filter by session status'),
    provider: z.string().optional()
      .describe('Filter by provider name (e.g. "claude-code")'),
    conversationId: z.string().optional()
      .describe('Filter by conversation id'),
    limit: z.number().optional().default(20)
      .describe('Maximum results (default: 20)'),
  },
  permission: 'read',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const sessions = stacks.readBook<SessionDoc>('animator', 'sessions');

    const where: WhereCondition[] = [];
    if (params.status) where.push(['status', '=', params.status]);
    if (params.provider) where.push(['provider', '=', params.provider]);
    if (params.conversationId) where.push(['conversationId', '=', params.conversationId]);

    const results = await sessions.find({
      where: where.length > 0 ? where : undefined,
      orderBy: ['startedAt', 'desc'],
      limit: params.limit,
    });

    // Return summary projection
    return results.map((s) => ({
      id: s.id,
      status: s.status,
      provider: s.provider,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      exitCode: s.exitCode,
      costUsd: s.costUsd,
    }));
  },
});
