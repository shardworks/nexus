import { tool } from '@shardworks/nexus-core';
import { z } from 'zod';
import { clockStart } from '../daemon-ctrl.ts';

export default tool({
  name: 'clock-start',
  description: 'Start the Clockworks daemon (background event processing)',
  instructions:
    'Starts the Clockworks daemon as a background process that polls the event queue at a ' +
    'configurable interval. Returns the daemon PID and log file path. Fails if the daemon ' +
    'is already running.',
  params: {
    interval: z.number().optional().describe('Polling interval in milliseconds (default: 2000)'),
  },
  handler: (_params, ctx) => clockStart(ctx.home, { interval: _params.interval }),
});
