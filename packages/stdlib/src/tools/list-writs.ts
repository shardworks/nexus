import { tool } from '@shardworks/nexus-core';
import { listWrits } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'list-writs',
  description: 'List writs with optional filters',
  instructions: 'Query writs by parent, type, or status. Returns newest first.',
  params: {
    parentId: z.string().optional().describe('Filter by parent writ ID'),
    type: z.string().optional().describe('Filter by writ type'),
    status: z.enum(['ready', 'active', 'pending', 'completed', 'failed', 'cancelled']).optional()
      .describe('Filter by status'),
  },
  handler: (params, { home }) => listWrits(home, params),
});
