/**
 * rig-for-writ tool — find the rig for a given writ.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'rig-for-writ',
  description: 'Find the rig for a given writ',
  instructions:
    'Returns the RigDoc for the given writ id, or null if no rig has been spawned yet.',
  params: {
    writId: z.string().describe('The writ id to look up.'),
  },
  permission: 'read',
  handler: async (params) => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.forWrit(params.writId);
  },
});
