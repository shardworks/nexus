import { tool } from '@shardworks/nexus-core';
import { showAnima, checkAnimaStaleness } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'anima-show',
  description: 'Show detailed information about a specific anima',
  instructions: 'Returns the full anima record including roles, curriculum, temperament, composition metadata, and staleness status. Stale means the anima was composed with an older version of its curriculum or temperament than what is currently installed. Accepts ID or name.',
  params: {
    id: z.string().describe('Anima ID or name'),
  },
  handler: (params, { home }) => {
    const result = showAnima(home, params.id);
    if (!result) throw new Error(`Anima "${params.id}" not found.`);

    const staleness = result.status === 'active'
      ? checkAnimaStaleness(home, result.id)
      : null;

    return {
      ...result,
      stale: staleness?.stale ?? false,
      staleness: staleness ?? null,
    };
  },
});
