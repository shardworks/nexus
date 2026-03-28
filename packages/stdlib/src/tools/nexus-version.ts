/**
 * nexus-version tool.
 *
 * Reports the guild's Nexus framework version and installed rigs.
 * Reads from guild.json (V2 format) to reflect what's actually configured.
 */
import { tool, VERSION, readGuildConfigV2 } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'nexus-version',
  description: "Report version information for the guild's Nexus installation and installed rigs",
  instructionsFile: './instructions/nexus-version.md',
  params: {
    verbose: z.boolean().optional().describe('Include full guild settings'),
  },
  handler: (params, { home }) => {
    const config = readGuildConfigV2(home);

    if (params.verbose) {
      return {
        nexus: VERSION,
        model: config.settings?.model,
        rigs: config.rigs,
        roles: Object.keys(config.roles),
        settings: config.settings,
      };
    }

    return {
      nexus: VERSION,
      model: config.settings?.model,
      rigs: config.rigs,
    };
  },
});
