import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { listEvents } from '../lib/events-api.ts';

export default tool({
  name: 'event-list',
  description: 'List events from the Clockworks event queue',
  instructions:
    'Returns events with optional filters. Use for forensics, monitoring, and event chain tracing. ' +
    'Returns newest first. Use pending: true to see what the Clockworks runner still needs to process.',
  params: {
    name: z.string().optional().describe('Filter by event name pattern (SQL LIKE — use % for wildcards)'),
    emitter: z.string().optional().describe('Filter by emitter (anima name, engine name, or "framework")'),
    pending: z.boolean().optional().describe('If true, only unprocessed events; if false, only processed'),
    limit: z.number().optional().default(20).describe('Maximum results'),
  },
  handler: (params) => {
    const { home } = guild();
    return listEvents(home, params);
  },
});
