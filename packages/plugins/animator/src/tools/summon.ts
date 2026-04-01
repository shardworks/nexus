/**
 * summon tool — dispatch an anima session from the CLI.
 *
 * High-level entry point: composes context via The Loom (passing the
 * role for system prompt composition), then launches a session via
 * The Animator. The work prompt goes directly to the provider.
 *
 * Usage:
 *   nsg summon --prompt "Build the frobnicator" --role artificer
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { AnimatorApi } from '../types.ts';

export default tool({
  name: 'summon',
  description: 'Summon an anima — compose context and launch a session',
  instructions:
    'Dispatches an anima session. Provide a work prompt (what the anima should do) ' +
    'and optionally a role name (for system prompt composition). The Loom composes ' +
    'the identity context from the role; the prompt goes directly to the AI process. ' +
    'Returns the session result with id, status, cost, and token usage.',
  params: {
    prompt: z.string().describe('The work prompt — what the anima should do'),
    role: z.string().optional().describe('Role to summon (e.g. "artificer", "scribe")'),
  },
  callableFrom: 'cli',
  permission: 'animate',
  handler: async (params) => {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const cwd = guild().home;

    const { result } = animator.summon({
      prompt: params.prompt,
      role: params.role,
      cwd,
    });

    const session = await result;

    return {
      id: session.id,
      status: session.status,
      provider: session.provider,
      durationMs: session.durationMs,
      exitCode: session.exitCode,
      costUsd: session.costUsd,
      tokenUsage: session.tokenUsage,
      error: session.error,
    };
  },
});
