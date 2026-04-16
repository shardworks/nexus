/**
 * Seal engine — clockwork.
 *
 * Closes a draft binding via the Scriptorium. Reads the draft branch
 * from context.upstream['draft'] (the DraftYields from the draft engine).
 *
 * By default, seals the draft (merges inscriptions into the sealed binding)
 * and returns SealYields with the sealed commit info. When the `abandon`
 * given is truthy, abandons the draft instead — removing the worktree and
 * branch without merging. This is used by rigs that need codebase access
 * (e.g. planning rigs) but don't produce inscriptions to seal.
 *
 * Recovery tail.
 *   When Scriptorium's `seal()` throws a rebase-conflict failure (message
 *   prefixed with `Sealing seized:`), this engine catches the throw and
 *   grafts a two-engine recovery tail: a `manual-merge` quick engine that
 *   summons the `spider.mender` anima to reconcile conflicts in the draft
 *   worktree, followed by a retry `seal` engine with `recover: false` that
 *   attempts the push a second time. The engine itself completes with
 *   { ok: false, reason, grafted: true } so the rig stays alive while the
 *   graft processes.
 *
 *   Recovery is disabled on three paths:
 *   - `abandon: true` — abandon failures always re-throw unchanged.
 *   - `recover: false` — used by the grafted retry seal itself to avoid a
 *     second recovery layer (one attempt only).
 *   - Any failure whose message does NOT start with `Sealing seized:`
 *     (auth, network, missing branch, abandon errors, etc.). These re-throw
 *     unchanged so the rig goes stuck via the standard failEngine path.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { ScriptoriumApi } from '@shardworks/codexes-apparatus';
import type {
  DraftYields,
  RigTemplateEngine,
  SealRecoveryYields,
  SealYields,
  SpiderEngineRunResult,
} from '../types.ts';

/**
 * Message prefix Scriptorium uses for rebase-conflict seal failures.
 * Tested against scriptorium-core.ts's single throw site
 * (`Sealing seized: rebase of "..." onto "..." produced conflicts.`).
 */
const REBASE_CONFLICT_PREFIX = 'Sealing seized:';

function isRebaseConflictFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(REBASE_CONFLICT_PREFIX);
}

const sealEngine: EngineDesign = {
  id: 'seal',

  async run(givens, context): Promise<EngineRunResult> {
    const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');
    const draftYields = context.upstream['draft'] as DraftYields | undefined;

    if (!draftYields) {
      throw new Error('Seal engine requires draft yields in context.upstream but none found.');
    }

    if (givens.abandon) {
      // Abandon-path failures throw as today — recovery is inapplicable
      // (abandon cannot produce merge conflicts).
      await scriptorium.abandonDraft({
        codexName: draftYields.codexName,
        branch: draftYields.branch,
        force: true,
      });

      return { status: 'completed', yields: { abandoned: true } };
    }

    const recoverEnabled = givens.recover !== false;

    try {
      const result = await scriptorium.seal({
        codexName: draftYields.codexName,
        sourceBranch: draftYields.branch,
      });

      const yields: SealYields = {
        sealedCommit: result.sealedCommit,
        strategy: result.strategy,
        retries: result.retries,
        inscriptionsSealed: result.inscriptionsSealed,
      };

      return { status: 'completed', yields };
    } catch (err) {
      // Only rebase-conflict failures trigger recovery. All other failures
      // (auth, network, missing branch, etc.) re-throw unchanged.
      if (!recoverEnabled || !isRebaseConflictFailure(err)) {
        throw err;
      }

      const originatingEngineId = context.engineId;
      const manualMergeEngineId = `${originatingEngineId}-manual-merge`;
      const retrySealEngineId = `${originatingEngineId}-retry`;
      const reason = err instanceof Error ? err.message : String(err);

      const graft: RigTemplateEngine[] = [
        {
          id: manualMergeEngineId,
          designId: 'manual-merge',
          upstream: [originatingEngineId],
          givens: {
            writ: '${writ}',
            role: 'spider.mender',
            cwd: '${yields.draft.path}',
          },
        },
        {
          id: retrySealEngineId,
          designId: 'seal',
          upstream: [manualMergeEngineId],
          // recover: false prevents a second recovery layer — if the retry
          // seal also seizes, the rig goes stuck as before.
          givens: { recover: false },
        },
      ];

      const yields: SealRecoveryYields = {
        ok: false,
        reason,
        grafted: true,
      };

      const result: SpiderEngineRunResult = {
        status: 'completed',
        yields,
        graft,
        // graftTail ensures any engine downstream of the original seal waits
        // for the retry seal to finish before running. None of the current
        // templates have engines downstream of seal, but this keeps the
        // contract correct for future templates.
        graftTail: retrySealEngineId,
      };

      return result as EngineRunResult;
    }
  },
};

export default sealEngine;
