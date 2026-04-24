/**
 * crawl-continual tool — runs the crawl loop continuously.
 *
 * Polls crawl() on a configurable interval. By default the loop runs
 * indefinitely; pass a positive maxIdleCycles to enable auto-stop after
 * that many consecutive idle cycles.
 *
 * An "idle" tick is simply a `null` return from crawl() — Spider had
 * nothing dispatchable to do this pass (either the queue is empty, or
 * every candidate open writ was gated on non-terminal blockers). Any
 * non-null CrawlResult counts as progress, resets idleCount, and the
 * loop yields a macrotask before the next tick.
 *
 * Event-loop starvation guard: even on back-to-back progress ticks,
 * `await` chains resolve via microtasks only. A setImmediate yield
 * between progress ticks lets HTTP handlers and timers run.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, SpiderConfig, CrawlResult } from '../types.ts';

export default tool({
  name: 'crawl-continual',
  description: "Run the Spider's crawl loop continuously",
  instructions:
    "Polls crawl() in a loop, sleeping pollIntervalMs between idle ticks (null returns). " +
    'By default runs indefinitely. Pass a positive maxIdleCycles to stop after that many ' +
    'consecutive idle cycles. Returns a summary of all actions taken.',
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
  permission: 'write',
  handler: async (params) => {
    const g = guild();
    const spider = g.apparatus<SpiderApi>('spider');
    const config = g.guildConfig().spider ?? {} as SpiderConfig;
    const intervalMs = params.pollIntervalMs ?? config.pollIntervalMs ?? 5000;
    const maxIdle = params.maxIdleCycles;

    const actions: CrawlResult[] = [];
    let idleCount = 0;

    while (maxIdle === 0 || idleCount < maxIdle) {
      let result: CrawlResult | null;
      try {
        result = await spider.crawl();
      } catch (err) {
        console.error('[crawl-continual] crawl() error:', err instanceof Error ? err.message : String(err));
        idleCount++;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (result !== null) {
        idleCount = 0;
        actions.push(result);
        // Belt-and-braces event-loop starvation guard: even when we have
        // genuine back-to-back work, yield one macrotask so HTTP handlers
        // and timers aren't starved by microtask-resolving DB calls.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        // Idle — no dispatchable candidate found this tick. Sleep the
        // full interval before asking again.
        idleCount++;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return { actions, totalActions: actions.length };
  },
});
