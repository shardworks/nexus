import { tool, guild } from '@shardworks/nexus-core';
import { clockStop } from '../daemon-ctrl.ts';

export default tool({
  name: 'clock-stop',
  description: 'Stop the Clockworks daemon',
  instructions:
    'Stops the running Clockworks daemon by sending SIGTERM. Handles stale PID files gracefully. ' +
    'Fails if no daemon is running.',
  params: {},
  handler: (_params) => {
    const { home } = guild();
    return clockStop(home);
  },
});
