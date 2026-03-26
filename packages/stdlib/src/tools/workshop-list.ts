import { tool, listWorkshops } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'workshop-list',
  description: 'List all registered workshops',
  instructions: 'Returns workshops from guild.json with clone status and active worktree count.',
  params: {},
  handler: (_params, { home }) => listWorkshops(home),
});
