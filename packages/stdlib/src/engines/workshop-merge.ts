/**
 * Workshop Merge Engine (clockwork)
 *
 * Standing order handler for writ completion events on workspace-bound writs.
 * Merges the writ branch back into main in the workshop bare repo, tears down
 * the worktree, and signals the outcome.
 *
 * Event flow:
 *   <type>.completed { writId, workshop }
 *     → reads writ record for workshop
 *     → merges writ branch into main in bare repo
 *     → on success: teardown worktree, signal writ.merged
 *     → on conflict: teardown worktree, signal writ.merge-failed
 */
import { execFileSync } from 'node:child_process';
import { engine, signalEvent, readWrit, workshopBarePath } from '@shardworks/nexus-core';
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
    if (!payload || typeof payload.writId !== 'string') {
      throw new Error(
        `workshop-merge expected payload with { writId }, got: ${JSON.stringify(payload)}`,
      );
    }

    const writId = payload.writId as string;

    // Read writ record to get workshop
    const writ = readWrit(home, writId);
    if (!writ) {
      throw new Error(`Writ "${writId}" not found.`);
    }

    // Only merge workspace-bound writs
    if (!writ.workshop) {
      return;
    }

    // Only merge top-level patron-posted writs — child writs inherit workshop
    // from their parent but do not have their own worktrees or branches.
    if (writ.parentId) {
      return;
    }

    const workshop = writ.workshop;
    const branch = `writ-${writId}`;
    const bareRepo = workshopBarePath(home, workshop);

    try {
      // Attempt to merge the writ branch into main.
      // First check if the branch has any commits ahead of main.
      const mergeBase = git(['merge-base', 'main', branch], bareRepo);
      const branchTip = git(['rev-parse', branch], bareRepo);

      if (mergeBase === branchTip) {
        // No new commits on the branch — nothing to merge
        teardownWorktree(home, workshop, writId);
        signalEvent(home, 'writ.merged', {
          writId, workshop, result: 'no-changes',
        }, 'framework');
        return;
      }

      // Try a fast-forward merge first
      const mainTip = git(['rev-parse', 'main'], bareRepo);
      if (mainTip === mergeBase) {
        // Fast-forward: main hasn't moved since the branch was created
        git(['update-ref', 'refs/heads/main', branchTip], bareRepo);

        // Push merged main to the remote so changes reach GitHub
        git(['push', 'origin', 'main'], bareRepo);

        teardownWorktree(home, workshop, writId);
        signalEvent(home, 'writ.merged', {
          writId, workshop, result: 'fast-forward',
          commit: branchTip.slice(0, 7),
        }, 'framework');
        return;
      }

      // Non-fast-forward: main has diverged. Fail cleanly — the patron
      // can review and resolve manually.
      teardownWorktree(home, workshop, writId);
      signalEvent(home, 'writ.merge-failed', {
        writId,
        workshop,
        error: `main has diverged — fast-forward merge not possible (main: ${mainTip.slice(0, 7)}, branch: ${branchTip.slice(0, 7)}, base: ${mergeBase.slice(0, 7)})`,
      }, 'framework');
    } catch (err) {
      // Git operation failed — tear down worktree and signal failure
      try {
        teardownWorktree(home, workshop, writId);
      } catch {
        // Worktree may already be gone; ignore cleanup errors
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      signalEvent(home, 'writ.merge-failed', {
        writId,
        workshop,
        error: errorMsg,
      }, 'framework');
    }
  },
});
