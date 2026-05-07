/**
 * CDC observer #2 — survey-completion outcome stamping.
 *
 * Watches `(clerk, writs)` at Phase 2 (failOnError: false). On every event
 * where a `survey-vision`, `survey-charge`, or `survey-piece` writ transitions
 * from a non-terminal phase to a terminal phase, it:
 *
 *   1. Computes the `SurveyorStatus` outcome blob:
 *      - `surveyedAt` = `writ.resolvedAt` (stamped by Clerk on terminal transition)
 *      - `childCount` = count of writs with type in {vision, charge, piece} and
 *        `parentId === surveyWrit.parentId` and `createdAt >= surveyWrit.createdAt`
 *      - `terminal` = echoed from the writ's terminal attrs
 *   2. Calls `clerk.setWritStatus(surveyId, SURVEYOR_PLUGIN_ID, outcome)`.
 *
 * The brief deliberately excludes a `surveyor-set-outcome` anima tool; this
 * CDC observer is the sole writer to `status['surveyor']`.
 *
 * See: docs/architecture/apparatus/surveyor.md §CDC Observers
 */

import type { ChangeEvent, ChangeHandler, StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { SurveyorStatus, SurveyorTerminal } from './types.ts';

// ── Terminal-classification helpers ───────────────────────────────────

const SURVEY_TYPES = new Set(['survey-vision', 'survey-charge', 'survey-piece']);
const CARTOGRAPH_TYPES = new Set(['vision', 'charge', 'piece']);
const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Derive the `SurveyorTerminal` enum from the writ's phase and attrs.
 * Mirrors the six-state mandate-clone classification:
 *   completed (attrs: success) → 'success'
 *   failed    (attrs: failure) → 'failure'
 *   cancelled (attrs: cancelled) → 'cancelled'
 */
function terminalFromPhase(phase: string): SurveyorTerminal {
  if (phase === 'completed') return 'success';
  if (phase === 'failed') return 'failure';
  return 'cancelled';
}

// ── Observer factory deps ──────────────────────────────────────────────

export interface OutcomeObserverDeps {
  clerk: ClerkApi;
  stacks: StacksApi;
  SURVEYOR_PLUGIN_ID: string;
}

/**
 * Create the Phase-2 CDC handler that stamps `status['surveyor']` on
 * terminal survey-writ transitions.
 */
export function createOutcomeObserver(deps: OutcomeObserverDeps): ChangeHandler<WritDoc> {
  const { clerk, stacks, SURVEYOR_PLUGIN_ID } = deps;

  return async (event: ChangeEvent<WritDoc>): Promise<void> => {
    // Only update events can be terminal transitions.
    if (event.type !== 'update') return;

    const writ = event.entry;

    // Filter to survey types only.
    if (!SURVEY_TYPES.has(writ.type)) return;

    // Only act on terminal phase.
    if (!isTerminalPhase(writ.phase)) return;

    // Ensure previous phase was non-terminal (actual transition, not re-fire).
    const prev = event.prev;
    if (isTerminalPhase(prev.phase)) return;

    // surveyedAt: Clerk stamps resolvedAt on terminal transitions.
    const surveyedAt = (writ as WritDoc & { resolvedAt?: string }).resolvedAt ?? new Date().toISOString();

    // childCount: cartograph writs with parentId === surveyWrit.parentId
    // and createdAt >= surveyWrit.createdAt.
    const parentId = writ.parentId;
    let childCount = 0;
    if (parentId !== undefined) {
      const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
      const children = await writsBook.find({
        where: [['parentId', '=', parentId]],
      });
      childCount = children.filter(
        (c) =>
          CARTOGRAPH_TYPES.has(c.type) &&
          c.createdAt >= writ.createdAt,
      ).length;
    }

    const terminal = terminalFromPhase(writ.phase);

    const outcome: SurveyorStatus = {
      surveyedAt,
      childCount,
      terminal,
    };

    await clerk.setWritStatus(writ.id, SURVEYOR_PLUGIN_ID, outcome);
  };
}
