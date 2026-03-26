import { tool, checkCommissionCompletion } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'commission-check',
  description: 'Check work completion status for a commission',
  instructions: 'Returns a completion summary: total works, how many are done/pending/failed, and whether the commission is ready to complete. Read-only — does not change any status.',
  params: {
    id: z.string().describe('Commission ID'),
  },
  handler: (params, { home }) => {
    return checkCommissionCompletion(home, params.id);
  },
});
