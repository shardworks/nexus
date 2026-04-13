/**
 * input-request-reject tool — reject an input request.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '../types.ts';

export default tool({
  name: 'input-request-reject',
  description: 'Reject an input request',
  instructions:
    'Transitions a pending input request to "rejected" status, ' +
    'optionally recording a reason. ' +
    'The request can be rejected even with partial answers.',
  params: {
    id: z.string().describe('The input request id to reject.'),
    reason: z
      .string()
      .optional()
      .describe('Optional reason for rejection.'),
  },
  permission: 'write',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.book<InputRequestDoc>('spider', 'input-requests');

    const request = await book.get(params.id);
    if (request === null) throw new Error(`Input request "${params.id}" not found`);
    if (request.status !== 'pending') {
      throw new Error(`Cannot reject: request status is "${request.status}"`);
    }

    return book.patch(params.id, {
      status: 'rejected',
      ...(params.reason ? { rejectionReason: params.reason } : {}),
      updatedAt: new Date().toISOString(),
    });
  },
});
