import { tool, removeWorkshop } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'workshop-remove',
  description: 'Remove a workshop — deletes bare clone, worktrees, and guild.json entry',
  instructions: 'Permanently removes the workshop from the guild. Deletes the bare clone and all worktrees on disk.',
  params: {
    name: z.string().describe('Workshop name to remove'),
  },
  handler: (params, { home }) => {
    removeWorkshop({ home, name: params.name });
    return { removed: params.name };
  },
});
