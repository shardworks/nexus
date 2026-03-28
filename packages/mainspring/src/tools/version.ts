/**
 * nsg version — show framework and rig version info.
 *
 * A mainspring built-in command. Available via CLI only (not MCP).
 */

import { tool, VERSION, readGuildConfigV2 } from '@shardworks/nexus-core';
import { z } from 'zod';
import { resolvePackageNameForRigKey, readGuildPackageJson } from '../resolve-package.ts';

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

    // Read installed rig versions by resolving each rig key → package name
    try {
      const config = readGuildConfigV2(home);
      for (const rigKey of config.rigs) {
        const packageName = resolvePackageNameForRigKey(home, rigKey);
        if (!packageName) continue;
        const { version } = readGuildPackageJson(home, packageName);
        result[rigKey] = version;
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
