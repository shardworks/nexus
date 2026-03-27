/**
 * nsg status — minimal guild status.
 *
 * Rig built-in. Shows guild identity, framework version, installed plugins.
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to plugins, not here.
 */

import { tool, VERSION, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';
import { derivePluginKey } from '../rig.ts';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed plugin summary',
  allowedContexts: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfig(home);

    // Collect unique plugin packages
    const pluginKeys = new Set<string>();
    for (const entry of Object.values(config.tools)) {
      if (entry.package) pluginKeys.add(derivePluginKey(entry.package));
    }

    const result = {
      guild: config.name,
      nexus: VERSION,
      home,
      plugins: Array.from(pluginKeys).sort(),
      roles: Object.keys(config.roles).sort(),
    };

    if (_params.json) {
      return result;
    }

    const lines = [
      `Guild:   ${result.guild}`,
      `Nexus:   ${result.nexus}`,
      `Home:    ${result.home}`,
      `Plugins: ${result.plugins.length > 0 ? result.plugins.join(', ') : '(none)'}`,
      `Roles:   ${result.roles.length > 0 ? result.roles.join(', ') : '(none)'}`,
    ];
    return lines.join('\n');
  },
});
