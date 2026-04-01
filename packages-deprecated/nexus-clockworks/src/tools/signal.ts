/**
 * signal tool — anima-facing tool to emit a custom guild event.
 *
 * Validates the event name against guild.json clockworks.events before
 * persisting it to the event queue. The `force` flag bypasses validation
 * for recovery use cases.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { validateCustomEvent, signalEvent } from '../lib/events-api.ts';

export default tool({
  name: 'signal',
  description: 'Signal a custom guild event for the Clockworks',
  instructions:
    'Emits a named event to the Clockworks event queue. The event name must be declared in ' +
    'guild.json clockworks.events (custom events only — framework-namespace events like ' +
    '"writ.*" are reserved). The event is persisted immediately but processed asynchronously ' +
    'by the Clockworks runner.',
  params: {
    name: z.string().describe('Event name (must be declared in guild.json clockworks.events)'),
    payload: z.record(z.string(), z.unknown()).optional().describe('Event payload (JSON object)'),
    force: z.boolean().optional().describe(
      'Bypass event validation — allows framework-namespace events. Use for recovery only.',
    ),
  },
  handler: (params) => {
    const { home } = guild();
    if (!params.force) {
      validateCustomEvent(home, params.name);
    }
    const eventId = signalEvent(home, params.name, params.payload ?? null, 'anima');
    return { eventId, name: params.name };
  },
});
