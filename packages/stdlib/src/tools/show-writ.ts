import { tool } from '@shardworks/nexus-core';
import { readWrit, getWritChildren } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'show-writ',
  description: 'Show detailed information about a writ and its children',
  instructions: 'Returns the writ record plus a summary of direct children.',
  params: {
    writId: z.string().describe('Writ ID to show'),
  },
  handler: (params, { home }) => {
    const writ = readWrit(home, params.writId);
    if (!writ) {
      return { error: `Writ "${params.writId}" not found.` };
    }

    const children = getWritChildren(home, params.writId);

    return {
      ...writ,
      children,
    };
  },
});
