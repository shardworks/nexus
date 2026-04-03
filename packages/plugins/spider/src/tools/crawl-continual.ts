/**
 * crawlContinual tool — runs the crawl loop continuously.
 *
 * Polls crawl() on a configurable interval until stopped or no remaining
 * work exists for the configured number of consecutive idle cycles.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, SpiderConfig } from '../types.ts';

export default tool({
  name: 'crawlContinual',
  description: "Run the Spider's crawl loop continuously until idle",
  instructions:
    'Polls crawl() in a loop, sleeping between steps when idle. ' +
    'Stops when the configured number of consecutive idle cycles is reached. ' +
    'Returns a summary of all actions taken.',
  params: {
    maxIdleCycles: z
      .number()
      .optional()
      .default(3)
      .describe(
        'Number of consecutive idle crawl() calls before stopping (default: 3)',
      ),
    pollIntervalMs: z
      .number()
      .optional()
      .describe(
        'Override the configured poll interval in milliseconds',
      ),
  },
  permission: 'spider:write',
  handler: async (params) => {
    const g = guild();
    const spider = g.apparatus<SpiderApi>('spider');
    const config = g.guildConfig().spider ?? {} as SpiderConfig;
    const intervalMs = params.pollIntervalMs ?? config.pollIntervalMs ?? 5000;
    const maxIdle = params.maxIdleCycles;

    const actions: unknown[] = [];
    let idleCount = 0;

    while (idleCount < maxIdle) {
      let result: Awaited<ReturnType<typeof spider.crawl>>;
      try {
        result = await spider.crawl();
      } catch (err) {
        console.error('[crawlContinual] crawl() error:', err instanceof Error ? err.message : String(err));
        idleCount++;
        if (idleCount < maxIdle) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        }
        continue;
      }
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
