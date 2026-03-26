import { tool, clockStart } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-start',
  description: 'Start the clockworks daemon (background event processing)',
  instructions: 'Starts the clockworks daemon as a background process that polls the event queue at a configurable interval. Returns the daemon PID and log file path. Fails if the daemon is already running.',
  params: {
    interval: z.number().optional().describe('Polling interval in milliseconds (default: 2000)'),
  },
  handler: (_params, { home }) => clockStart(home, { interval: _params.interval }),
});
