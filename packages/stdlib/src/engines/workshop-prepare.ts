/**
 * Workshop Prepare Engine (clockwork)
 *
 * Standing order handler for writ.posted events. Creates an isolated
 * git worktree for the writ and signals writ.workspace-ready so the next
 * standing order (summon artificer) can launch the session.
 *
 * Event flow:
 *   writ.posted { writId, workshop }
 *     → reads writ record for workshop
 *     → creates worktree from workshop bare repo
 *     → signals writ.workspace-ready { writId, workshop, worktreePath }
 */
import { execFileSync } from 'node:child_process';
import { engine, signalEvent, readWrit, workshopBarePath } from '@shardworks/nexus-core';
import { setupWorktree } from '@shardworks/nexus-core';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export default engine({
  name: 'workshop-prepare',
  handler: async (event, { home }) => {
    if (!event) {
      throw new Error('workshop-prepare requires an event (cannot be invoked directly).');
    }

    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.writId !== 'string') {
      throw new Error(
        `workshop-prepare expected payload with { writId }, got: ${JSON.stringify(payload)}`,
      );
    }

    const writId = payload.writId as string;

    // Read writ record to get workshop
    const writ = readWrit(home, writId);
    if (!writ) {
      throw new Error(`Writ "${writId}" not found.`);
    }

    // If no workshop on the writ, signal workspace-ready with null worktreePath
    // so the summon-engine standing order still fires and can launch a
    // restricted (read-only tool) session for knowledge/planning work.
    if (!writ.workshop) {
      signalEvent(home, 'writ.workspace-ready', { writId, workshop: null, worktreePath: null }, 'framework');
      return;
    }

    const workshop = writ.workshop;

    // Fetch the latest state from the remote so the writ branch starts from
    // the freshest available main. This minimises divergence between the
    // writ's work and anything that lands on main while the artificer runs.
    const bareRepo = workshopBarePath(home, workshop);
    try {
      git(['fetch', 'origin'], bareRepo);
    } catch {
      // Fetch failure is non-fatal — we can still branch from the local main.
      // The merge engine will fetch again before merging.
    }

    // Create the worktree
    const worktree = setupWorktree({
      home,
      workshop,
      writId,
    });

    // Signal ready for the next standing order (summon artificer)
    signalEvent(
      home,
      'writ.workspace-ready',
      { writId, workshop, worktreePath: worktree.path },
      'framework',
    );
  },
});
