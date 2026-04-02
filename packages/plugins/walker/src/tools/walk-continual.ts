/**
 * walkContinual tool — runs the walk loop continuously.
 *
 * Polls walk() on a configurable interval until stopped or no remaining
 * work exists for the configured number of consecutive idle cycles.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { WalkerApi, WalkerConfig } from '../types.ts';

export default tool({
  name: 'walkContinual',
  description: 'Run the Walker loop continuously until idle',
  instructions:
    'Polls walk() in a loop, sleeping between steps when idle. ' +
    'Stops when the configured number of consecutive idle cycles is reached. ' +
    'Returns a summary of all actions taken.',
  params: {
    maxIdleCycles: z
      .number()
      .optional()
      .default(3)
      .describe(
        'Number of consecutive idle walk() calls before stopping (default: 3)',
      ),
    pollIntervalMs: z
      .number()
      .optional()
      .describe(
        'Override the configured poll interval in milliseconds',
      ),
  },
  permission: 'walker:write',
  handler: async (params) => {
    const g = guild();
    const walker = g.apparatus<WalkerApi>('walker');
    const config = g.guildConfig().walker ?? {} as WalkerConfig;
    const intervalMs = params.pollIntervalMs ?? config.pollIntervalMs ?? 5000;
    const maxIdle = params.maxIdleCycles;

    const actions: unknown[] = [];
    let idleCount = 0;

    while (idleCount < maxIdle) {
      const result = await walker.walk();
      if (result === null) {
        idleCount++;
        if (idleCount < maxIdle) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        }
      } else {
        idleCount = 0;
        actions.push(result);
      }
    }

    return { actions, totalActions: actions.length };
  },
});
