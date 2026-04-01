import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { addWorkshop, deriveWorkshopName } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'workshop-register',
  description: 'Clone an existing remote repository and register it as a workshop',
  instructions: 'Clones a bare copy of the repo and registers it in guild.json. Use workshop-create to create a new repo instead.',
  params: {
    url: z.string().describe('Git remote URL to clone'),
    name: z.string().optional().describe('Workshop name (default: derived from URL)'),
  },
  handler: (params) => {
    const { home } = guild();
    const name = params.name ?? deriveWorkshopName(params.url);
    return addWorkshop({ home, name, remoteUrl: params.url });
  },
});
