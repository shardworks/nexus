/**
 * Implement-loop engine — clockwork.
 *
 * Orchestrates sequential execution of piece writs under a mandate.
 *
 * On run:
 *   1. Queries all open child piece writs of the mandate.
 *   2. If pieces exist, grafts piece-session engines for each piece
 *      (in mandate child order) with sequential upstream dependencies.
 *   3. If no pieces exist, falls through to legacy single-session behavior
 *      identical to the original implement engine.
 *
 * The engine itself completes immediately with a graft (clockwork engine
 * returning { status: 'completed', yields, graft }). The grafted
 * piece-session engines are then processed sequentially by the Spider.
 *
 * For the legacy fallback (no pieces), it launches an anima session
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

    // Query all open child piece writs of the mandate
    const pieces = await clerk.list({
      parentId: writ.id,
      type: 'piece',
      status: 'open',
      limit: 100,
    });

    if (pieces.length === 0) {
      // ── Legacy fallback: no pieces → single-session implement ──
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

    // ── Piece-aware path: graft piece-session engines ──
    // Sort pieces by createdAt to maintain manifest order
    const sortedPieces = [...pieces].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    // Build a chain of piece-session engines with sequential dependencies.
    // Each piece-session depends on the previous one (or on this engine for the first).
    const graft: RigTemplateEngine[] = [];
    let previousEngineId = context.engineId; // 'implement-loop' or whatever the instance id is

    for (let i = 0; i < sortedPieces.length; i++) {
      const piece = sortedPieces[i]!;
      const engineId = `piece-${i}`;

      graft.push({
        id: engineId,
        designId: 'piece-session',
        upstream: [previousEngineId],
        givens: {
          writ: '${writ}',
          piece: piece, // Pass the piece WritDoc directly as a literal value
          role: givens.role as string,
          cwd: `\${yields.draft.path}`,
        },
      });

      previousEngineId = engineId;
    }

    // Return as a SpiderEngineRunResult with graft.
    // graftTail tells Spider that any engine downstream of implement-loop
    // should also wait for the last grafted piece-session to complete.
    const lastPieceEngineId = `piece-${sortedPieces.length - 1}`;
    const result: SpiderEngineRunResult = {
      status: 'completed',
      yields: {
        pieceCount: sortedPieces.length,
        pieceIds: sortedPieces.map(p => p.id),
      },
      graft,
      graftTail: lastPieceEngineId,
    };

    return result as EngineRunResult;
  },
};

export default implementLoopEngine;
