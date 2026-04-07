/**
 * nsg upgrade — upgrade the guild framework.
 *
 * Stub — upgrade lifecycle not yet designed. Will handle framework version
 * bumps, guild.json schema reconciliation, and plugin-specific upgrade
 * hooks when implemented.
 */

import { tool } from '@shardworks/tools-apparatus';
import { z } from 'zod';

export default tool({
  name: 'upgrade',
  description: 'Upgrade the guild framework and run pending plugin migrations',
  callableBy: ['patron'],
  params: {
    dryRun: z.boolean().optional().describe('Show what would be done without applying changes'),
  },
  handler: async () => {
    return 'Not yet implemented.';
  },
});
