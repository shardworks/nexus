/**
 * session-cancel tool — cancel a running session.
 *
 * Delegates to AnimatorApi.cancel() which patches the SessionDoc to
 * 'cancelled' and sends a kill signal via the provider if possible.
 *
 * See: docs/specification.md (animator § session-cancel tool)
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { AnimatorApi } from '../types.ts';

export default tool({
  name: 'session-cancel',
  description: 'Cancel a running session',
  instructions:
    'Cancels a running session by patching its status to "cancelled" and ' +
    'sending a kill signal to the provider process if possible. ' +
    'Idempotent: returns the existing SessionDoc unchanged if the session ' +
    'is already in a terminal state. Throws if the session id does not exist.',
  params: {
    id: z.string().describe('Session id to cancel'),
    reason: z.string().optional().describe('Optional reason for cancellation'),
  },
  callableBy: 'patron',
  permission: 'animate',
  handler: async (params) => {
    const animator = guild().apparatus<AnimatorApi>('animator');
    return animator.cancel(params.id, { reason: params.reason });
  },
});
