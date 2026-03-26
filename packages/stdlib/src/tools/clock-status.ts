import { tool, clockStatus } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-status',
  description: 'Check whether the clockworks daemon is running',
  instructions: 'Returns the daemon status: running/stopped, PID, log file path, and uptime. Use this to verify the daemon is active before dispatching work that depends on automatic event processing.',
  params: {},
  handler: (_params, { home }) => clockStatus(home),
});
