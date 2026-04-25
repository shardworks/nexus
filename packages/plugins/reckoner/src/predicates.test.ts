import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isTerminalStuck } from './predicates.ts';

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

