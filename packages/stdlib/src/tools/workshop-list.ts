import { tool, guild } from '@shardworks/nexus-core';
import { listWorkshops } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'workshop-list',
  description: 'List all registered workshops',
  instructions: 'Returns workshops from guild.json with clone status and active worktree count.',
  params: {},
  handler: (_params) => {
    const { home } = guild();
    return listWorkshops(home);
  },
});
