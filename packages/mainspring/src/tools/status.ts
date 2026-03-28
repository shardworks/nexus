/**
 * nsg status — minimal guild status.
 *
 * Mainspring built-in. Shows guild identity, framework version, installed rigs.
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to rigs, not here.
 *
 * Rig list is derived from config.tools[*].package entries (V1 registry),
 * not config.rigs, so it reflects installed packages even on hybrid guilds.
 */

import { tool, VERSION, readGuildConfig } from '@shardworks/nexus-core';
import { z } from 'zod';
import { deriveRigId } from '../resolve-package.ts';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed rig summary',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfig(home);

    // Derive unique rig keys from installed tool entries — deduplicated and sorted.
    const rigKeys = [...new Set(
      Object.values(config.tools ?? {})
        .filter((e) => e.package)
        .map((e) => deriveRigId(e.package!)),
    )].sort();

    const result = {
      guild: config.name,
      nexus: VERSION,
      home,
      model: config.model ?? config.settings?.model ?? '(not set)',
      rigs: rigKeys,
      roles: Object.keys(config.roles).sort(),
    };

    if (_params.json) {
      return result;
    }

    const lines = [
      `Guild:   ${result.guild}`,
      `Nexus:   ${result.nexus}`,
      `Home:    ${result.home}`,
      `Model:   ${result.model}`,
      `Rigs:    ${result.rigs.length > 0 ? result.rigs.join(', ') : '(none)'}`,
      `Roles:   ${result.roles.length > 0 ? result.roles.join(', ') : '(none)'}`,
    ];
    return lines.join('\n');
  },
});
