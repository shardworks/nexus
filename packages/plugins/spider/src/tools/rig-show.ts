/**
 * rig-show tool — retrieve a rig by id.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'rig-show',
  description: 'Retrieve a rig by id',
  instructions: 'Returns the full RigDoc for the given rig id. Throws if the rig does not exist.',
  params: {
    id: z.string().describe('The rig id to look up.'),
  },
  permission: 'read',
  handler: async (params) => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.show(params.id);
  },
});
