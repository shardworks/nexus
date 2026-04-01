import { clockTick } from '@shardworks/nexus-core/legacy/1';
import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-tick',
  description: 'Process the next pending event, or a specific event by ID',
  instructions: 'Processes one event from the Clockworks queue. Optionally specify an event ID to process a specific event.',
  params: {
    id: z.string().optional().describe('Specific event ID to process'),
  },
  handler: async (params) => {
    const { home } = guild();
    return clockTick(home, params.id);
  },
});
