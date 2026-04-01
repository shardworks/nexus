import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { removeWorkshop } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'workshop-remove',
  description: 'Remove a workshop — deletes bare clone, worktrees, and guild.json entry',
  instructions: 'Permanently removes the workshop from the guild. Deletes the bare clone and all worktrees on disk.',
  params: {
    name: z.string().describe('Workshop name to remove'),
  },
  handler: (params) => {
    const { home } = guild();
    removeWorkshop({ home, name: params.name });
    return { removed: params.name };
  },
});
