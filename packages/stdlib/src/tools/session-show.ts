import { tool, showSession } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'session-show',
  description: 'Show full details of a specific session',
  instructions: 'Returns the complete session record including token usage, cost, and duration.',
  params: {
    id: z.string().describe('Session ID'),
  },
  handler: (params, { home }) => {
    const result = showSession(home, params.id);
    if (!result) throw new Error(`Session "${params.id}" not found.`);
    return result;
  },
});
