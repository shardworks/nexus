import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { clockTick } from '../lib/runner.ts';

export default tool({
  name: 'clock-tick',
  description: 'Process the next pending event, or a specific event by ID',
  instructions:
    'Processes one event from the Clockworks queue. Returns a summary of what standing orders ' +
    'were dispatched. Returns null if the queue is empty. Optionally specify an event ID to ' +
    'process a specific event (useful for reprocessing or targeted dispatch).',
  params: {
    id: z.string().optional().describe('Specific event ID to process (omit for next pending)'),
  },
  handler: async (params) => {
    const { home } = guild();
    return clockTick(home, params.id);
  },
});
