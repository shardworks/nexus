import { clockStart } from '@shardworks/nexus-core/legacy/1';
import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-start',
  description: 'Start the clockworks daemon (background event processing)',
  instructions: 'Starts the clockworks daemon as a background process that polls the event queue at a configurable interval. Returns the daemon PID and log file path. Fails if the daemon is already running.',
  params: {
    interval: z.number().optional().describe('Polling interval in milliseconds (default: 2000)'),
  },
  handler: (_params) => {
    const { home } = guild();
    return clockStart(home, { interval: _params.interval });
  },
});
