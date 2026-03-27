/**
 * nsg version — show framework and plugin version info.
 *
 * A rig built-in command. Available via CLI only (not MCP).
 */

import { createRequire } from 'node:module';
import { tool, VERSION, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';

const _require = createRequire(import.meta.url);

export default tool({
  name: 'version',
  description: 'Show Nexus framework and plugin version information',
  allowedContexts: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const result: Record<string, string> = {
      nexus: VERSION,
      node: process.version,
    };

    // Read installed plugin versions from guild.json
    try {
      const config = readGuildConfig(home);
      const seen = new Set<string>();
      for (const entry of Object.values(config.tools)) {
        if (!entry.package || seen.has(entry.package)) continue;
        seen.add(entry.package);
        try {
          const pkg = _require(`${entry.package}/package.json`) as { version?: string };
          result[entry.package] = pkg.version ?? 'unknown';
        } catch {
          result[entry.package] = 'not installed';
        }
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
