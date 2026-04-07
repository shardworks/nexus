/**
 * input-request-export tool — export an input request as YAML.
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '../types.ts';

export default tool({
  name: 'input-request-export',
  description: 'Export an input request as YAML',
  instructions:
    'Returns a YAML string containing the request id, message, questions, and current answers. ' +
    'Save this to a file, edit the answers, and use input-request-import to apply them.',
  params: {
    id: z.string().describe('The input request id to export.'),
  },
  permission: 'read',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.readBook<InputRequestDoc>('spider', 'input-requests');

    const request = await book.get(params.id);
    if (request === null) throw new Error(`Input request "${params.id}" not found`);

    const exportObj = {
      id: request.id,
      message: request.message,
      questions: request.questions,
      answers: request.answers,
    };

    return { yaml: stringify(exportObj) };
  },
});
