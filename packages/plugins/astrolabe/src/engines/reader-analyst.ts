/**
 * reader-analyst quick engine (astrolabe-owned).
 *
 * Wraps the generic `anima-session` behaviour but selects the primer role at
 * engine-run time based on live guild config. When `astrolabe.patronRole` is
 * set to a non-empty string (a patron-anima is configured downstream), the
 * engine summons `astrolabe.sage-primer-attended` — the primer pre-fills
 * `selected` on every decision and every decision flows into the patron-
 * anima for principle-check. When `astrolabe.patronRole` is unset, empty,
 * or whitespace-only (no patron-anima downstream), the engine summons
 * `astrolabe.sage-primer-solo` — which carries the razor itself and only
 * leaves `selected` unset for decisions that genuinely warrant patron
 * attention.
 *
 * Run-time selection (per writ, not per guild startup) matters because the
 * patron may reconfigure `astrolabe.patronRole` mid-experiment; the next
 * brief should behave according to the live config, not the config at the
 * time the plugin loaded.
 *
 * The `selected === undefined` reviewable partition is preserved
 * conceptually: the attended variant pre-fills every decision, so the
 * partition is empty by construction and patron-anima no-ops for nothing-
 * to-review; the solo variant leaves razor-matched decisions unset, which
 * is the normal path for guilds without a patron-anima.
 *
 * Design contract mirrors `anima-session`:
 *   givens    : prompt (required), cwd (required), writ (optional), metadata
 *               (optional). `role` is NOT accepted — the engine chooses it.
 *   returns   : `{ status: 'launched', sessionId }` — identical shape to
 *               anima-session so the Spider collect step behaves identically.
 *   default collect: no custom collect method — the Spider's generic quick-
 *               engine collector handles the session lifecycle.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import { resolvePatronRole } from '../astrolabe.ts';

/** Role chosen when a patron-anima is configured downstream. */
export const PRIMER_ATTENDED_ROLE = 'astrolabe.sage-primer-attended';
/** Role chosen when no patron-anima is configured — primer carries the razor. */
export const PRIMER_SOLO_ROLE = 'astrolabe.sage-primer-solo';

/**
 * Choose the primer variant for the current run. Exported so tests can pin
 * the selection contract directly (D4): non-empty → attended; empty,
 * whitespace-only, or unset → solo.
 */
export function selectPrimerRole(): string {
  return resolvePatronRole() === '' ? PRIMER_SOLO_ROLE : PRIMER_ATTENDED_ROLE;
}

export function createReaderAnalystEngine(): EngineDesign {
  return {
    id: 'astrolabe.reader-analyst',

    async run(givens, context) {
      if (typeof givens.prompt !== 'string' || givens.prompt.length === 0) {
        throw new Error(
          'astrolabe.reader-analyst engine requires a non-empty string "prompt" given.',
        );
      }
      if (typeof givens.cwd !== 'string' || givens.cwd.length === 0) {
        throw new Error(
          'astrolabe.reader-analyst engine requires a non-empty string "cwd" given.',
        );
      }

      const role = selectPrimerRole();
      const animator = guild().apparatus<AnimatorApi>('animator');
      const writ = givens.writ as WritDoc | undefined;

      const handle = animator.summon({
        role,
        prompt: givens.prompt,
        cwd: givens.cwd,
        ...(givens.conversationId ? { conversationId: givens.conversationId as string } : {}),
        environment: writ ? { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` } : {},
        metadata: { engineId: context.engineId, ...(writ ? { writId: writ.id } : {}) },
        // Mirror anima-session: enable streaming so real-time chunks reach
        // the Animator's broadcaster for subscribeToSession() consumers.
        streaming: true,
      });

      return { status: 'launched', sessionId: handle.sessionId };
    },
  };
}
