import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/** Allowed writ phases (mirrors `WritPhase` from the Clerk API). */
const WRIT_PHASES = ['new', 'open', 'stuck', 'completed', 'failed', 'cancelled'] as const;

/** Charge-specific stage enum (mirrors `ChargeStage` from `../types.ts`). */
const CHARGE_STAGES = ['draft', 'active', 'validated', 'dropped'] as const;

/**
 * Transition a charge: writes both `writ.phase` and the
 * `ext['cartograph'].stage` slot atomically inside one Stacks
 * transaction. Both `--phase` and `--stage` are required (D15) and
 * Zod-enum-validated (D16). Optional `--resolution` lands in the same
 * transaction (D17).
 */
export default tool({
  name: 'charge-transition',
  description: 'Transition a charge lifecycle (writes phase + stage atomically)',
  instructions:
    "Atomically updates the charge writ's phase and `ext['cartograph'].stage`. " +
    'Both --phase and --stage are required: a single phase may map to multiple ' +
    'stages depending on context (e.g. failed → dropped vs failed → validated). ' +
    'The typed API rejects illegal phase edges per the writ-type config.',
  params: {
    id: z.string().describe('Charge id (or short prefix)'),
    phase: z.enum(WRIT_PHASES).describe('Target phase on the underlying writ'),
    stage: z.enum(CHARGE_STAGES).describe("Target stage on writ.ext['cartograph'].stage"),
    resolution: z
      .string()
      .optional()
      .describe('Optional resolution string. Recorded on terminal transitions.'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return cartograph.transitionCharge(resolvedId, {
      phase: params.phase,
      stage: params.stage,
      ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
    });
  },
});
