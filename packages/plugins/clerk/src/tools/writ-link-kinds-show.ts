import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-link-kinds-show',
  description: 'Show a single link kind by id',
  instructions:
    'Returns the full record for a registered link kind, including its ' +
    'owner plugin id and description. Exits with an error if the id is not ' +
    'present in the registry.',
  params: {
    id: z.string().describe('Fully-qualified kind id (e.g. "astrolabe.refines")'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const kinds = await clerk.listKinds();
    const match = kinds.find((k) => k.id === params.id);
    if (!match) {
      throw new Error(
        `Unknown link kind "${params.id}". Registered link kinds: ${
          kinds.length === 0 ? '(none)' : kinds.map((k) => k.id).join(', ')
        }.`,
      );
    }
    return match;
  },
});
