/**
 * block-types tool — list all registered block types.
 *
 * Auto-mapped by Oculus to GET /api/block/types.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'block-types',
  description: 'List all registered block types with contributing plugin info',
  params: {},
  permission: 'read',
  handler: async () => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.listBlockTypes();
  },
});
