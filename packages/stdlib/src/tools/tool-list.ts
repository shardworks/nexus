import { tool, guild } from '@shardworks/nexus-core';
import { listTools } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'tool-list',
  description: 'List installed tools, engines, curricula, and temperaments',
  instructions: 'Returns all installed artifacts from guild.json. Use --category to restrict to a specific type.',
  params: {
    category: z.string().optional().describe('Filter by category (tools, engines, curricula, temperaments)'),
  },
  handler: (params) => {
    const { home } = guild();
    return listTools(home, params.category);
  },
});
