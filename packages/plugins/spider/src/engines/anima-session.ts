/**
 * Anima-session engine — quick (Animator-backed).
 *
 * A generic reusable engine that summons an anima session. Unlike the other
 * quick engines which embed prompt logic, anima-session receives all parameters
 * through givens: role, prompt, cwd, and optionally conversationId and writ.
 *
 * Returns `{ status: 'launched', sessionId }` so the Spider's collect step
 * can poll for completion on subsequent walks. Uses the generic default
 * collect — no custom collect method.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

const animaSessionEngine: EngineDesign = {
  id: 'anima-session',

  // Retry budget — transient session crashes retry in-place. This is
  // the design used by the plan-and-ship template's `spec-writer` slot
  // (and any other rig template that summons a generic anima session).
  retry: { maxAttempts: 2 },

  async run(givens, context) {
    // Validate required givens
    if (typeof givens.role !== 'string' || givens.role.length === 0) {
      throw new Error('anima-session engine requires a non-empty string "role" given.');
    }
    if (typeof givens.prompt !== 'string' || givens.prompt.length === 0) {
      throw new Error('anima-session engine requires a non-empty string "prompt" given.');
    }
    if (typeof givens.cwd !== 'string' || givens.cwd.length === 0) {
      throw new Error('anima-session engine requires a non-empty string "cwd" given.');
    }

    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc | undefined;

    const handle = animator.summon({
      role: givens.role,
      prompt: givens.prompt,
      cwd: givens.cwd,
      ...(givens.conversationId ? { conversationId: givens.conversationId as string } : {}),
      environment: writ ? { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` } : {},
      metadata: { engineId: context.engineId, ...(writ ? { writId: writ.id } : {}) },
      // Enable streaming so the provider generates real-time chunks that the
      // Animator's broadcaster captures for subscribeToSession() consumers.
      streaming: true,
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },
};

export default animaSessionEngine;
