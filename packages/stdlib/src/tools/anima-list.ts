import { tool } from '@shardworks/nexus-core';
import { listAnimas, checkAllAnimaStaleness } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'anima-list',
  description: 'List animas in the guild, optionally filtered by status or role',
  instructions: 'Returns animas from the Register with their roles and staleness status. Stale animas have outdated curriculum or temperament compositions. Use --status to filter by lifecycle status, --role to filter by role.',
  params: {
    status: z.string().optional().describe('Filter by status (aspirant, active, retired)'),
    role: z.string().optional().describe('Filter by role name'),
  },
  handler: (params, { home }) => {
    const animas = listAnimas(home, params);
    const stalenessMap = checkAllAnimaStaleness(home);

    return animas.map(a => ({
      ...a,
      stale: stalenessMap.has(a.id),
      staleness: stalenessMap.get(a.id) ?? null,
    }));
  },
});
