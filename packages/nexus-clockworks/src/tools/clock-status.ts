import { tool, guild } from '@shardworks/nexus-core';
import { clockStatus } from '../daemon-ctrl.ts';

export default tool({
  name: 'clock-status',
  description: 'Check whether the Clockworks daemon is running',
  instructions:
    'Returns the daemon status: running/stopped, PID, log file path, and uptime in milliseconds. ' +
    'Use this to verify the daemon is active before dispatching work that depends on automatic ' +
    'event processing.',
  params: {},
  handler: (_params) => {
    const { home } = guild();
    return clockStatus(home);
  },
});
