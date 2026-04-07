/**
 * Shared validation logic for input request answers.
 *
 * Used by the answer tool, complete tool, and import tool.
 */

import type {
  QuestionSpec,
  AnswerValue,
  ChoiceAnswer,
} from './types.ts';

/**
 * Validate and coerce an answer value for the given question spec.
 *
 * Throws a descriptive error if the answer is invalid for the question type.
 * Returns a properly-typed AnswerValue on success.
 */
export function validateAnswer(question: QuestionSpec, answer: unknown): AnswerValue {
  if (question.type === 'choice') {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new Error('Choice answer must be an object with exactly one of "selected" or "custom"');
    }
    const obj = answer as Record<string, unknown>;
    const hasSelected = 'selected' in obj;
    const hasCustom = 'custom' in obj;

    if (hasSelected && hasCustom) {
      throw new Error('Choice answer must have exactly one of "selected" or "custom"');
    }
    if (!hasSelected && !hasCustom) {
      throw new Error('Choice answer must have exactly one of "selected" or "custom"');
    }

    if (hasSelected) {
      const selected = obj['selected'];
      if (typeof selected !== 'string') {
        throw new Error('Choice answer "selected" must be a string');
      }
      if (!(selected in question.options)) {
        const validKeys = Object.keys(question.options).join(', ');
        throw new Error(`"${selected}" is not a valid option. Valid options: ${validKeys}`);
      }
      return { selected } as ChoiceAnswer;
    }

    // hasCustom
    const custom = obj['custom'];
    if (typeof custom !== 'string') {
      throw new Error('Choice answer "custom" must be a string');
    }
    if (!question.allowCustom) {
      throw new Error('Custom answers not allowed for this question');
    }
    return { custom } as ChoiceAnswer;
  }

  if (question.type === 'boolean') {
    if (answer === true || answer === false) return answer;
    if (answer === 'true') return true;
    if (answer === 'false') return false;
    throw new Error(`Boolean answer must be true, false, "true", or "false"; got ${JSON.stringify(answer)}`);
  }

  if (question.type === 'text') {
    if (typeof answer !== 'string') {
      throw new Error(`Text answer must be a string; got ${typeof answer}`);
    }
    return answer;
  }

  // Exhaustiveness check
  const _exhaustive: never = question;
  throw new Error(`Unknown question type: ${(_exhaustive as QuestionSpec).type}`);
}

/**
 * Return the list of question keys that have no answer yet.
 *
 * Used by the complete tool to report unanswered questions.
 */
export function validateAllAnswered(
  questions: Record<string, QuestionSpec>,
  answers: Record<string, AnswerValue>,
): string[] {
  return Object.keys(questions).filter((key) => !(key in answers));
}
