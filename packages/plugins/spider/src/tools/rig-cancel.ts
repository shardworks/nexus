/**
 * rig-cancel tool — cancel a running or blocked rig.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'rig-cancel',
  description: 'Cancel a running or blocked rig',
  instructions:
    'Cancels the rig: kills the active session (if any), marks all non-terminal engines ' +
    'as cancelled, rejects pending input requests, and transitions the rig to cancelled. ' +
    'Idempotent — returns the rig unchanged if already in a terminal state.',
  params: {
    rigId: z.string().describe('The rig id to cancel.'),
    reason: z.string().optional().describe('Optional reason for cancellation.'),
  },
  permission: 'spider:write',
  handler: async (params) => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.cancel(params.rigId, params.reason ? { reason: params.reason } : undefined);
  },
});
