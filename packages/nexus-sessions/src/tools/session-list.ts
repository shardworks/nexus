/**
 * session-list tool — list recent sessions with optional filters.
 *
 * Replaces the stdlib session-list tool that called listSessions() from
 * @shardworks/nexus-core. The plugin now owns this operation.
 *
 * Note: the `anima` filter matches by animaId only. Name-based lookup
 * requires nexus-roster (not yet a plugin). Pass an animaId, not a name.
 */

import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { listSessions } from '../lib/session-api.js';

export default tool({
  name: 'session-list',
  description: 'List recent sessions with optional filters',
  instructions:
    'Returns session summaries ordered by start time (newest first). ' +
    'Use for investigating recent activity, debugging, or reporting. ' +
    'The `anima` filter matches by anima ID.',
  params: {
    anima: z.string().optional().describe('Filter by anima ID'),
    workshop: z.string().optional().describe('Filter by workshop name'),
    trigger: z.string().optional().describe('Filter by trigger type (consult, summon, brief, convene)'),
    status: z.enum(['active', 'completed']).optional().describe('Filter by active or completed'),
    writId: z.string().optional().describe('Filter by bound writ ID'),
    limit: z.number().optional().default(20).describe('Maximum results'),
  },
  handler: (params) => {
    const { home } = guild();
    return listSessions(home, {
      anima: params.anima,
      workshop: params.workshop,
      trigger: params.trigger,
      status: params.status,
      writId: params.writId,
      limit: params.limit,
    });
  },
});
