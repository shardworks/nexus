import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';

import type { ClockworksApi } from '../types.ts';

/**
 * `signal` — anima-facing event emission.
 *
 * Animas call this tool to emit custom events into the Clockworks'
 * events book. Validation is delegated to the Clockworks apparatus's
 * `ClockworksApi.validateSignal(name)` method, which applies the
 * two-check rule (merged-set membership + framework-owned) against the
 * authoritative event set assembled at apparatus `start()`.
 *
 * The tool itself does not pre-check payload serializability — that is
 * `emit`'s sole responsibility (commission decision D11). Validation
 * rejects throw plain descriptive `Error` instances; the CLI and
 * tool-server layers already format thrown errors for their surfaces.
 *
 * The emitter is hardcoded to `'anima'` — no spoofing surface from the
 * params shape. The tool is restricted to `callableBy: ['anima']` so
 * the patron-facing CLI auto-builder does not auto-register a second
 * `nsg signal` command alongside the hand-written one in
 * `packages/framework/cli`.
 */
export default tool({
  name: 'signal',
  description: 'Emit a custom event into the Clockworks events book.',
  instructions:
    'Emits a declared custom event. The event name must be declared in ' +
    'guild.json under `clockworks.events` or by a plugin and must not ' +
    'collide with framework-owned event names. Payload must be ' +
    'JSON-serializable; pass omit the payload for an event with no data ' +
    '(stored as null).',
  // Restrict to anima callers so the CLI auto-builder skips this tool.
  // The hand-written `nsg signal` command in the framework CLI owns the
  // patron-facing surface.
  callableBy: ['anima'],
  params: {
    name: z.string().describe('Event name — must be declared under clockworks.events.'),
    payload: z
      .unknown()
      .optional()
      .describe('JSON-serializable event payload. Omitted → null.'),
  },
  handler: async (params) => {
    const g = guild();
    const clockworks = g.apparatus<ClockworksApi>('clockworks');

    // Two-check validation lives inside the apparatus closure; both the
    // anima tool and the operator CLI go through the same entry point.
    clockworks.validateSignal(params.name);

    // Emitter is hardcoded — animas cannot spoof the source attribution
    // that lands on the persisted event row.
    return clockworks.emit(params.name, params.payload, 'anima');
  },
});
