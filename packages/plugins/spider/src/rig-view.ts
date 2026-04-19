/**
 * Rig view aggregator — builds the UI-facing RigView from a persisted
 * RigDoc by joining against the animator/sessions book.
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
 */

import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '@shardworks/animator-apparatus';
import type {
  RigDoc,
  RigView,
  RigCostSummary,
  EngineCostSummary,
} from './types.ts';

/**
 * Build a RigView for a single rig by reading every engine's session doc
 * (if any) from the animator/sessions book and summing cost + token usage.
 *
 * Does not mutate the rig. Safe to call on every read.
 */
export async function enrichRigView(rig: RigDoc, stacks: StacksApi): Promise<RigView> {
  const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');

  // Collect (engineId, sessionId) pairs to look up.
  const pairs: Array<{ engineId: string; sessionId: string }> = [];
  for (const engine of rig.engines || []) {
    if (engine.sessionId) {
      pairs.push({ engineId: engine.id, sessionId: engine.sessionId });
    }
  }

  // No engines with sessions: no cost data to report.
  if (pairs.length === 0) {
    return { ...rig };
  }

  // Fetch all sessions concurrently.
  const sessions = await Promise.all(
    pairs.map((p) => sessionsBook.get(p.sessionId).catch(() => null)),
  );

  const engineCosts: Record<string, EngineCostSummary> = {};
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let anyTokenUsage = false;

  for (let i = 0; i < pairs.length; i++) {
    const { engineId } = pairs[i];
    const session = sessions[i];

    const costUsd = session?.costUsd ?? 0;
    const inputTokens = session?.tokenUsage?.inputTokens;
    const outputTokens = session?.tokenUsage?.outputTokens;

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

  return {
    ...rig,
    costSummary,
    engineCosts,
  };
}

/**
 * Enrich an array of rigs in parallel.
 */
export async function enrichRigViews(rigs: RigDoc[], stacks: StacksApi): Promise<RigView[]> {
  return Promise.all(rigs.map((r) => enrichRigView(r, stacks)));
}
