/**
 * Implement-loop engine — clockwork.
 *
 * Orchestrates sequential execution of step writs under a mandate.
 *
 * On run:
 *   1. Queries all open child step writs of the mandate.
 *   2. If steps exist, grafts step-session engines for each step
 *      (in mandate child order) with sequential upstream dependencies.
 *   3. If no steps exist, falls through to legacy single-session behavior
 *      identical to the original implement engine.
 *
 * The engine itself completes immediately with a graft (clockwork engine
 * returning { status: 'completed', yields, graft }). The grafted
 * step-session engines are then processed sequentially by the Spider.
 *
 * For the legacy fallback (no steps), it launches an anima session
 * directly, same as the original implement engine.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields, RigTemplateEngine, SpiderEngineRunResult } from '../types.ts';
import { EXECUTION_EPILOGUE } from './implement.ts';

const implementLoopEngine: EngineDesign = {
  id: 'implement-loop',

  async run(givens, context): Promise<EngineRunResult> {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const writ = givens.writ as WritDoc;
    const draft = context.upstream['draft'] as DraftYields;

    // Query all open child step writs of the mandate
    const steps = await clerk.list({
      parentId: writ.id,
      type: 'step',
      phase: 'open',
      limit: 100,
    });

    if (steps.length === 0) {
      // ── Legacy fallback: no steps → single-session implement ──
      const animator = guild().apparatus<AnimatorApi>('animator');
      const prompt = `${writ.body}\n${EXECUTION_EPILOGUE}`;

      const handle = animator.summon({
        role: givens.role as string,
        prompt,
        cwd: draft.path,
        environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
        metadata: { engineId: context.engineId, writId: writ.id },
      });

      return { status: 'launched', sessionId: handle.sessionId };
    }

    // ── Step-aware path: graft step-session engines ──
    // Sort steps by createdAt to maintain manifest order
    const sortedSteps = [...steps].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    // Build a chain of step-session engines with sequential dependencies.
    // Each step-session depends on the previous one (or on this engine for the first).
    const graft: RigTemplateEngine[] = [];
    let previousEngineId = context.engineId; // 'implement-loop' or whatever the instance id is

    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i]!;
      const engineId = `step-${i}`;

      graft.push({
        id: engineId,
        designId: 'step-session',
        upstream: [previousEngineId],
        givens: {
          writ: '${writ}',
          step: step, // Pass the step WritDoc directly as a literal value
          role: givens.role as string,
          cwd: `\${yields.draft.path}`,
        },
      });

      previousEngineId = engineId;
    }

    // Return as a SpiderEngineRunResult with graft.
    // graftTail tells Spider that any engine downstream of implement-loop
    // should also wait for the last grafted step-session to complete.
    const lastStepEngineId = `step-${sortedSteps.length - 1}`;
    const result: SpiderEngineRunResult = {
      status: 'completed',
      yields: {
        stepCount: sortedSteps.length,
        stepIds: sortedSteps.map(p => p.id),
      },
      graft,
      graftTail: lastStepEngineId,
    };

    return result as EngineRunResult;
  },
};

export default implementLoopEngine;
