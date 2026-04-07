/**
 * Spider — custom Oculus API routes.
 *
 * Contributes GET /api/spider/config, which returns an aggregated snapshot
 * of the Spider's registered configuration: rig templates, engine designs,
 * and block types.
 *
 * Does NOT import from @shardworks/oculus-apparatus to avoid a circular
 * package dependency. The route shape is compatible with RouteContribution
 * from the Oculus types.
 */

import type { Context } from 'hono';
import { guild } from '@shardworks/nexus-core';
import type { FabricatorApi } from '@shardworks/fabricator-apparatus';
import type { SpiderApi, SpiderConfig } from './types.ts';

export const spiderRoutes = [
  {
    method: 'GET',
    path: '/api/spider/config',
    handler: (c: Context) => {
      const g = guild();
      const spiderConfig: SpiderConfig = g.guildConfig().spider ?? {};
      const fabricator = g.apparatus<FabricatorApi>('fabricator');
      const spider = g.apparatus<SpiderApi>('spider');

      return c.json({
        rigTemplates: spiderConfig.rigTemplates ?? {},
        engineDesigns: fabricator.listEngineDesigns(),
        blockTypes: spider.listBlockTypes(),
      });
    },
  },
];
