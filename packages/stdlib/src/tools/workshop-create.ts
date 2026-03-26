import { tool, createWorkshop } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'workshop-create',
  description: 'Create a new GitHub repository and register it as a workshop',
  instructions: 'Creates a new repo via gh CLI and registers it as a guild workshop. Requires gh authentication.',
  params: {
    repoName: z.string().describe('Repository name in org/name format'),
    private: z.boolean().optional().describe('Create private repo (default: true)'),
  },
  handler: (params, { home }) => createWorkshop({ home, ...params }),
});
