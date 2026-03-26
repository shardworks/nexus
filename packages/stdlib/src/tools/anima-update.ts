import { tool } from '@shardworks/nexus-core';
import { updateAnima } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'anima-update',
  description: 'Update an anima\'s status or roles',
  instructions: 'Updates an anima in the Register. Use --status to change lifecycle status, --roles to replace role assignments.',
  params: {
    id: z.string().describe('Anima ID or name'),
    status: z.string().optional().describe('New status (aspirant, active, retired)'),
    roles: z.array(z.string()).optional().describe('New role assignments (replaces all existing roles)'),
  },
  handler: (params, { home }) => updateAnima(home, params.id, {
    status: params.status,
    roles: params.roles,
  }),
});
