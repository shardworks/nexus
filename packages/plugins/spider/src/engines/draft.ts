/**
 * Draft engine — clockwork.
 *
 * Opens a draft binding via the Scriptorium. Returns DraftYields
 * containing the worktree path and branch name for downstream engines.
 */

import { execSync } from 'node:child_process';
import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { ScriptoriumApi } from '@shardworks/codexes-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields } from '../types.ts';

const draftEngine: EngineDesign = {
  id: 'draft',

  async run(givens, _context) {
    const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');
    const writ = givens.writ as WritDoc;

    if (!writ.codex) {
      throw new Error(
        `Writ "${writ.id}" has no codex — cannot open a draft binding.`,
      );
    }

    const draft = await scriptorium.openDraft({
      codexName: writ.codex,
      associatedWith: writ.id,
    });

    let baseSha: string;
    try {
      baseSha = execSync('git rev-parse HEAD', { cwd: draft.path, encoding: 'utf-8' }).trim();
    } catch (err) {
      throw new Error(
        `Failed to read HEAD commit in draft worktree "${draft.path}": ${(err as Error).message}`,
      );
    }

    const yields: DraftYields = {
      draftId: draft.id,
      codexName: draft.codexName,
      branch: draft.branch,
      path: draft.path,
      baseSha,
    };

    return { status: 'completed', yields };
  },
};

export default draftEngine;
