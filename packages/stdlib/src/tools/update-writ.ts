import { tool } from '@shardworks/nexus-core';
import { failWrit, cancelWrit, interruptWrit, readWrit } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'update-writ',
  description: 'Administrative tool: update a writ status by ID. For orphan cleanup, cancellation, or manual re-dispatch.',
  instructions:
    'This is an administrative tool for managing writs outside the normal session flow. ' +
    'Use it to clean up orphaned writs, cancel work that is no longer needed, or re-open ' +
    'interrupted writs for re-dispatch.\n\n' +
    'Actions:\n' +
    '- **fail**: Terminal. Cascades cancellation to all incomplete children.\n' +
    '- **cancel**: Terminal. Cascades cancellation to all incomplete children.\n' +
    '- **reopen**: Transitions an active writ back to ready for re-dispatch. Use when a session died without reporting.',
  params: {
    writId: z.string().describe('The writ ID to update'),
    action: z.enum(['fail', 'cancel', 'reopen']).describe('The action to take'),
    reason: z.string().optional().describe('Reason for the action (used for fail)'),
  },
  handler: (params, { home }) => {
    const writ = readWrit(home, params.writId);
    if (!writ) {
      return { status: 'error', message: `Writ "${params.writId}" not found.` };
    }

    switch (params.action) {
      case 'fail': {
        const result = failWrit(home, params.writId);
        return {
          status: 'ok',
          action: 'failed',
          writId: result.id,
          previousStatus: writ.status,
          newStatus: result.status,
        };
      }
      case 'cancel': {
        const result = cancelWrit(home, params.writId);
        return {
          status: 'ok',
          action: 'cancelled',
          writId: result.id,
          previousStatus: writ.status,
          newStatus: result.status,
        };
      }
      case 'reopen': {
        const result = interruptWrit(home, params.writId);
        return {
          status: 'ok',
          action: 'reopened',
          writId: result.id,
          previousStatus: writ.status,
          newStatus: result.status,
          note: 'Writ is now ready. If a standing order matches, it will be re-dispatched.',
        };
      }
    }
  },
});
