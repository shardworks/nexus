import { tool, readCommission } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'commission-show',
  description: 'Show details of a specific commission',
  instructions: 'Returns the full commission record including content, status, workshop, and status reason.',
  params: {
    id: z.string().describe('Commission ID'),
  },
  handler: (params, { home }) => {
    const result = readCommission(home, params.id);
    if (!result) throw new Error(`Commission "${params.id}" not found.`);
    return result;
  },
});
