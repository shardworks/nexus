import { tool, clockStop } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-stop',
  description: 'Stop the clockworks daemon',
  instructions: 'Stops the running clockworks daemon. Returns the PID that was stopped. Handles stale PID files gracefully. Fails if no daemon is running.',
  params: {},
  handler: (_params, { home }) => clockStop(home),
});
