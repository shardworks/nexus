/**
 * Piece-session engine — quick (Animator-backed).
 *
 * Launches an anima session for a single piece writ. The prompt combines
 * the mandate body with the piece body and piece-specific execution
 * instructions.
 *
 * Custom collect():
 *   - On session completion → transitions the piece writ to 'completed'.
 *   - On session failure → transitions the piece writ to 'failed'.
 *   - After collecting, checks for dynamically added child pieces of the
 *     mandate and returns them as a graft for the implement-loop to process.
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
import type { SpiderCollectResult, RigTemplateEngine } from '../types.ts';

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

    // Transition piece writ based on session outcome
    if (session?.status === 'failed' || session?.status === 'timeout') {
      try {
        await clerk.transition(piece.id, 'failed', {
          resolution: session.error ?? `Session ${session.status}`,
        });
      } catch {
        // Piece may already be in a terminal state — ignore
      }
      return {
        sessionId,
        sessionStatus: session.status,
        pieceId: piece.id,
        pieceFailed: true,
      };
    }

    // Completed session → mark piece completed
    try {
      await clerk.transition(piece.id, 'completed', {
        resolution: 'Task completed',
      });
    } catch {
      // Piece may already be in a terminal state — ignore
    }

    // Check for dynamically added child pieces since this rig started
    const allChildren = await clerk.list({
      parentId: mandateWrit.id,
      type: 'piece',
      status: 'open',
      limit: 50,
    });

    // Build graft entries for any open pieces that don't already have engines
    // The implement-loop's collect will check which pieces already have engines
    // We pass back the list of new piece IDs for the implement-loop to handle
    const graft: RigTemplateEngine[] = [];
    // We don't graft individual piece engines here — the implement-loop
    // handles dynamic piece incorporation. Instead, we signal via yields.
    const newPieceIds = allChildren.map(c => c.id);

    const yields = {
      sessionId,
      sessionStatus: session?.status ?? 'completed',
      pieceId: piece.id,
      ...(session?.output !== undefined ? { output: session.output } : {}),
      ...(newPieceIds.length > 0 ? { openPieceIds: newPieceIds } : {}),
    };

    if (graft.length > 0) {
      return { yields, graft };
    }

    return yields;
  },
};

export default pieceSessionEngine;
