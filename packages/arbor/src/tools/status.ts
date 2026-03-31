/**
 * nsg status — minimal guild status.
 *
 * Arbor built-in. Shows guild identity, framework version, installed rigs.
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to rigs, not here.
 */

import { tool, VERSION, readGuildConfigV2 } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed rig summary',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params, { home }) => {
    const config = readGuildConfigV2(home);

    const result = {
      guild: config.name,
      nexus: VERSION,
      home,
      model: config.settings?.model ?? '(not set)',
      rigs: [...config.rigs].sort(),
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
