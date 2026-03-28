/**
 * nsg upgrade — upgrade the guild framework and run pending migrations.
 *
 * Mainspring built-in. In the rig world, this means:
 * 1. Run mainspring's own framework migrations (core schema, event tables, etc.)
 * 2. Walk each installed rig and run its pending migrations
 * 3. Reconcile guild.json if the schema has changed
 *
 * With third-party rigs, this may need to be more controlled than
 * "upgrade everything to latest" — version pinning, dry-run, etc.
 *
 * Stub for now — fleshed out in commission-rig-install.
 */

import { tool } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'upgrade',
  description: 'Upgrade the guild framework and run pending plugin migrations',
  callableFrom: ['cli'],
  params: {
    dryRun: z.boolean().optional().describe('Show what would be done without applying changes'),
  },
  handler: async () => {
    return 'Not yet implemented — see commission-rig-install.';
  },
});
