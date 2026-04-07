/**
 * input-request-complete tool — mark an input request as completed.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '../types.ts';
import { validateAllAnswered } from '../input-request-validation.ts';

export default tool({
  name: 'input-request-complete',
  description: 'Mark an input request as completed',
  instructions:
    'Transitions a pending input request to "completed" status. ' +
    'All questions must be answered first. ' +
    'Throws listing any unanswered question keys if any remain.',
  params: {
    id: z.string().describe('The input request id to complete.'),
  },
  permission: 'spider:write',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.book<InputRequestDoc>('spider', 'input-requests');

    const request = await book.get(params.id);
    if (request === null) throw new Error(`Input request "${params.id}" not found`);
    if (request.status !== 'pending') {
      throw new Error(`Cannot complete: request status is "${request.status}"`);
    }

    const unanswered = validateAllAnswered(request.questions, request.answers);
    if (unanswered.length > 0) {
      throw new Error(`Cannot complete: unanswered questions: ${unanswered.join(', ')}`);
    }

    return book.patch(params.id, {
      status: 'completed',
      updatedAt: new Date().toISOString(),
    });
  },
});
