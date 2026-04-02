/**
 * walk tool — executes a single step of the walk loop.
 *
 * Returns the WalkResult or null (idle) from one walk() call.
 * Useful for manual step-through or testing.
 */

import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { WalkerApi } from '../types.ts';

export default tool({
  name: 'walk',
  description: 'Execute one step of the Walker loop',
  instructions:
    'Runs a single walk() step: collect a pending session result, run the next ' +
    'ready engine, or spawn a rig for a ready writ — in that priority order. ' +
    'Returns the action taken, or null if there is nothing to do.',
  params: {},
  permission: 'walker:write',
  handler: async () => {
    const walker = guild().apparatus<WalkerApi>('walker');
    return walker.walk();
  },
});
