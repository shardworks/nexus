/**
 * conversation-list tool — list conversations with optional filters.
 *
 * Queries The Parlour's conversations via the ParlourApi.
 * Returns conversation summaries ordered by createdAt descending (newest first).
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ParlourApi } from '../types.ts';

export default tool({
  name: 'conversation-list',
  description: 'List conversations with optional filters',
  instructions:
    'Returns conversation summaries ordered by creation time (newest first). ' +
    'Use for reviewing conversation history, checking active conversations, ' +
    'or monitoring costs.',
  params: {
    status: z.enum(['active', 'concluded', 'abandoned']).optional()
      .describe('Filter by conversation status'),
    kind: z.enum(['consult', 'convene']).optional()
      .describe('Filter by conversation kind'),
    limit: z.number().optional().default(20)
      .describe('Maximum results (default: 20)'),
  },
  permission: 'read',
  handler: async (params) => {
    const parlour = guild().apparatus<ParlourApi>('parlour');
    return parlour.list({
      status: params.status,
      kind: params.kind,
      limit: params.limit,
    });
  },
});
