/**
 * nsg version — show framework and rig version info.
 *
 * A mainspring built-in command. Available via CLI only (not MCP).
 */

import { tool, VERSION, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';
import { readGuildPackageJson } from '../resolve-package.ts';

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

    // Collect installed package versions from tool entries in guild.json.
    // Tools share packages (multiple tools can come from one package), so
    // we deduplicate before resolving. Missing packages show "not installed".
    try {
      const config = readGuildConfig(home);
      const packages = new Set<string>();
      for (const entry of Object.values(config.tools ?? {})) {
        if (entry.package) packages.add(entry.package);
      }
      for (const packageName of packages) {
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
