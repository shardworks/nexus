/**
 * Workshop Prepare Engine (clockwork)
 *
 * Standing order handler for writ.ready events. Creates an isolated
 * git worktree for the writ and signals writ.workspace-ready so the next
 * standing order (summon artificer) can launch the session.
 *
 * Idempotent: if the worktree already exists (interrupted or rolled-up
 * writs being re-dispatched), skips git setup and fires
 * writ.workspace-ready immediately.
 *
 * Event flow:
 *   writ.ready { writId, ... }
 *     → reads writ record for workshop
 *     → creates worktree from workshop bare repo (or reuses existing)
 *     → signals writ.workspace-ready { writId, workshop, worktreePath }
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { engine, signalEvent, readWrit, workshopBarePath, worktreesPath } from '@shardworks/nexus-core';
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

    // Check if the worktree already exists (interrupted or rolled-up writs).
    // If so, skip git setup and re-enter the dispatch pipeline directly.
    const branch = `writ-${writId}`;
    const existingWorktree = path.join(worktreesPath(home), workshop, branch);
    if (fs.existsSync(existingWorktree)) {
      signalEvent(
        home,
        'writ.workspace-ready',
        { writId, workshop, worktreePath: existingWorktree },
        'framework',
      );
      return;
    }

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
