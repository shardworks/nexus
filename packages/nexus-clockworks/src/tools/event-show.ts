import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { readEvent, listDispatches } from '../lib/events-api.ts';

export default tool({
  name: 'event-show',
  description: 'Show details of a specific event including its dispatch records',
  instructions: 'Returns the full event record including payload and all dispatch records for this event.',
  params: {
    id: z.string().describe('Event ID'),
  },
  handler: (params) => {
    const { home } = guild();
    const event = readEvent(home, params.id);
    if (!event) throw new Error(`Event "${params.id}" not found.`);
    const dispatches = listDispatches(home, { eventId: params.id });
    return { ...event, dispatches };
  },
});
