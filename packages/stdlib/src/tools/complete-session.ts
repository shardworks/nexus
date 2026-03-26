import { tool } from '@shardworks/nexus-core';
import { completeWrit, readWrit, getWritChildren } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'complete-session',
  description: 'Signal that you have completed your work on the current writ. Call this when you are done.',
  instructions:
    'Call this when you have finished all the work you can do in this session. ' +
    'If you created child writs, the framework will wait for them to complete before marking your writ done. ' +
    'You MUST call this before the session ends — otherwise the writ will be treated as interrupted and re-dispatched.',
  params: {
    summary: z.string().optional().describe('Brief summary of what was accomplished'),
  },
  handler: (params, { home }) => {
    const writId = process.env.NEXUS_WRIT_ID;
    if (!writId) {
      return { status: 'no-writ', message: 'No writ bound to this session.' };
    }

    const writ = completeWrit(home, writId);

    if (writ.status === 'pending') {
      const children = getWritChildren(home, writId);
      const incomplete = children.filter(c =>
        c.status !== 'completed' && c.status !== 'cancelled',
      );
      return {
        status: 'pending',
        message: `Writ pending — ${incomplete.length} child item(s) still in progress.`,
        incompleteChildren: incomplete.map(c => ({ id: c.id, title: c.title, status: c.status })),
      };
    }

    return {
      status: writ.status,
      message: 'Writ completed. Good work.',
    };
  },
});
