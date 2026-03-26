/**
 * Workshop Merge Engine (clockwork)
 *
 * Standing order handler for commission.session.ended events. Merges the
 * commission branch back into main in the workshop bare repo, tears down
 * the worktree, and signals the outcome.
 *
 * Event flow:
 *   commission.session.ended { commissionId, workshop, exitCode }
 *     → merges commission branch into main in bare repo
 *     → on success: teardown worktree, status → completed, signal commission.completed
 *     → on conflict: teardown worktree, status → failed, signal commission.failed
 */
import { execFileSync } from 'node:child_process';
import { engine, signalEvent, updateCommissionStatus, workshopBarePath } from '@shardworks/nexus-core';
import { teardownWorktree } from '@shardworks/nexus-core';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export default engine({
  name: 'workshop-merge',
  handler: async (event, { home }) => {
    if (!event) {
      throw new Error('workshop-merge requires an event (cannot be invoked directly).');
    }

    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.commissionId !== 'string' || typeof payload.workshop !== 'string') {
      throw new Error(
        `workshop-merge expected payload with { commissionId, workshop }, got: ${JSON.stringify(payload)}`,
      );
    }

    const commissionId = payload.commissionId as string;
    const workshop = payload.workshop as string;
    const branch = `commission-${commissionId}`;
    const bareRepo = workshopBarePath(home, workshop);

    try {
      // Attempt to merge the commission branch into main.
      // In a bare repo, we use a temporary index to do the merge.
      // First check if the branch has any commits ahead of main.
      const mergeBase = git(['merge-base', 'main', branch], bareRepo);
      const branchTip = git(['rev-parse', branch], bareRepo);

      if (mergeBase === branchTip) {
        // No new commits on the branch — nothing to merge
        teardownWorktree(home, workshop, commissionId);
        updateCommissionStatus(home, commissionId, 'completed', 'no changes — nothing to merge');
        signalEvent(home, 'commission.completed', { commissionId, workshop }, 'framework');
        return;
      }

      // Try a fast-forward merge first
      const mainTip = git(['rev-parse', 'main'], bareRepo);
      if (mainTip === mergeBase) {
        // Fast-forward: main hasn't moved since the branch was created
        git(['update-ref', 'refs/heads/main', branchTip], bareRepo);

        // Push merged main to the remote so changes reach GitHub
        git(['push', 'origin', 'main'], bareRepo);

        teardownWorktree(home, workshop, commissionId);
        updateCommissionStatus(home, commissionId, 'completed', `merged to main (fast-forward to ${branchTip.slice(0, 7)})`);
        signalEvent(home, 'commission.completed', { commissionId, workshop }, 'framework');
        return;
      }

      // Non-fast-forward: main has diverged. Attempt a real merge.
      // Use a temporary worktree for the merge operation since we can't
      // merge directly in a bare repo.
      //
      // For now, fail on non-fast-forward merges. A real three-way merge
      // in a bare repo requires a temporary index/worktree dance that adds
      // significant complexity. This is the safe choice: the commission
      // fails cleanly, and the patron can review and resolve manually.
      teardownWorktree(home, workshop, commissionId);
      updateCommissionStatus(
        home,
        commissionId,
        'failed',
        `main has diverged — fast-forward merge not possible (main: ${mainTip.slice(0, 7)}, branch: ${branchTip.slice(0, 7)}, base: ${mergeBase.slice(0, 7)})`,
      );
      signalEvent(home, 'commission.failed', {
        commissionId,
        workshop,
        error: 'main has diverged — fast-forward merge not possible',
      }, 'framework');
    } catch (err) {
      // Git operation failed — tear down worktree and fail the commission
      try {
        teardownWorktree(home, workshop, commissionId);
      } catch {
        // Worktree may already be gone; ignore cleanup errors
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      updateCommissionStatus(home, commissionId, 'failed', `merge error: ${errorMsg}`);
      signalEvent(home, 'commission.failed', {
        commissionId,
        workshop,
        error: errorMsg,
      }, 'framework');
    }
  },
});
