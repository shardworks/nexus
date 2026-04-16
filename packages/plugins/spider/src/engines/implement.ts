/**
 * Implement engine — quick (Animator-backed).
 *
 * Summons an anima to do the commissioned work. Wraps the writ body with
 * task-manifest-aware execution instructions, then calls animator.summon()
 * with the draft worktree as the working directory. Returns
 * `{ status: 'launched', sessionId }` so the Spider's collect step can poll
 * for completion on subsequent walks.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields } from '../types.ts';

/**
 * Execution instructions appended to the writ body. When the body contains
 * a `<task-manifest>`, the anima works through tasks in order, running each
 * task's `<verify>` command as a checkpoint and committing after each task
 * or logical group. If no manifest is present, behaviour is unchanged.
 */
const EXECUTION_EPILOGUE = `
If the specification above contains a <task-manifest>, follow these execution rules:

1. Work through tasks in the order listed (t1, t2, t3, …).
2. After completing each task, run its <verify> command and confirm the <done> criterion is met before moving on.
3. Commit after each task (or after a logical group of tightly-coupled tasks).
4. The <files> element in each task is the planner's predicted blast radius — useful for orientation, but verify scope independently. Do not limit your changes to only the listed files.
5. If a task reveals additional work not covered by the manifest, do it inline before proceeding to the next task.

Commit all changes before ending your session.`;

const implementEngine: EngineDesign = {
  id: 'implement',

  async run(givens, context) {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc;
    const draft = context.upstream['draft'] as DraftYields;

    const prompt = `${writ.body}\n${EXECUTION_EPILOGUE}`;

    const handle = animator.summon({
      role: givens.role as string,
      prompt,
      cwd: draft.path,
      environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
      metadata: { engineId: context.engineId, writId: writ.id },
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },
};

export { EXECUTION_EPILOGUE };
export default implementEngine;
