/**
 * input-request-import tool — import answers from a YAML file.
 */

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc, AnswerValue } from '../types.ts';
import { validateAnswer } from '../input-request-validation.ts';

export default tool({
  name: 'input-request-import',
  description: 'Import answers for an input request from a YAML file',
  instructions:
    'Reads a YAML file (exported via input-request-export), validates all answers, ' +
    'and patches the request\'s answers. The request must be pending. ' +
    'Unknown question keys and invalid answer values will cause an error.',
  params: {
    file: z.string().describe('File path to the YAML file containing answers.'),
  },
  permission: 'spider:write',
  handler: async (params) => {
    const raw = await readFile(params.file, 'utf8');
    const parsed = parse(raw) as Record<string, unknown>;

    const id = parsed['id'];
    if (!id || typeof id !== 'string') {
      throw new Error('YAML file missing required "id" field');
    }

    const rawAnswers = (parsed['answers'] ?? {}) as Record<string, unknown>;

    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.book<InputRequestDoc>('spider', 'input-requests');

    const request = await book.get(id);
    if (request === null) throw new Error(`Input request "${id}" not found`);
    if (request.status !== 'pending') {
      throw new Error(`Cannot import: request status is "${request.status}"`);
    }

    const validatedAnswers: Record<string, AnswerValue> = {};
    for (const [key, answerValue] of Object.entries(rawAnswers)) {
      if (!(key in request.questions)) {
        throw new Error(`Unknown question key "${key}" in import file`);
      }
      const questionSpec = request.questions[key];
      validatedAnswers[key] = validateAnswer(questionSpec, answerValue);
    }

    return book.patch(id, {
      answers: { ...request.answers, ...validatedAnswers },
      updatedAt: new Date().toISOString(),
    });
  },
});
