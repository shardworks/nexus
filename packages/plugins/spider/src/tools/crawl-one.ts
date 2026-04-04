/**
 * crawl-one tool — executes a single step of the crawl loop.
 *
 * Returns the CrawlResult or null (idle) from one crawl() call.
 * Useful for manual step-through or testing.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'crawl-one',
  description: "Execute one step of the Spider's crawl loop",
  instructions:
    'Runs a single crawl() step: collect a pending session result, run the next ' +
    'ready engine, or spawn a rig for a ready writ — in that priority order. ' +
    'Returns the action taken, or null if there is nothing to do.',
  params: {},
  permission: 'spider:write',
  handler: async () => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.crawl();
  },
});
