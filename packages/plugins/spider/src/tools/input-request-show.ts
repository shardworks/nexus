/**
 * input-request-show tool — retrieve an input request by id.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '../types.ts';

export default tool({
  name: 'input-request-show',
  description: 'Retrieve an input request by id',
  instructions:
    'Returns the full InputRequestDoc for the given id. ' +
    'Throws if the request does not exist.',
  params: {
    id: z.string().describe('The input request id to look up.'),
  },
  permission: 'read',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.readBook<InputRequestDoc>('spider', 'input-requests');
    const doc = await book.get(params.id);
    if (doc === null) throw new Error(`Input request "${params.id}" not found`);
    return doc;
  },
});
