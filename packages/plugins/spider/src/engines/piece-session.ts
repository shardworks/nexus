/**
 * Piece-session engine — quick (Animator-backed).
 *
 * Launches an anima session for a single piece writ. The prompt combines
 * the mandate body with the piece body and piece-specific execution
 * instructions.
 *
 * Custom collect():
 *   - On session completion → transitions the piece writ to 'completed'.
 *   - After collecting, checks for dynamically added child pieces of the
 *     mandate and grafts new piece-session engines for them.
 *
 * Note on failure: Spider's tryCollect() calls failEngine() directly for
 * failed/timeout sessions and never invokes collect(). Piece writ failure
 * relies on Clerk's parent/child cascade when the mandate reaches a
 * terminal state (stuck → child pieces get cancelled).
 *
 * Givens:
 *   - writ: WritDoc (the mandate writ)
 *   - piece: WritDoc (the piece writ for this task)
 *   - role: string
 *   - cwd: string (draft worktree path)
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi, SessionDoc } from '@shardworks/animator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { SpiderCollectResult, RigTemplateEngine, RigDoc } from '../types.ts';

/**
 * Classify a caught transition error. Returns true if the error message
 * indicates the writ is already in a terminal state (cancelled, completed,
 * failed) — in which case the failed transition is expected (the cascade or
 * another path beat us to it) and should be swallowed silently.
 *
 * Matches the wording produced by Clerk's `transition()` guard. Both the
 * pre-T2 and post-T2 error shapes are recognised so this classifier keeps
 * working across the writ-type-config refactor:
 *   pre-T2:  `Cannot transition writ "…" to "completed": phase is "cancelled", …`
 *   post-T2: `Cannot transition writ "…" from "cancelled" to "completed": legal transitions from "cancelled" are none (terminal state).`
 * Also tolerates future phrasing like "already terminal".
 */
function isAlreadyTerminalTransitionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('already terminal')) return true;
  // Post-T2 strict-transition wording — `none (terminal state)` is emitted
  // exactly when the writ's current state is terminal and has no outbound
  // transitions, which is the race condition this guard is meant to swallow.
  if (message.includes('none (terminal state)')) return true;
  return (
    message.includes('phase is "cancelled"') ||
    message.includes('phase is "completed"') ||
    message.includes('phase is "failed"')
  );
}

/**
 * Execution instructions for piece sessions. Focuses the anima on a single
 * task — no manifest traversal, commit-per-piece guidance.
 */
export const PIECE_EXECUTION_EPILOGUE = `
You are working on a single task from a larger mandate. Focus exclusively on this task.

Instructions:
1. Complete the task described in the <task> element below the specification.
2. If the task has a <verify> command, run it after completing the work and confirm the <done> criterion is met.
3. The <files> element (if present) is the planner's predicted blast radius — useful for orientation, but verify scope independently.
4. If you discover additional work needed beyond this task, use the piece-add tool to create new tasks rather than doing them inline.
5. Commit all changes before ending your session.`;

const pieceSessionEngine: EngineDesign = {
  id: 'piece-session',

  async run(givens, context) {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const mandateWrit = givens.writ as WritDoc;
    const piece = givens.piece as WritDoc;

    if (!piece) {
      throw new Error('piece-session engine requires a "piece" given (WritDoc).');
    }

    // Assemble prompt: mandate body + piece body + piece-specific epilogue
    const prompt = `${mandateWrit.body}\n\n---\n\n## Current Task\n\nMandate ID: ${mandateWrit.id}\n\n${piece.body}\n${PIECE_EXECUTION_EPILOGUE}`;

    const handle = animator.summon({
      role: givens.role as string,
      prompt,
      cwd: givens.cwd as string,
      environment: { GIT_AUTHOR_EMAIL: `${mandateWrit.id}@nexus.local` },
      metadata: {
        engineId: context.engineId,
        writId: mandateWrit.id,
        pieceId: piece.id,
      },
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },

  // Note: collect() is only called for completed sessions. Spider's tryCollect()
  // calls failEngine() directly for failed/timeout sessions, bypassing collect().
  async collect(sessionId: string, givens: Record<string, unknown>, context: EngineRunContext): Promise<SpiderCollectResult | unknown> {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');

    const session = await sessionsBook.get(sessionId);
    const piece = givens.piece as WritDoc;
    const mandateWrit = givens.writ as WritDoc;

    if (!piece || !mandateWrit) {
      // Fallback: return generic yields if givens are missing
      return {
        sessionId,
        sessionStatus: session?.status ?? 'completed',
      };
    }

    // Completed session → mark piece completed.
    //
    // The transition may fail if the piece writ is already in a terminal
    // state (e.g. Clerk's downward cascade beat us to it after a sibling
    // failure). Classify the error: already-terminal is expected and silent;
    // anything else is a genuine bookkeeping failure that must be surfaced
    // via a warning so the race is visible in logs.
    try {
      await clerk.transition(piece.id, 'completed', {
        resolution: 'Task completed',
      });
    } catch (err) {
      if (!isAlreadyTerminalTransitionError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[piece-session] Unexpected error transitioning piece "${piece.id}" ` +
            `to completed: ${message}`,
        );
      }
      // Swallow — collect() must not throw. The current piece writ status
      // will be observed below and included in yields so downstream
      // consumers can see the actual outcome.
    }

    // Re-read the piece writ after the transition attempt so yields reflect
    // the observed, authoritative phase — whether the transition succeeded
    // or was caught as already-terminal.
    let observedPiecePhase: WritDoc['phase'] | undefined;
    try {
      const observedPiece = await clerk.show(piece.id);
      observedPiecePhase = observedPiece.phase;
    } catch {
      // Writ lookup failure should not propagate out of collect(). Leave
      // observedPiecePhase undefined so yields omit the field entirely.
    }

    // ── Dynamic piece pickup ──────────────────────────────────────────
    // Check for dynamically added child pieces that don't yet have engines.
    // Graft new piece-session engines for them so they run after this piece.
    const openChildren = await clerk.list({
      parentId: mandateWrit.id,
      type: 'piece',
      phase: 'open',
      limit: 50,
    });

    // Determine which piece IDs already have engines in the rig
    const rigsBook = stacks.readBook<RigDoc>('spider', 'rigs');
    const rig = await rigsBook.get(context.rigId);
    const existingPieceIds = new Set<string>();
    if (rig) {
      for (const engine of rig.engines) {
        // Piece engines have a literal piece object in givensSpec
        const enginePiece = engine.givensSpec?.piece as WritDoc | undefined;
        if (enginePiece?.id) {
          existingPieceIds.add(enginePiece.id);
        }
      }
    }

    // Filter to pieces that don't already have engines
    const newPieces = openChildren.filter(c => !existingPieceIds.has(c.id));

    // Build graft entries for new pieces with sequential dependencies
    const graft: RigTemplateEngine[] = [];
    let previousEngineId = context.engineId; // chain starts after this engine

    for (let i = 0; i < newPieces.length; i++) {
      const newPiece = newPieces[i]!;
      const engineId = `piece-${newPiece.id}`;

      graft.push({
        id: engineId,
        designId: 'piece-session',
        upstream: [previousEngineId],
        givens: {
          writ: '${writ}',
          piece: newPiece, // literal WritDoc — survives resolveGivens/resolveYieldRefs
          role: givens.role as string,
          cwd: `\${yields.draft.path}`,
        },
      });

      previousEngineId = engineId;
    }

    const yields = {
      sessionId,
      sessionStatus: session?.status ?? 'completed',
      pieceId: piece.id,
      ...(observedPiecePhase !== undefined ? { pieceStatus: observedPiecePhase } : {}),
      ...(session?.output !== undefined ? { output: session.output } : {}),
      ...(newPieces.length > 0 ? { dynamicPieceIds: newPieces.map(p => p.id) } : {}),
    };

    if (graft.length > 0) {
      // graftTail ensures engines downstream of this piece-session (e.g. the
      // next piece in the original chain, or seal via the original graftTail)
      // also wait for all dynamically added pieces to complete.
      const graftTail = `piece-${newPieces[newPieces.length - 1]!.id}`;
      return { yields, graft, graftTail } satisfies SpiderCollectResult;
    }

    return yields;
  },
};

export default pieceSessionEngine;
