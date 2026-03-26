import { tool, updateCommissionStatus } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'commission-update',
  description: 'Update a commission status',
  instructions: 'Transitions a commission to a new status. Every status change must include a reason.',
  params: {
    id: z.string().describe('Commission ID'),
    status: z.string().describe('New status (posted, assigned, in_progress, completed, failed)'),
    reason: z.string().describe('Reason for the status change'),
  },
  handler: (params, { home }) => {
    updateCommissionStatus(home, params.id, params.status, params.reason);
    return { id: params.id, status: params.status };
  },
});
