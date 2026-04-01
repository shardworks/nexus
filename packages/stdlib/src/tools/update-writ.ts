import { tool, guild } from '@shardworks/nexus-core';
import { failWrit, cancelWrit, interruptWrit, adminCompleteWrit, reopenFailedWrit, readWrit } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'update-writ',
  description: 'Administrative tool: update a writ status by ID. For orphan cleanup, cancellation, completion, or manual re-dispatch.',
  instructions:
    'This is an administrative tool for managing writs outside the normal session flow. ' +
    'Use it to clean up orphaned writs, cancel work that is no longer needed, administratively ' +
    'complete stuck writs, or re-open writs for re-dispatch.\n\n' +
    'Actions:\n' +
    '- **fail**: Terminal. Marks the writ as failed and cascades cancellation to all incomplete children.\n' +
    '- **cancel**: Terminal. Marks the writ as cancelled and cascades cancellation to all incomplete children.\n' +
    '- **reopen**: Transitions an active writ back to ready for re-dispatch. Use when a session died without reporting.\n' +
    '- **complete**: Administratively completes a writ in pending or active state. Fires completion events and triggers parent rollup. Use to unstick a pending writ whose children were all cancelled.\n' +
    '- **reopen-failed**: Transitions a failed writ back to ready and fires a ready event for re-dispatch. Use to recover from a failed writ without recreating it.',
  params: {
    writId: z.string().describe('The writ ID to update'),
    action: z.enum(['fail', 'cancel', 'reopen', 'complete', 'reopen-failed']).describe('The action to take'),
    reason: z.string().optional().describe('Reason for the action (used for fail)'),
  },
  handler: (params) => {
    const { home } = guild();
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
      case 'complete': {
        const result = adminCompleteWrit(home, params.writId);
        return {
          status: 'ok',
          action: 'completed',
          writId: result.id,
          previousStatus: writ.status,
          newStatus: result.status,
          note: 'Writ administratively completed. Completion events fired and parent rollup triggered.',
        };
      }
      case 'reopen-failed': {
        const result = reopenFailedWrit(home, params.writId);
        return {
          status: 'ok',
          action: 'reopened-from-failed',
          writId: result.id,
          previousStatus: writ.status,
          newStatus: result.status,
          note: 'Writ transitioned from failed to ready. If a standing order matches, it will be re-dispatched.',
        };
      }
    }
  },
});
