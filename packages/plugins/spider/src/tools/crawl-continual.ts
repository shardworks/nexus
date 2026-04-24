/**
 * crawl-continual tool — runs the crawl loop continuously.
 *
 * Polls crawl() on a configurable interval. By default the loop runs
 * indefinitely; pass a positive maxIdleCycles to enable auto-stop after
 * that many consecutive idle cycles.
 *
 * "Idle" here means *no actual progress was made*. A `null` return (Spider
 * had nothing to do) and a `{ action: 'gated' }` return (Spider found a
 * candidate but its outbound spider.follows targets are still non-terminal)
 * are both non-progress signals that produce the same output on every
 * subsequent tick until external state changes. Both count toward idleCount
 * and both cause the loop to sleep for intervalMs before the next call.
 *
 * Failing to treat `gated` as non-progress caused a tight-loop event-loop
 * starvation bug: an open writ perpetually gated on a stuck target would
 * cycle crawl() with zero sleep, burning 100% CPU and starving HTTP /
 * timer macrotasks (Oculus unreachable while daemon listened). See the
 * commit introducing this comment for the diagnosis.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, SpiderConfig, CrawlResult } from '../types.ts';

/**
 * Classify a CrawlResult as progress or non-progress.
 *
 * Non-progress = `null` (nothing to do) or `{ action: 'gated' }`
 * (found a writ but it's waiting on non-terminal blockers). Every other
 * action is a one-shot state transition that shouldn't recur identically
 * on the next tick, so it counts as progress and resets idleCount.
 */
function madeProgress(result: CrawlResult | null): result is CrawlResult {
  return result !== null && result.action !== 'gated';
}

export default tool({
  name: 'crawl-continual',
  description: "Run the Spider's crawl loop continuously",
  instructions:
    "Polls crawl() in a loop, sleeping between steps when there's no actual progress " +
    "(null or gated returns). By default the loop runs indefinitely. Pass a positive " +
    'maxIdleCycles to stop after that many consecutive non-progress cycles. ' +
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

      if (madeProgress(result)) {
        idleCount = 0;
        actions.push(result);
        // Belt-and-braces event-loop starvation guard: even when we have
        // genuine back-to-back work, yield one macrotask so HTTP handlers
        // and timers aren't starved by microtask-resolving DB calls.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } else {
        // null (idle) or 'gated' (stall). Either way, no forward progress
        // was made this cycle and the next call is very likely to produce
        // the identical outcome until external state changes — so sleep
        // for the full interval.
        idleCount++;
        // Record 'gated' results for operator visibility even though they
        // don't count as progress; null is just a silent idle.
        if (result !== null) actions.push(result);
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return { actions, totalActions: actions.length };
  },
});
