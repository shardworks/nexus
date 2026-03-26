import { tool, readPendingEvents } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'clock-list',
  description: 'Show pending (unprocessed) events in the Clockworks queue',
  instructions: 'Returns all unprocessed events from the Clockworks event queue, ordered by fire time.',
  params: {},
  handler: (_params, { home }) => readPendingEvents(home),
});
