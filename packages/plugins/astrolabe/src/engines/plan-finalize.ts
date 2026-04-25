/**
 * plan-finalize clockwork engine.
 *
 * Planning-phase terminator for the combined plan-and-ship rig. Does NOT
 * post a mandate writ and does NOT create any clerk links. It validates
 * that the spec-writer stage produced a spec, parses the predicted-files
 * count from the spec's `<task-manifest>`, atomically transitions the
 * plan's status from `writing` to `completed` while persisting the count
 * on the PlanDoc, and emits a soft-warn Clockworks event when the count
 * strictly exceeds the configured threshold.
 *
 * The count + emit responsibility is a measurement layer — the framework
 * records the signal, the pipeline does not halt. Subscribers (sanctum-
 * side instrumentation, future auto-decompose) decide what to do with it.
 *
 * Preconditions:
 *   - plan.status must be 'writing'
 *   - plan.spec must be a non-empty string
 *
 * Side effects:
 *   - PlanDoc patched with `{ status: 'completed', manifestFilesCount, updatedAt }`.
 *   - When `manifestFilesCount > resolvedThreshold`, emits exactly one
 *     `astrolabe.plan.files-over-threshold` Clockworks event (best-effort).
 *
 * Order of operations (D12): parse → single patch (status + count) → emit.
 * The patch lands before the emit attempt so a Clockworks failure cannot
 * roll back the status transition. A persisted emit-flag is unnecessary
 * (D14) — the `writing` → `completed` precondition already prevents
 * re-runs.
 */

import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { ClockworksApi } from '@shardworks/clockworks-apparatus';

import { guild } from '@shardworks/nexus-core';

import type { PlanDoc } from '../types.ts';
import { countManifestFiles } from '../manifest-files.ts';
import { resolvePredictedFilesThreshold } from '../astrolabe.ts';

/** Plugin id used as the literal `emitter` value on every framework event. */
const FRAMEWORK_EMITTER = 'framework';

/**
 * Resolve the Clockworks at call time. Returns null when it isn't
 * installed (astrolabe declares clockworks in `recommends`, not
 * `requires`). Mirrors the lazy resolution `summon()` and the animator's
 * `tryResolveClockworks` use for `LoomApi` and `ClockworksApi`.
 */
function tryResolveClockworks(): ClockworksApi | null {
  try {
    return guild().apparatus<ClockworksApi>('clockworks');
  } catch {
    return null;
  }
}

export function createPlanFinalizeEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.plan-finalize',

    async run(
      givens: Record<string, unknown>,
      _context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const planId = givens.planId as string;
      const book = getPlansBook();

      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      // Validate status
      if (plan.status !== 'writing') {
        throw new Error(
          `plan-finalize: expected plan status "writing" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      // Validate spec exists
      if (typeof plan.spec !== 'string' || plan.spec.length === 0) {
        throw new Error(
          `Plan "${planId}" has no spec — spec-writer stage did not produce output.`,
        );
      }

      const spec = plan.spec;

      // Parse the predicted-files count from the task-manifest. Returns
      // 0 when no manifest is present, the spec is malformed, or no
      // path-shaped tokens are found (D3, D16).
      const manifestFilesCount = countManifestFiles(spec);

      // Single atomic patch: status + count + updatedAt (D12).
      const now = new Date().toISOString();
      await book.patch(planId, {
        status: 'completed',
        manifestFilesCount,
        updatedAt: now,
      });

      // Soft-warn emission. Skip when count is 0 (no signal to report)
      // or when the count is at-or-below the configured threshold (D9 —
      // strict greater-than is "exceeds"). Emission is best-effort: a
      // Clockworks failure must not fail the engine (D11), and the
      // PlanDoc patch above is final.
      if (manifestFilesCount > 0) {
        const threshold = resolvePredictedFilesThreshold();
        if (manifestFilesCount > threshold) {
          const clockworks = tryResolveClockworks();
          if (clockworks !== null) {
            try {
              await clockworks.emit(
                'astrolabe.plan.files-over-threshold',
                { planId, count: manifestFilesCount, threshold },
                FRAMEWORK_EMITTER,
              );
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              console.warn(
                `[astrolabe] best-effort emit of "astrolabe.plan.files-over-threshold" failed: ${reason}`,
              );
            }
          }
        }
      }

      return {
        status: 'completed',
        yields: { spec },
      };
    },
  };
}
