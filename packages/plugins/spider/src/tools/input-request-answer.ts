/**
 * input-request-answer tool — provide an answer for a single question.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { InputRequestDoc } from '../types.ts';
import { validateAnswer } from '../input-request-validation.ts';

export default tool({
  name: 'input-request-answer',
  description: 'Provide an answer for a question in an input request',
  instructions:
    'Answer a single question in a pending input request. ' +
    'For choice questions, use --select <optionKey> or --custom <text> (if allowed). ' +
    'For boolean and text questions, use --value. ' +
    'Answers can be overwritten while the request is still pending.',
  params: {
    id: z.string().describe('The input request id.'),
    question: z.string().describe('The question key to answer.'),
    select: z
      .string()
      .optional()
      .describe('For choice questions: the option key to select.'),
    custom: z
      .string()
      .optional()
      .describe('For choice questions: a custom freeform answer (only when allowCustom is true).'),
    value: z
      .string()
      .optional()
      .describe('For boolean or text questions: the answer value.'),
  },
  permission: 'write',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.book<InputRequestDoc>('spider', 'input-requests');

    const request = await book.get(params.id);
    if (request === null) throw new Error(`Input request "${params.id}" not found`);
    if (request.status !== 'pending') {
      throw new Error(`Cannot answer: request status is "${request.status}"`);
    }

    const questionKey = params.question;
    if (!(questionKey in request.questions)) {
      throw new Error(`Question "${questionKey}" not found in request`);
    }

    const questionSpec = request.questions[questionKey];

    let rawAnswer: unknown;

    if (questionSpec.type === 'choice') {
      const hasSelect = params.select !== undefined;
      const hasCustom = params.custom !== undefined;
      if (hasSelect && hasCustom) {
        throw new Error('Provide exactly one of --select or --custom for choice questions');
      }
      if (!hasSelect && !hasCustom) {
        throw new Error('Provide exactly one of --select or --custom for choice questions');
      }
      if (hasSelect) {
        rawAnswer = { selected: params.select };
      } else {
        rawAnswer = { custom: params.custom };
      }
    } else {
      // boolean or text
      if (params.select !== undefined || params.custom !== undefined) {
        throw new Error(`Use --value for ${questionSpec.type} questions, not --select/--custom`);
      }
      if (params.value === undefined) {
        throw new Error(`Provide --value for ${questionSpec.type} questions`);
      }
      rawAnswer = params.value;
    }

    const validatedAnswer = validateAnswer(questionSpec, rawAnswer);

    return book.patch(params.id, {
      answers: { ...request.answers, [questionKey]: validatedAnswer },
      updatedAt: new Date().toISOString(),
    });
  },
});
