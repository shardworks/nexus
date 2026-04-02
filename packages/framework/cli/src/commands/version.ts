/**
 * nsg version — show framework and plugin version info.
 *
 * A framework command — hardcoded in the CLI, not discovered via plugins.
 *
 * Always shows framework and Node versions. When run inside a guild,
 * additionally shows installed plugin versions. Gracefully degrades
 * when run outside a guild (no error, just less info).
 */

import { tool } from '@shardworks/tools-apparatus';
import { VERSION, readGuildConfig, guild, readGuildPackageJson, resolvePackageNameForPluginId } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'version',
  description: 'Show Nexus framework and installed plugin version information',
  callableBy: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (params) => {
    const result: Record<string, string> = {
      nexus: VERSION,
      node: process.version,
    };

    // Add plugin versions when running inside a guild.
    // guild() throws if not initialized — that's fine, we just skip plugin info.
    try {
      const { home } = guild();
      const config = readGuildConfig(home);
      for (const pluginId of config.plugins) {
        const packageName = resolvePackageNameForPluginId(home, pluginId);
        if (!packageName) {
          result[pluginId] = 'not installed';
          continue;
        }
        const { pkgJson } = readGuildPackageJson(home, packageName);
        result[packageName] = pkgJson
          ? ((pkgJson.version as string) ?? 'unknown')
          : 'not installed';
      }
    } catch {
      // Not in a guild or guild.json unreadable — just show framework version
    }

    if (params.json) {
      return result;
    }

    const lines = Object.entries(result).map(([k, v]) => `${k}: ${v}`);
    return lines.join('\n');
  },
});
