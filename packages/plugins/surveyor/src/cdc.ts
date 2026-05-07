/**
 * CDC observer #1 — cartograph node observer.
 *
 * Watches `(clerk, writs)` at Phase 2 (failOnError: false). On every
 * create+update event for `vision`, `charge`, or `piece` writs:
 *
 *   1. Short-circuits when no surveyor is registered (D15 zero case).
 *   2. Dedupes by `(parentId, parentUpdatedAt)` — skips emission when a
 *      non-terminal survey writ already exists for the same parent at the
 *      same `updatedAt` (D24).
 *   3. Inside one outer `stacks.transaction` (D12):
 *      a. `clerk.post` a `survey-${layer}` writ with title `Survey ${layer}: ${parent.title}`,
 *         empty body (D11), `parentId = event.entry.id`, codex inherited from parent.
 *      b. `clerk.setWritExt(surveyId, SURVEYOR_PLUGIN_ID, { surveyorId, rigVersion?, parentUpdatedAt })`
 *      c. `reckoner.petition(surveyId, { source, priority, complexity? })` stamp-only.
 *   4. `failOnError: false` — a substrate fault must never roll back the
 *      cartograph commit that triggered the watcher (D23).
 *
 * The type filter admits only `vision`, `charge`, `piece` — survey-* writs
 * are excluded so no CDC loop forms.
 *
 * See: docs/architecture/apparatus/surveyor.md §CDC Observers
 */

import type { StacksApi, ChangeEvent, ChangeHandler } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { ReckonerApi, PetitionExtRequest } from '@shardworks/reckoner-apparatus';
import type { SurveyorDescriptor, SurveyorExt, SurveyorLayer, SurveyorWritExt } from './types.ts';
import type { defaultPriority as DefaultPriorityFn } from './priority.ts';

// ── Terminal-phase check ───────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

// ── Observer factory deps ──────────────────────────────────────────────

export interface CartographObserverDeps {
  getActiveSurveyor: () => SurveyorDescriptor | undefined;
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  defaultPriority: typeof DefaultPriorityFn;
  SURVEYOR_PLUGIN_ID: string;
}

/**
 * Create the Phase-2 CDC handler that watches cartograph writs and emits
 * survey petitions. Returns a `ChangeHandler<WritDoc>` suitable for
 * `stacks.watch('clerk', 'writs', handler, { failOnError: false })`.
 */
export function createCartographObserver(deps: CartographObserverDeps): ChangeHandler<WritDoc> {
  const { getActiveSurveyor, stacks, clerk, reckoner, defaultPriority, SURVEYOR_PLUGIN_ID } = deps;

  // Type guard inlined to avoid circular import with surveyor.ts.
  const isCartographType = (type: string): type is SurveyorLayer =>
    type === 'vision' || type === 'charge' || type === 'piece';

  const isSurveyType = (type: string): boolean =>
    type === 'survey-vision' || type === 'survey-charge' || type === 'survey-piece';

  return async (event: ChangeEvent<WritDoc>): Promise<void> => {
    // Only care about create and update events.
    if (event.type !== 'create' && event.type !== 'update') return;

    const writ = event.entry;

    // Type filter — admit only cartograph types; exclude survey-* to prevent loops.
    if (!isCartographType(writ.type)) return;
    if (isSurveyType(writ.type)) return; // defence-in-depth

    const layer: SurveyorLayer = writ.type;

    // D15 zero-surveyor: short-circuit silently.
    const surveyor = getActiveSurveyor();
    if (surveyor === undefined) return;

    // D24 dedupe: skip if a non-terminal survey writ already exists for
    // (parentId = writ.id, parentUpdatedAt = writ.updatedAt).
    const surveyType = `survey-${layer}`;
    const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
    const existingSurveys = await writsBook.find({
      where: [['type', '=', surveyType], ['parentId', '=', writ.id]],
    });
    const parentUpdatedAt = writ.updatedAt;
    const alreadySurveyed = existingSurveys.some((s) => {
      if (isTerminalPhase(s.phase)) return false;
      // Check the envelope for the stored parentUpdatedAt.
      const envelope = s.ext?.[SURVEYOR_PLUGIN_ID] as SurveyorWritExt | undefined;
      return envelope?.parentUpdatedAt === parentUpdatedAt;
    });
    if (alreadySurveyed) return;

    // Read hints from ext['surveyor'] on the cartograph node.
    const hints = writ.ext?.[SURVEYOR_PLUGIN_ID] as SurveyorExt | undefined;

    // Translate hints to Reckoner priority.
    const { priority, complexity } = defaultPriority(layer, hints);

    // D13 source id composition.
    const source = `${surveyor.id}.survey-${layer}`;

    // D12 transactional emission.
    await stacks.transaction(async () => {
      // D25 title convention.
      const title = `Survey ${layer}: ${writ.title}`;

      // D11 body is empty; rig fills on completion.
      const surveyWrit = await clerk.post({
        type: surveyType,
        title,
        body: '',
        parentId: writ.id,
        ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      });

      // D7 / D16 envelope.
      const envelope: SurveyorWritExt = {
        surveyorId: surveyor.id,
        parentUpdatedAt,
        ...(surveyor.version !== undefined ? { rigVersion: surveyor.version } : {}),
      };
      await clerk.setWritExt(surveyWrit.id, SURVEYOR_PLUGIN_ID, envelope);

      // Stamp-only petition (D20).
      const petitionExt: PetitionExtRequest = {
        source,
        priority,
        ...(complexity !== undefined ? { complexity } : {}),
      };
      await reckoner.petition(surveyWrit.id, petitionExt);
    });
  };
}
