import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isTerminalStuck, parseChildFailures, writShortId } from './predicates.ts';

describe('isTerminalStuck', () => {
  it('treats every stuck as terminal when clockworks-retry is absent', () => {
    assert.equal(isTerminalStuck({ retryable: true }, 0, undefined), true);
    assert.equal(isTerminalStuck({ retryable: false }, 0, undefined), true);
    assert.equal(isTerminalStuck(undefined, 0, undefined), true);
  });

  it('is terminal when retryable is explicitly false', () => {
    assert.equal(isTerminalStuck({ retryable: false }, 0, 2), true);
  });

  it('is terminal when the retryable flag is missing', () => {
    assert.equal(isTerminalStuck({ stuckCause: 'engine-failure' }, 0, 2), true);
    assert.equal(isTerminalStuck(undefined, 0, 2), true);
  });

  it('is terminal when the rig count is at or above the cap', () => {
    assert.equal(isTerminalStuck({ retryable: true }, 2, 2), true);
    assert.equal(isTerminalStuck({ retryable: true }, 3, 2), true);
  });

  it('is not terminal when retryable is true and under the cap', () => {
    assert.equal(isTerminalStuck({ retryable: true }, 0, 2), false);
    assert.equal(isTerminalStuck({ retryable: true }, 1, 2), false);
  });
});

describe('parseChildFailures', () => {
  it('returns an empty array for undefined / empty strings', () => {
    assert.deepEqual(parseChildFailures(undefined), []);
    assert.deepEqual(parseChildFailures(''), []);
    assert.deepEqual(parseChildFailures('operator-written resolution'), []);
  });

  it('extracts a single cascade child id', () => {
    const resolution = 'Child "w-abc123-deadbeef" failed: Broke';
    assert.deepEqual(parseChildFailures(resolution), ['w-abc123-deadbeef']);
  });

  it('extracts nested cascade child ids in order', () => {
    const resolution =
      'Child "w-parent-11" failed: Child "w-leaf-22" failed: engine crashed';
    assert.deepEqual(parseChildFailures(resolution), ['w-parent-11', 'w-leaf-22']);
  });

  it('deduplicates repeated child ids', () => {
    const resolution =
      'Child "w-same-11" failed: one thing; Child "w-same-11" failed: another';
    assert.deepEqual(parseChildFailures(resolution), ['w-same-11']);
  });
});

describe('writShortId', () => {
  it('produces the two-segment short id', () => {
    assert.equal(writShortId('w-abc123-deadbeef'), 'w-abc123');
    assert.equal(writShortId('w-abc123'), 'w-abc123');
  });
});
