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
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { ScriptoriumApi } from '@shardworks/codexes-apparatus';
import type { DraftYields, SealYields } from '../types.ts';

const sealEngine: EngineDesign = {
  id: 'seal',

  async run(givens, context) {
    const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');
    const draftYields = context.upstream['draft'] as DraftYields | undefined;

    if (!draftYields) {
      throw new Error('Seal engine requires draft yields in context.upstream but none found.');
    }

    if (givens.abandon) {
      await scriptorium.abandonDraft({
        codexName: draftYields.codexName,
        branch: draftYields.branch,
        force: true,
      });

      return { status: 'completed', yields: { abandoned: true } };
    }

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
  },
};

export default sealEngine;
