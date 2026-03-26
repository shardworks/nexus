import { tool } from '@shardworks/nexus-core';
import { failWrit } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'fail-writ',
  description: 'Signal that the current writ cannot be completed. This is terminal.',
  instructions:
    'Call this when the work cannot be completed — unrecoverable errors, missing prerequisites, ' +
    'or fundamental blockers. The writ and all incomplete children will be cancelled. ' +
    'This is permanent. Only use it when you are certain the work cannot proceed.',
  params: {
    reason: z.string().describe('Why this writ cannot be completed'),
  },
  handler: (params, { home }) => {
    const writId = process.env.NEXUS_WRIT_ID;
    if (!writId) {
      return { status: 'error', message: 'No writ bound to this session.' };
    }

    const writ = failWrit(home, writId);
    return {
      status: 'failed',
      writId: writ.id,
      reason: params.reason,
    };
  },
});
