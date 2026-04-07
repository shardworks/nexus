/**
 * engine-designs tool — list all registered engine designs.
 *
 * Auto-mapped by Oculus to GET /api/engine/designs.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';

export default tool({
  name: 'engine-designs',
  description: 'List all registered engine designs with contributing plugin info',
  params: {},
  permission: 'read',
  handler: async () => {
    const fabricator = guild().apparatus<FabricatorApi>('fabricator');
    return fabricator.listEngineDesigns();
  },
});
