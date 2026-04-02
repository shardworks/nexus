/**
 * nsg status — guild status.
 *
 * A framework command. Shows guild identity, framework version, and installed plugins
 * separated into apparatuses (running infrastructure) and kits (passive capabilities).
 * Domain-specific status (writ counts, session history, clock state) belongs
 * to plugins, not here.
 *
 * Requires a booted guild — prints a friendly error if run outside one.
 */

import { tool } from '@shardworks/tools-apparatus';
import { VERSION, readGuildConfig, guild } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'status',
  description: 'Show guild identity and installed plugin summary',
  callableBy: ['cli'],
  params: {
    json: z.boolean().optional().describe('Output as JSON'),
  },
  handler: async (params) => {
    let g;
    try {
      g = guild();
    } catch {
      throw new Error('Not inside a guild. Run `nsg init` to create one, or use --guild-root to specify the path.');
    }

    const { home } = g;
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
    };

    if (params.json) {
      return result;
    }

    const lines = [
      `Guild:    ${result.guild}`,
      `Nexus:    ${result.nexus}`,
      `Home:     ${result.home}`,
      `Model:    ${result.model}`,
      `Plugins:  ${result.plugins.length > 0 ? result.plugins.join(', ') : '(none)'}`,
    ];
    return lines.join('\n');
  },
});
