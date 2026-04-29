import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Allowed writ phases across all writ types (mirrors `WritPhase` from
 * the Clerk API). Required at the Zod boundary so `--help` enumerates
 * the legal values (D16). The typed API still enforces per-state
 * `allowedTransitions` and rejects illegal edges.
 */
const WRIT_PHASES = ['new', 'open', 'stuck', 'completed', 'failed', 'cancelled'] as const;

/**
 * Vision-specific stage enum (mirrors `VisionStage` from `../types.ts`).
 * Per D15 the caller supplies both phase and stage explicitly because a
 * single phase may map to multiple stages depending on context.
 */
const VISION_STAGES = ['draft', 'active', 'sunset', 'cancelled'] as const;

/**
 * Transition a vision: writes both `writ.phase` and the
 * `ext['cartograph'].stage` slot atomically inside one Stacks
 * transaction. Both `--phase` and `--stage` are required (D15) and
 * Zod-enum-validated (D16). Optional `--resolution` lands in the same
 * transaction (D17).
 */
export default tool({
  name: 'vision-transition',
  description: 'Transition a vision lifecycle (writes phase + stage atomically)',
  instructions:
    "Atomically updates the vision writ's phase and `ext['cartograph'].stage`. " +
    'Both --phase and --stage are required: a single phase may map to multiple ' +
    'stages depending on context (e.g. failed → cancelled vs failed → sunset). ' +
    'The typed API rejects illegal phase edges per the writ-type config.',
  params: {
    id: z.string().describe('Vision id (or short prefix)'),
    phase: z.enum(WRIT_PHASES).describe('Target phase on the underlying writ'),
    stage: z.enum(VISION_STAGES).describe("Target stage on writ.ext['cartograph'].stage"),
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
    return cartograph.transitionVision(resolvedId, {
      phase: params.phase,
      stage: params.stage,
      ...(params.resolution !== undefined ? { resolution: params.resolution } : {}),
    });
  },
});
