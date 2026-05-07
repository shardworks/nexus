/**
 * scaffold-surveyor.summon — custom anima-session engine.
 *
 * Mirrors the `anima-session` engine from Spider with one relaxation:
 * when `givens.cwd` is absent or empty, the engine falls back to
 * `guild().home` instead of throwing. This removes the operator
 * boilerplate of configuring a `cwd` for every survey rig — surveyor
 * rigs typically do not need a specific worktree.
 *
 * Design contract:
 *   givens  : role (required), prompt (required), cwd (optional — falls
 *             back to guild().home), writ (optional)
 *   returns : `{ status: 'launched', sessionId }` — same shape as
 *             anima-session so Spider's generic collect step handles
 *             the session lifecycle
 *   streaming: true — mirrors anima-session
 *   retry   : maxAttempts: 2 — mirrors astrolabe.reader-analyst
 *
 * See: Decision D2/D3 in the commission spec.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';

/** Engine id — used in every rig template's resolutionEngine field. */
export const SUMMON_ENGINE_ID = 'scaffold-surveyor.summon';

export const summonEngine: EngineDesign = {
  id: SUMMON_ENGINE_ID,

  // Retry budget — transient session crashes retry in-place.
  // Terminal exhaustion fails the survey writ directly.
  retry: { maxAttempts: 2 },

  async run(givens, context) {
    if (typeof givens.role !== 'string' || givens.role.length === 0) {
      throw new Error(
        'scaffold-surveyor.summon engine requires a non-empty string "role" given.',
      );
    }
    if (typeof givens.prompt !== 'string' || givens.prompt.length === 0) {
      throw new Error(
        'scaffold-surveyor.summon engine requires a non-empty string "prompt" given.',
      );
    }

    // D3: fall back to guild().home when cwd is absent.
    const cwd =
      typeof givens.cwd === 'string' && givens.cwd.length > 0
        ? givens.cwd
        : guild().home;

    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error(
        'scaffold-surveyor.summon engine: no "cwd" given and guild().home is empty. ' +
        'Provide a non-empty "cwd" given or ensure the guild has a home directory.',
      );
    }

    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc | undefined;

    // D17: streaming: true — mirrors existing summon-wrapping engines.
    const handle = animator.summon({
      role: givens.role,
      prompt: givens.prompt,
      cwd,
      environment: writ ? { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` } : {},
      metadata: {
        engineId: context.engineId,
        ...(writ ? { writId: writ.id } : {}),
      },
      streaming: true,
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },
};
