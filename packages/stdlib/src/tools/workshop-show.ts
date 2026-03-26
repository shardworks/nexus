import { tool, showWorkshop } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'workshop-show',
  description: 'Show detailed information about a workshop',
  instructions: 'Returns workshop details including bare path, default branch, clone status, and worktree count.',
  params: {
    name: z.string().describe('Workshop name'),
  },
  handler: (params, { home }) => {
    const result = showWorkshop(home, params.name);
    if (!result) throw new Error(`Workshop "${params.name}" not found.`);
    return result;
  },
});
