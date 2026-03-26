/**
 * remove-tool tool.
 *
 * This is the canonical implementation — called by the MCP engine (for animas),
 * the CLI (for humans), and importable by engines. All access paths execute
 * the same logic.
 */
import { tool, removeTool } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'tool-remove',
  description: 'Remove a guild-managed tool, engine, curriculum, or temperament',
  instructionsFile: './instructions/tool-remove.md',
  params: {
    name: z.string().describe('Name of the tool to remove'),
    category: z.enum(['tools', 'engines', 'curricula', 'temperaments']).optional()
      .describe('Restrict to a specific category (searches all if omitted)'),
  },
  handler: (params, { home }) => {
    return removeTool({ home, name: params.name, category: params.category });
  },
});
