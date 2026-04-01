/**
 * nexus-version tool.
 *
 * Reports the guild's Nexus framework version and installed plugins.
 * Reads from guild.json to reflect what's actually configured.
 */
import { tool, VERSION, readGuildConfig, guild } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'nexus-version',
  description: "Report version information for the guild's Nexus installation and installed plugins",
  instructionsFile: './instructions/nexus-version.md',
  params: {
    verbose: z.boolean().optional().describe('Include full guild settings'),
  },
  handler: (params) => {
    const { home } = guild();
    const config = readGuildConfig(home);

    if (params.verbose) {
      return {
        nexus:    VERSION,
        model:    config.settings?.model,
        plugins:  config.plugins,
        roles:    Object.keys(config.roles),
        settings: config.settings,
      };
    }

    return {
      nexus:   VERSION,
      model:   config.settings?.model,
      plugins: config.plugins,
    };
  },
});
