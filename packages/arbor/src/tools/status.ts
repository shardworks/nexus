/**
 * nsg status — guild status.
 *
 * Arbor built-in. Shows guild identity, framework version, and installed plugins
 * separated into apparatuses (running infrastructure) and kits (passive capabilities).
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to plugins, not here.
 */

import { tool, VERSION, readGuildConfig, guild } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed plugin summary',
  callableFrom: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (_params) => {
    const { home } = guild();
    const config = readGuildConfig(home);

    // Note: at status time we don't load/start plugins — we just report what's
    // declared in guild.json. Type discrimination (kit vs apparatus) requires
    // loading the modules, which is deferred to avoid startup cost for status.
    const result = {
      guild:   config.name,
      nexus:   VERSION,
      home,
      model:   config.settings?.model ?? '(not set)',
      plugins: [...config.plugins].sort(),
      roles:   Object.keys(config.roles).sort(),
    };

    if (_params.json) {
      return result;
    }

    const lines = [
      `Guild:    ${result.guild}`,
      `Nexus:    ${result.nexus}`,
      `Home:     ${result.home}`,
      `Model:    ${result.model}`,
      `Plugins:  ${result.plugins.length > 0 ? result.plugins.join(', ') : '(none)'}`,
      `Roles:    ${result.roles.length > 0 ? result.roles.join(', ') : '(none)'}`,
    ];
    return lines.join('\n');
  },
});
