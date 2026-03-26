/**
 * signal tool.
 *
 * Signals a custom guild event. The event is persisted to the Ledger's events
 * table and will be processed by the Clockworks runner. Validates that the
 * event name is declared in guild.json and is not in a reserved namespace.
 */
import { tool, validateCustomEvent, signalEvent } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'signal',
  description: 'Signal a custom guild event for the Clockworks',
  instructionsFile: './instructions/signal.md',
  params: {
    name: z.string().describe('Event name (must be declared in guild.json clockworks.events)'),
    payload: z.record(z.string(), z.unknown()).optional().describe('Event payload (JSON object)'),
    force: z.boolean().optional().describe('Bypass event validation — allows framework-namespace events. Use for recovery only.'),
  },
  handler: (params, { home }) => {
    // Validate the event name is declared and not reserved (unless --force)
    if (!params.force) {
      validateCustomEvent(home, params.name);
    }

    // Persist the event
    const eventId = signalEvent(home, params.name, params.payload ?? null, 'anima');

    return { eventId, name: params.name };
  },
});
