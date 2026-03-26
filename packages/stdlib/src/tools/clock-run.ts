import { tool, clockRun } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-run',
  description: 'Process all pending events until the Clockworks queue is empty',
  instructions: 'Drains the Clockworks event queue, processing each event in order. Returns a summary of all dispatches.',
  params: {},
  handler: async (_params, { home }) => clockRun(home),
});
