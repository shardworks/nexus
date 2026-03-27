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
import { engine, signalEvent, readWrit } from '@shardworks/nexus-core';
import { setupWorktree } from '@shardworks/nexus-core';

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

    // If no workshop on the writ, nothing to prepare — skip silently.
    // The summon-engine will handle workshopless writs differently.
    if (!writ.workshop) {
      return;
    }

    const workshop = writ.workshop;

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
