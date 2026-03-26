/**
 * instantiate tool.
 *
 * This is the canonical implementation — called by the MCP engine (for animas),
 * the CLI (for humans), and importable by engines. All access paths execute
 * the same logic.
 */
import { tool, instantiate } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'anima-create',
  description: 'Instantiate a new anima in the guild with assigned curriculum, temperament, and roles',
  instructionsFile: './instructions/anima-create.md',
  params: {
    name: z.string().describe('Name for the new anima'),
    roles: z.array(z.string()).describe('Roles the anima will hold (e.g. artificer, sage)'),
    curriculum: z.string().optional().describe('Curriculum to assign (by name, must be registered in guild.json)'),
    temperament: z.string().optional().describe('Temperament to assign (by name, must be registered in guild.json)'),
  },
  handler: (params, { home }) => {
    return instantiate({ home, ...params });
  },
});
