/**
 * Tests for input-request-validation.ts
 *
 * Covers validateAnswer() and validateAllAnswered() edge cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateAnswer, validateAllAnswered } from './input-request-validation.ts';
import type { ChoiceQuestionSpec, BooleanQuestionSpec, TextQuestionSpec } from './types.ts';

// ── Choice question ────────────────────────────────────────────────────

describe('validateAnswer — choice question', () => {
  const choiceQ: ChoiceQuestionSpec = {
    type: 'choice',
    label: 'Pick one',
    options: { yes: 'Yes', no: 'No', maybe: 'Maybe' },
    allowCustom: false,
  };

  const choiceQWithCustom: ChoiceQuestionSpec = {
    type: 'choice',
    label: 'Pick one',
    options: { yes: 'Yes', no: 'No' },
    allowCustom: true,
  };

  it('{ selected: validKey } is accepted', () => {
    const result = validateAnswer(choiceQ, { selected: 'yes' });
    assert.deepEqual(result, { selected: 'yes' });
  });

  it('{ selected: anotherValidKey } is accepted', () => {
    const result = validateAnswer(choiceQ, { selected: 'maybe' });
    assert.deepEqual(result, { selected: 'maybe' });
  });

  it('{ selected: missingKey } throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, { selected: 'nope' }),
      /not a valid option/i,
    );
  });

  it('{ custom: text } with allowCustom: true is accepted', () => {
    const result = validateAnswer(choiceQWithCustom, { custom: 'my custom text' });
    assert.deepEqual(result, { custom: 'my custom text' });
  });

  it('{ custom: text } with allowCustom: false throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, { custom: 'text' }),
      /Custom answers not allowed/i,
    );
  });

  it('{} (neither key) throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, {}),
      /exactly one of/i,
    );
  });

  it('{ selected, custom } (both keys) throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, { selected: 'yes', custom: 'also this' }),
      /exactly one of/i,
    );
  });

  it('non-object answer throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, 'yes'),
      /Choice answer must be an object/i,
    );
  });

  it('null answer throws', () => {
    assert.throws(
      () => validateAnswer(choiceQ, null),
      /Choice answer must be an object/i,
    );
  });
});

// ── Boolean question ───────────────────────────────────────────────────

describe('validateAnswer — boolean question', () => {
  const boolQ: BooleanQuestionSpec = { type: 'boolean', label: 'Confirm?' };

  it('true → true', () => {
    assert.equal(validateAnswer(boolQ, true), true);
  });

  it('false → false', () => {
    assert.equal(validateAnswer(boolQ, false), false);
  });

  it('"true" → true (string coercion)', () => {
    assert.equal(validateAnswer(boolQ, 'true'), true);
  });

  it('"false" → false (string coercion)', () => {
    assert.equal(validateAnswer(boolQ, 'false'), false);
  });

  it('"yes" throws', () => {
    assert.throws(
      () => validateAnswer(boolQ, 'yes'),
      /Boolean answer must be/i,
    );
  });

  it('42 throws', () => {
    assert.throws(
      () => validateAnswer(boolQ, 42),
      /Boolean answer must be/i,
    );
  });

  it('null throws', () => {
    assert.throws(
      () => validateAnswer(boolQ, null),
      /Boolean answer must be/i,
    );
  });
});

// ── Text question ──────────────────────────────────────────────────────

describe('validateAnswer — text question', () => {
  const textQ: TextQuestionSpec = { type: 'text', label: 'Describe your issue' };

  it('"hello" → "hello"', () => {
    assert.equal(validateAnswer(textQ, 'hello'), 'hello');
  });

  it('empty string is accepted', () => {
    assert.equal(validateAnswer(textQ, ''), '');
  });

  it('42 throws', () => {
    assert.throws(
      () => validateAnswer(textQ, 42),
      /Text answer must be a string/i,
    );
  });

  it('true throws', () => {
    assert.throws(
      () => validateAnswer(textQ, true),
      /Text answer must be a string/i,
    );
  });

  it('null throws', () => {
    assert.throws(
      () => validateAnswer(textQ, null),
      /Text answer must be a string/i,
    );
  });
});

// ── validateAllAnswered ────────────────────────────────────────────────

describe('validateAllAnswered', () => {
  const questions = {
    q1: { type: 'text' as const, label: 'Q1' },
    q2: { type: 'boolean' as const, label: 'Q2' },
    q3: { type: 'text' as const, label: 'Q3' },
  };

  it('returns empty array when all questions are answered', () => {
    const answers = { q1: 'a', q2: true, q3: 'c' };
    const missing = validateAllAnswered(questions, answers);
    assert.deepEqual(missing, []);
  });

  it('returns single unanswered key', () => {
    const answers = { q1: 'a', q2: true };
    const missing = validateAllAnswered(questions, answers);
    assert.deepEqual(missing, ['q3']);
  });

  it('returns multiple unanswered keys', () => {
    const answers = { q2: false };
    const missing = validateAllAnswered(questions, answers);
    assert.ok(missing.includes('q1'));
    assert.ok(missing.includes('q3'));
    assert.equal(missing.length, 2);
  });

  it('returns all keys when answers is empty', () => {
    const missing = validateAllAnswered(questions, {});
    assert.equal(missing.length, 3);
  });

  it('returns empty array when questions is empty', () => {
    const missing = validateAllAnswered({}, { q1: 'extra' });
    assert.deepEqual(missing, []);
  });
});
