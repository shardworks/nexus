import { tool, listEvents } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'event-list',
  description: 'List events from the Clockworks event queue',
  instructions: 'Returns events with optional filters. Use for understanding what happened — forensics, monitoring, event chain tracing.',
  params: {
    name: z.string().optional().describe('Filter by event name pattern (SQL LIKE — use % for wildcards)'),
    emitter: z.string().optional().describe('Filter by emitter'),
    pending: z.boolean().optional().describe('If true, only unprocessed events'),
    limit: z.number().optional().default(20).describe('Maximum results'),
  },
  handler: (params, { home }) => {
    return listEvents(home, {
      name: params.name,
      emitter: params.emitter,
      pending: params.pending,
      limit: params.limit,
    });
  },
});
