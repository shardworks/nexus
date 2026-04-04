/**
 * crawl-continual tool — runs the crawl loop continuously.
 *
 * Polls crawl() on a configurable interval. By default the loop runs
 * indefinitely; pass a positive maxIdleCycles to enable auto-stop after
 * that many consecutive idle cycles.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, SpiderConfig } from '../types.ts';

export default tool({
  name: 'crawl-continual',
  description: "Run the Spider's crawl loop continuously",
  instructions:
    'Polls crawl() in a loop, sleeping between steps when idle. ' +
    'By default the loop runs indefinitely. Pass a positive maxIdleCycles ' +
    'to stop after that many consecutive idle cycles. ' +
    'Returns a summary of all actions taken.',
  params: {
    maxIdleCycles: z
      .number()
      .optional()
      .default(0)
      .describe(
        'Max consecutive idle cycles before stopping. Pass a positive number to enable auto-stop (default: runs indefinitely)',
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

    while (maxIdle === 0 || idleCount < maxIdle) {
      let result: Awaited<ReturnType<typeof spider.crawl>>;
      try {
        result = await spider.crawl();
      } catch (err) {
        console.error('[crawl-continual] crawl() error:', err instanceof Error ? err.message : String(err));
        idleCount++;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      if (result === null) {
        idleCount++;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      } else {
        idleCount = 0;
        actions.push(result);
      }
    }

    return { actions, totalActions: actions.length };
  },
});
