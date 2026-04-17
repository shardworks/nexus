import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-link-meanings-show',
  description: 'Show a single link meaning by id',
  instructions:
    'Returns the full record for a registered link meaning, including its ' +
    'owner plugin id and description. Exits with an error if the id is not ' +
    'present in the registry.',
  params: {
    id: z.string().describe('Fully-qualified meaning id (e.g. "astrolabe:refines")'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const meanings = await clerk.listMeanings();
    const match = meanings.find((m) => m.id === params.id);
    if (!match) {
      throw new Error(
        `Unknown link meaning "${params.id}". Registered meanings: ${
          meanings.length === 0 ? '(none)' : meanings.map((m) => m.id).join(', ')
        }.`,
      );
    }
    return match;
  },
});
