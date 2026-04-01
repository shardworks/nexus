/**
 * Workshop Merge Engine (clockwork)
 *
 * Standing order handler for writ completion events on workspace-bound writs.
 * Merges the writ branch back into main in the workshop bare clone, optionally
 * cleans up the worktree, and signals the outcome.
 *
 * Key design constraints:
 * - Operates entirely on the bare clone — does NOT depend on the worktree
 *   existing. The session funnel may have already torn it down by the time
 *   the Clockworks processes the writ.completed event asynchronously.
 * - Fetches from the remote before merging so the local main is current.
 * - Idempotent: if the branch is already merged into main (e.g. duplicate
 *   writ.completed event), skips silently.
 *
 * Event flow:
 *   <type>.completed { writId, workshop }
 *     -> reads writ record for workshop
 *     -> fetches remote into bare clone
 *     -> merges writ branch into main in bare clone
 *     -> on success: optional worktree cleanup, signal writ.merged
 *     -> on conflict: optional worktree cleanup, signal writ.merge-failed
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workshopBarePath, worktreesPath, guild } from '@shardworks/nexus-core';
import { engine, signalEvent, readWrit, teardownWorktree } from '@shardworks/nexus-core/legacy/1';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Best-effort worktree cleanup. The worktree may already be gone (torn down
 * by session cleanup). This is fine — the important work (merge + push)
 * operates on the bare clone, not the worktree.
 */
function tryTeardownWorktree(home: string, workshop: string, writId: string): void {
  try {
    const branch = `writ-${writId}`;
    const worktreeDir = path.join(worktreesPath(home), workshop, branch);
    if (fs.existsSync(worktreeDir)) {
      teardownWorktree(home, workshop, writId);
    }
  } catch {
    // Worktree already gone or git prune issue — not a problem.
  }
}

export default engine({
  name: 'workshop-merge',
  handler: async (event) => {
    const { home } = guild();
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
      // Fetch the latest state from the remote so our local main is current.
      // This prevents stale-clone push rejections (non-fast-forward).
      git(['fetch', 'origin'], bareRepo);

      // After fetch, sync local main to match origin/main so merge-base
      // and fast-forward checks operate against the true remote state.
      try {
        const originMain = git(['rev-parse', 'origin/main'], bareRepo);
        git(['update-ref', 'refs/heads/main', originMain], bareRepo);
      } catch {
        // origin/main may not exist (e.g. fresh repo) — continue with local main
      }

      // Idempotency check: is the branch already fully merged into main?
      // If the branch tip is an ancestor of main, there's nothing to merge.
      try {
        git(['merge-base', '--is-ancestor', branch, 'main'], bareRepo);
        // Exit code 0 means branch IS an ancestor of main — already merged.
        tryTeardownWorktree(home, workshop, writId);
        signalEvent(home, 'writ.merged', {
          writId, workshop, result: 'already-merged',
        }, 'framework');
        return;
      } catch {
        // Exit code 1 means branch is NOT an ancestor — proceed with merge.
      }

      // Check if the branch has any commits ahead of main.
      const mergeBase = git(['merge-base', 'main', branch], bareRepo);
      const branchTip = git(['rev-parse', branch], bareRepo);

      if (mergeBase === branchTip) {
        // No new commits on the branch — nothing to merge
        tryTeardownWorktree(home, workshop, writId);
        signalEvent(home, 'writ.merged', {
          writId, workshop, result: 'no-changes',
        }, 'framework');
        return;
      }

      // Try a fast-forward merge
      const mainTip = git(['rev-parse', 'main'], bareRepo);
      if (mainTip === mergeBase) {
        // Fast-forward: main hasn't moved since the branch was created
        git(['update-ref', 'refs/heads/main', branchTip], bareRepo);

        // Push merged main to the remote so changes reach GitHub
        git(['push', 'origin', 'main'], bareRepo);

        tryTeardownWorktree(home, workshop, writId);
        signalEvent(home, 'writ.merged', {
          writId, workshop, result: 'fast-forward',
          commit: branchTip.slice(0, 7),
        }, 'framework');
        return;
      }

      // Non-fast-forward: main has diverged after fetch. This means
      // concurrent work landed on main that conflicts with this branch.
      // Signal merge-failed so the patron can review.
      tryTeardownWorktree(home, workshop, writId);
      signalEvent(home, 'writ.merge-failed', {
        writId,
        workshop,
        error: `main has diverged — fast-forward merge not possible (main: ${mainTip.slice(0, 7)}, branch: ${branchTip.slice(0, 7)}, base: ${mergeBase.slice(0, 7)})`,
      }, 'framework');
    } catch (err) {
      // Git operation failed — best-effort worktree cleanup and signal failure
      tryTeardownWorktree(home, workshop, writId);

      const errorMsg = err instanceof Error ? err.message : String(err);
      signalEvent(home, 'writ.merge-failed', {
        writId,
        workshop,
        error: errorMsg,
      }, 'framework');
    }
  },
});
