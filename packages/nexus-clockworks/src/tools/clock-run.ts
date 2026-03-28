import { tool } from '@shardworks/nexus-core';
import { clockRun } from '../lib/runner.ts';

export default tool({
  name: 'clock-run',
  description: 'Process all pending events until the Clockworks queue is empty',
  instructions:
    'Drains the Clockworks event queue, processing each event in order. Loops until no ' +
    'pending events remain (standing order failures may generate new events). Returns a ' +
    'summary of all events processed and their dispatch outcomes.',
  params: {},
  handler: async (_params, ctx) => clockRun(ctx.home),
});
