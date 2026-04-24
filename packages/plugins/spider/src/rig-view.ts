/**
 * Rig view aggregator — builds the UI-facing RigView from a persisted
 * RigDoc by joining against the Animator's per-session cost snapshot and
 * the Clerk writs book for the rig's writ title.
 *
 * Read-only. Pure derived fields; never persisted.
 *
 * Aggregation rules (see commission D17, D10):
 * - Every engine with a sessionId contributes to both the rig-level
 *   costSummary and the per-engine engineCosts map, regardless of engine
 *   status. Sessions that exist but haven't reported cost yet contribute
 *   zeros; sessions that are missing from the book are skipped silently.
 * - tokenUsage fields are optional: when no contributing session has
 *   tokenUsage, the aggregate inputTokens/outputTokens are omitted.
 * - writTitle is populated from the `clerk/writs` book via a direct book
 *   read. On a miss (book returns null/undefined), writTitle is left
 *   unset; the client renders an em-dash fallback for that one row.
 *
 * The cost data comes from AnimatorApi.getSessionCosts — the Animator owns
 * the shape of cost answers, so consumers like this aggregator do not reach
 * into the sessions book directly.
 */

import { guild } from '@shardworks/nexus-core';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type {
  RigDoc,
  RigView,
  RigCostSummary,
  EngineCostSummary,
} from './types.ts';

/**
 * Build a RigView for a single rig by asking the Animator for cost/token
 * snapshots of every engine's session (if any) and summing across them.
 *
 * Does not mutate the rig. Safe to call on every read.
 *
 * Per-engine `sessionId` is read from the engine's latest attempt
 * (`attempts[-1].sessionId`) — the engine no longer carries a scalar
 * `sessionId` field. Earlier attempts' sessions (pre-retry) are not
 * currently aggregated; that is a deferred follow-up decision.
 */
export async function enrichRigView(rig: RigDoc): Promise<RigView> {
  // Look up the writ title from the clerk/writs book. Direct book read —
  // `book.get(id)` returns null/undefined on miss (no throw), matching the
  // omit-field semantic (client falls back to em-dash for that one row).
  const stacks = guild().apparatus<StacksApi>('stacks');
  const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
  const writTitlePromise = rig.writId
    ? writsBook.get(rig.writId).then((w) => (w && typeof w.title === 'string' ? w.title : undefined))
    : Promise.resolve<string | undefined>(undefined);

  // Collect (engineId, sessionId) pairs to look up.
  const pairs: Array<{ engineId: string; sessionId: string }> = [];
  for (const engine of rig.engines || []) {
    const attempts = engine.attempts ?? [];
    if (attempts.length === 0) continue;
    const tail = attempts[attempts.length - 1];
    if (tail.sessionId) {
      pairs.push({ engineId: engine.id, sessionId: tail.sessionId });
    }
  }

  // No engines with sessions: no cost data to report — but still attach
  // the writ title if we resolved one.
  if (pairs.length === 0) {
    const writTitle = await writTitlePromise;
    const view: RigView = { ...rig };
    if (writTitle !== undefined) view.writTitle = writTitle;
    return view;
  }

  // Resolve the Animator via the same apparatus-resolution mechanism
  // Spider's engines use elsewhere, and fetch cost snapshots in a single
  // bulk call. Missing ids are silently omitted from the returned Map
  // (see AnimatorApi.getSessionCosts), which preserves the "missing = zero
  // contribution" semantic this aggregator has always had.
  const animator = guild().apparatus<AnimatorApi>('animator');
  const [costs, writTitle] = await Promise.all([
    animator.getSessionCosts(pairs.map((p) => p.sessionId)),
    writTitlePromise,
  ]);

  const engineCosts: Record<string, EngineCostSummary> = {};
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let anyTokenUsage = false;

  for (const { engineId, sessionId } of pairs) {
    const cost = costs.get(sessionId);

    const costUsd = cost?.costUsd ?? 0;
    const inputTokens = cost?.inputTokens;
    const outputTokens = cost?.outputTokens;

    const engineCost: EngineCostSummary = { costUsd };
    if (inputTokens !== undefined) engineCost.inputTokens = inputTokens;
    if (outputTokens !== undefined) engineCost.outputTokens = outputTokens;
    engineCosts[engineId] = engineCost;

    totalCostUsd += costUsd;
    if (inputTokens !== undefined) {
      totalInputTokens += inputTokens;
      anyTokenUsage = true;
    }
    if (outputTokens !== undefined) {
      totalOutputTokens += outputTokens;
      anyTokenUsage = true;
    }
  }

  const costSummary: RigCostSummary = { costUsd: totalCostUsd };
  if (anyTokenUsage) {
    costSummary.inputTokens = totalInputTokens;
    costSummary.outputTokens = totalOutputTokens;
  }

  const view: RigView = {
    ...rig,
    costSummary,
    engineCosts,
  };
  if (writTitle !== undefined) view.writTitle = writTitle;
  return view;
}

/**
 * Enrich an array of rigs in parallel.
 */
export async function enrichRigViews(rigs: RigDoc[]): Promise<RigView[]> {
  return Promise.all(rigs.map((r) => enrichRigView(r)));
}
