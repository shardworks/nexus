/**
 * nsg status — minimal guild status.
 *
 * Mainspring built-in. Shows guild identity, framework version, installed rigs.
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to rigs, not here.
 */

import { tool, VERSION, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';
import { deriveRigKey } from '../mainspring.ts';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed rig summary',
  allowedContexts: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfig(home);

    // Collect unique rig keys
    const rigKeys = new Set<string>();
    for (const entry of Object.values(config.tools)) {
      if (entry.package) rigKeys.add(deriveRigKey(entry.package));
    }

    const result = {
      guild: config.name,
      nexus: VERSION,
      home,
      rigs: Array.from(rigKeys).sort(),
      roles: Object.keys(config.roles).sort(),
    };

    if (_params.json) {
      return result;
    }

    const lines = [
      `Guild:   ${result.guild}`,
      `Nexus:   ${result.nexus}`,
      `Home:    ${result.home}`,
      `Rigs:    ${result.rigs.length > 0 ? result.rigs.join(', ') : '(none)'}`,
      `Roles:   ${result.roles.length > 0 ? result.roles.join(', ') : '(none)'}`,
    ];
    return lines.join('\n');
  },
});
