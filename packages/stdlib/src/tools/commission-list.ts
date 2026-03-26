import { tool, listCommissions } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'commission-list',
  description: 'List commissions, optionally filtered by status or workshop',
  instructions: 'Returns commissions from the Ledger. Use --status to filter by lifecycle status, --workshop to filter by target workshop.',
  params: {
    status: z.string().optional().describe('Filter by status (posted, assigned, in_progress, completed, failed)'),
    workshop: z.string().optional().describe('Filter by workshop name'),
  },
  handler: (params, { home }) => listCommissions(home, params),
});
