/**
 * rig-show tool — retrieve a rig by id.
 *
 * The returned shape is `RigView` — the persisted RigDoc plus a derived
 * `costSummary` and per-engine `engineCosts` map (see ../rig-view.ts).
 * Callers that only need the persisted RigDoc fields can ignore the extras.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { SpiderApi, RigView } from '../types.ts';
import { enrichRigView } from '../rig-view.ts';

export default tool({
  name: 'rig-show',
  description: 'Retrieve a rig by id',
  instructions:
    'Returns the full RigDoc for the given rig id, enriched with a derived ' +
    'costSummary and per-engine engineCosts map. Throws if the rig does not exist. ' +
    'Blocked engines include a block record with type, condition, blockedAt, and lastCheckedAt timestamps.',
  params: {
    id: z.string().describe('The rig id to look up.'),
  },
  permission: 'read',
  handler: async (params): Promise<RigView> => {
    const g = guild();
    const spider = g.apparatus<SpiderApi>('spider');
    const rig = await spider.show(params.id);
    return enrichRigView(rig);
  },
});
