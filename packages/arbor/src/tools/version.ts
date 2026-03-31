/**
 * nsg version — show framework and rig version info.
 *
 * An arbor built-in command. Available via CLI only (not MCP).
 */

import { tool, VERSION, readGuildConfigV2 } from '@shardworks/nexus-core';
import { z } from 'zod';
import { readGuildPackageJson, resolvePackageNameForPluginId } from '../resolve-package.ts';

export default tool({
  name: 'version',
  description: 'Show Nexus framework and installed rig version information',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const result: Record<string, string> = {
      nexus: VERSION,
      node: process.version,
    };

    try {
      const config = readGuildConfigV2(home);
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

    if (_params.json) {
      return result;
    }

    const lines = Object.entries(result).map(([k, v]) => `${k}: ${v}`);
    return lines.join('\n');
  },
});
