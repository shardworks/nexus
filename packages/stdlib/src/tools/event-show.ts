import { tool, guild } from '@shardworks/nexus-core';
import { readEvent } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'event-show',
  description: 'Show details of a specific event',
  instructions: 'Returns the full event record including payload.',
  params: {
    id: z.string().describe('Event ID'),
  },
  handler: (params) => {
    const { home } = guild();
    const result = readEvent(home, params.id);
    if (!result) throw new Error(`Event "${params.id}" not found.`);
    return result;
  },
});
