/**
 * Workshop Prepare Engine (clockwork)
 *
 * Standing order handler for commission.posted events. Creates an isolated
 * git worktree for the commission and signals commission.ready so the next
 * standing order (summon artificer) can launch the session.
 *
 * Event flow:
 *   commission.posted { commissionId, workshop }
 *     → creates worktree from workshop bare repo
 *     → updates commission status → in_progress
 *     → signals commission.ready { commissionId, workshop, worktreePath }
 */
import { engine, signalEvent, updateCommissionStatus, readCommission } from '@shardworks/nexus-core';
import { setupWorktree } from '@shardworks/nexus-core';

export default engine({
  name: 'workshop-prepare',
  handler: async (event, { home }) => {
    if (!event) {
      throw new Error('workshop-prepare requires an event (cannot be invoked directly).');
    }

    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.commissionId !== 'string' || typeof payload.workshop !== 'string') {
      throw new Error(
        `workshop-prepare expected payload with { commissionId, workshop }, got: ${JSON.stringify(payload)}`,
      );
    }

    const commissionId = payload.commissionId as string;
    const workshop = payload.workshop as string;

    // Verify commission exists
    const commission = readCommission(home, commissionId);
    if (!commission) {
      throw new Error(`Commission #${commissionId} not found in the Ledger.`);
    }

    // Create the worktree
    const worktree = setupWorktree({
      home,
      workshop,
      commissionId,
    });

    // Update commission status
    updateCommissionStatus(
      home,
      commissionId,
      'in_progress',
      `worktree ready on branch ${worktree.branch}`,
    );

    // Signal ready for the next standing order (summon artificer)
    signalEvent(
      home,
      'commission.ready',
      { commissionId, workshop, worktreePath: worktree.path },
      'framework',
    );
  },
});
