/**
 * Manual-merge engine — quick (Animator-backed).
 *
 * Summons the `spider.mender` anima inside the draft worktree to reconcile
 * rebase conflicts that caused Scriptorium's seal() to seize. The anima's
 * job is to rebase the draft branch onto the target, resolve conflicts by
 * hand, and leave the branch ready for a fast-forward push. A grafted
 * retry `seal` engine runs immediately after and handles the push itself
 * — push is explicitly denied to the mender role.
 *
 * Output contract: the anima must end its final message with exactly one
 * marker line — either `### Merge: SUCCESS` or `### Merge: FAILURE`. The
 * `collect()` method parses the marker with a distinct prefix that does
 * not collide with the review engine's `### Overall: PASS|FAIL` pattern.
 *
 * On success: returns { sessionId, merged: true } so the retry seal can run.
 * On failure (marker missing, FAILURE emitted, or session otherwise
 * non-productive): throws in collect(). The Spider catches the throw in
 * tryCollect and transitions the engine to `failed`, which takes the rig
 * to `stuck` — no second recovery attempt.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi, SessionDoc } from '@shardworks/animator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields, ManualMergeYields } from '../types.ts';

const execFileAsync = promisify(execFile);

async function gitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-b'], { cwd });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Pull the recovery reason out of an upstream seal engine's yields.
 * The seal engine that grafted this manual-merge is the immediate upstream,
 * but we tolerate custom engine ids by duck-typing on the SealRecoveryYields
 * shape instead of hardcoding the id.
 */
function extractSealReason(upstream: Record<string, unknown>): string {
  for (const [id, value] of Object.entries(upstream)) {
    if (id === 'draft') continue;
    if (typeof value !== 'object' || value === null) continue;
    const y = value as Record<string, unknown>;
    if (y.grafted === true && typeof y.reason === 'string') {
      return y.reason;
    }
  }
  return '(no recovery reason reported)';
}

function assembleMergePrompt(
  writ: WritDoc,
  draft: DraftYields,
  status: string,
  reason: string,
): string {
  return `# Manual Merge Recovery

An automatic seal attempt on this draft failed due to a rebase conflict
against the target branch. Your job is to reconcile the draft's inscriptions
against the latest target and leave the draft branch in a state where a
plain fast-forward push will succeed. A retry seal engine will run right
after you finish and it will do the push — you must NOT push yourself.

## The Commission (Spec)

${writ.body}

## Seal Failure

${reason}

## Draft Context

- Codex: \`${draft.codexName}\`
- Draft branch: \`${draft.branch}\`
- Worktree: \`${draft.path}\`

## Current Worktree Status

\`\`\`
${status}
\`\`\`

## Instructions

1. You are running inside the draft worktree already. Defend against
   inconsistent state: if \`git status\` reports an in-progress rebase,
   run \`git rebase --abort\` before starting any reconciliation.
2. Fetch the target branch from \`origin\` and rebase the draft branch
   onto it. Resolve each conflict by hand — inspect the conflicting code
   and the commission above, and only commit a resolution you can
   justify. Do NOT fabricate a merge you cannot defend.
3. After reconciliation, finish the rebase so the draft branch has a
   clean linear history on top of the fetched target. Do NOT run
   \`git push\` under any circumstance — the retry seal engine handles
   the push.
4. Your FINAL message must end with exactly one marker line on its own:

   - \`### Merge: SUCCESS\` — reconciliation complete; the draft branch
     is ready for a fast-forward seal.
   - \`### Merge: FAILURE\` — you could not reconcile safely; explain
     why in the lines above the marker.

   Do not emit any other text after the marker line.`;
}

const manualMergeEngine: EngineDesign = {
  id: 'manual-merge',

  async run(givens, context) {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc;
    const draft = context.upstream['draft'] as DraftYields | undefined;

    if (!writ) {
      throw new Error('manual-merge engine requires the "writ" given but none was supplied.');
    }
    if (!draft) {
      throw new Error('manual-merge engine requires draft yields in context.upstream but none found.');
    }

    const cwd =
      typeof givens.cwd === 'string' && givens.cwd.length > 0 ? givens.cwd : draft.path;
    const role =
      typeof givens.role === 'string' && givens.role.length > 0 ? givens.role : 'spider.mender';

    const reason = extractSealReason(context.upstream);
    const status = await gitStatus(cwd);
    const prompt = assembleMergePrompt(writ, draft, status, reason);

    const handle = animator.summon({
      role,
      prompt,
      cwd,
      environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
      metadata: { engineId: context.engineId, writId: writ.id },
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },

  async collect(sessionId: string): Promise<ManualMergeYields> {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
    const session = await sessionsBook.get(sessionId);
    const output = session?.output ?? '';

    if (/^###\s*Merge:\s*SUCCESS\b/mi.test(output)) {
      return { sessionId, merged: true };
    }

    if (/^###\s*Merge:\s*FAILURE\b/mi.test(output)) {
      throw new Error(
        'Manual merge failed: mender anima emitted `### Merge: FAILURE` marker.',
      );
    }

    throw new Error(
      'Manual merge failed: mender anima did not emit a `### Merge: SUCCESS` or `### Merge: FAILURE` marker.',
    );
  },
};

export default manualMergeEngine;
