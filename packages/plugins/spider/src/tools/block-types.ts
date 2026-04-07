/**
 * block-types tool — list all registered block types with contributing plugin info.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi } from '../types.ts';

export default tool({
  name: 'block-types',
  description: 'List all registered block types with contributing plugin info',
  instructions:
    'Returns all block types registered with the Spider, including the plugin that ' +
    'contributed each type and its optional poll interval.',
  params: {},
  permission: 'read',
  handler: async () => {
    const spider = guild().apparatus<SpiderApi>('spider');
    return spider.listBlockTypes();
  },
});
