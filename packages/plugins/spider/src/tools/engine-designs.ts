/**
 * engine-designs tool — list all registered engine designs with contributing plugin info.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';

export default tool({
  name: 'engine-designs',
  description: 'List all registered engine designs with contributing plugin info',
  instructions:
    'Returns all engine designs registered with the Fabricator, including the plugin that ' +
    'contributed each design and whether the design defines a custom collect() method.',
  params: {},
  permission: 'read',
  handler: async () => {
    const fabricator = guild().apparatus<FabricatorApi>('fabricator');
    return fabricator.listEngineDesigns();
  },
});
