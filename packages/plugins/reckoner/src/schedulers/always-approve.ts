/**
 * The built-in always-approve scheduler.
 *
 * Default selector when `guild.json reckoner.scheduler` is unset
 * (D15). Returns one `'approve'` decision per candidate, carrying a
 * static reason string the apparatus persists onto the resulting
 * Reckonings row. Declares no `validateConfig` — any value supplied
 * via `reckoner.schedulerConfig` is accepted-and-ignored (D30).
 *
 * The id is the verbatim contract literal `reckoner.always-approve`
 * (D27). Future schedulers (`reckoner.priority-walk`, …) follow the
 * same `{pluginId}.{kebab-suffix}` grammar — see the apparatus
 * contract document for the validation rules.
 */

import type { Scheduler, SchedulerDecision, SchedulerInput } from '../types.ts';

/**
 * Static lineage string the apparatus copies onto the
 * `accepted` Reckonings row's reason slot (or threading
 * locations) when the always-approve scheduler emits a
 * decision. Kept grep-able so operators can find always-approve
 * decisions in the journal.
 */
const ALWAYS_APPROVE_REASON = 'always-approve scheduler';

/**
 * The default scheduler. Direct instance; no factory wrapper. The
 * Reckoner contributes this via `apparatus.supportKit.schedulers`
 * (D29) so it flows through `ctx.kits('schedulers')` exactly like a
 * user-contributed scheduler.
 */
export const alwaysApproveScheduler: Scheduler<unknown> = {
  id: 'reckoner.always-approve',
  description:
    'Approves every held petition that reaches the scheduler. The default ' +
    'scheduler in v0; no priority weighting, no capacity tracking, no defer.',
  async evaluate(input: SchedulerInput<unknown>): Promise<readonly SchedulerDecision[]> {
    const decisions: SchedulerDecision[] = [];
    for (const writ of input.candidates) {
      decisions.push({
        writId: writ.id,
        outcome: 'approve',
        reason: ALWAYS_APPROVE_REASON,
      });
    }
    return decisions;
  },
};
