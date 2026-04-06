/**
 * rig-resume tool — manually clear a block on a specific engine.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'rig-resume',
  description: 'Manually clear a block on a specific engine, regardless of checker result',
  instructions:
    'Clears the block on the specified engine and transitions it back to pending. ' +
    'The engine will be picked up on the next crawl cycle. ' +
    'Throws if the engine is not in blocked status.',
  params: {
    rigId: z.string().describe('The rig id.'),
    engineId: z.string().describe('The engine id within the rig.'),
  },
  permission: 'spider:write',
  handler: async (params) => {
    const spider = guild().apparatus<SpiderApi>('spider');
    await spider.resume(params.rigId, params.engineId);
    return { ok: true };
  },
});
