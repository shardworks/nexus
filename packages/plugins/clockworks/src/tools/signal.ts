import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import type { ClockworksApi } from '../types.ts';
import { validateSignal } from '../signal-validator.ts';

/**
 * `signal` — anima-facing event emission.
 *
 * Animas call this tool to emit custom events into the Clockworks'
 * events book. The tool runs three layers of validation before
 * delegating to `ClockworksApi.emit`:
 *
 *   1. Reject reserved framework namespaces (seven catalogued prefixes).
 *   2. Reject writ-lifecycle patterns — `<type>.{ready,completed,stuck,
 *      failed}` for every type returned by `ClerkApi.listWritTypes()`.
 *   3. Reject names not declared under `guild.json` `clockworks.events`.
 *
 * The tool does not pre-check payload serializability — that is `emit`'s
 * sole responsibility (commission decision D11). Validation rejects
 * throw plain descriptive `Error` instances (D7); the CLI and
 * tool-server layers already format thrown errors for their surfaces.
 *
 * The tool is restricted to `callableBy: ['anima']` so the patron-facing
 * CLI auto-builder does not auto-register a second `nsg signal` command
 * alongside the hand-written one in `packages/framework/cli`.
 */
export default tool({
  name: 'signal',
  description: 'Emit a custom event into the Clockworks events book.',
  instructions:
    'Emits a declared custom event. The event name must be declared in ' +
    'guild.json under `clockworks.events` and must not collide with ' +
    'reserved framework namespaces or writ-lifecycle patterns. Payload ' +
    'must be JSON-serializable; pass omit the payload for an event with ' +
    'no data (stored as null).',
  // Restrict to anima callers so the CLI auto-builder skips this tool
  // (D6). The hand-written `nsg signal` command in the framework CLI
  // owns the patron-facing surface.
  callableBy: ['anima'],
  params: {
    name: z.string().describe('Event name — must be declared under clockworks.events.'),
    payload: z
      .unknown()
      .optional()
      .describe('JSON-serializable event payload. Omitted → null.'),
    emitter: z
      .string()
      .optional()
      .describe('Identity of the caller emitting this event. Defaults to "anima".'),
  },
  handler: async (params) => {
    const g = guild();
    const clerk = g.apparatus<ClerkApi>('clerk');
    const clockworks = g.apparatus<ClockworksApi>('clockworks');
    const guildConfig = g.guildConfig();

    const declaredEvents = guildConfig.clockworks?.events ?? {};
    const writTypes = clerk.listWritTypes().map((t) => t.name);

    validateSignal(params.name, declaredEvents, writTypes);

    const emitter = params.emitter ?? 'anima';
    return clockworks.emit(params.name, params.payload, emitter);
  },
});
