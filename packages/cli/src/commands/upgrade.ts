/**
 * nsg upgrade — upgrade the guild framework and run pending migrations.
 *
 * A framework command:
 * 1. Run framework migrations (core schema, event tables, etc.)
 * 2. Walk each installed plugin and run its pending migrations
 * 3. Reconcile guild.json if the schema has changed
 *
 * With third-party plugins, this may need to be more controlled than
 * "upgrade everything to latest" — version pinning, dry-run, etc.
 *
 * Stub — not yet implemented.
 */

import { tool } from '@shardworks/tools-apparatus';
import { z } from 'zod';

export default tool({
  name: 'upgrade',
  description: 'Upgrade the guild framework and run pending plugin migrations',
  callableFrom: ['cli'],
  params: {
    dryRun: z.boolean().optional().describe('Show what would be done without applying changes'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});
