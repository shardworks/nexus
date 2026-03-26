import { tool } from '@shardworks/nexus-core';
import { removeAnima } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'anima-remove',
  description: 'Remove (retire) an anima from the guild',
  instructions: 'Sets the anima status to retired and removes all role assignments. This is irreversible.',
  params: {
    id: z.string().describe('Anima ID or name'),
  },
  handler: (params, { home }) => {
    removeAnima(home, params.id);
    return { removed: params.id };
  },
});
