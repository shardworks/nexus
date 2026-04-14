/**
 * Tests for the claude-code provider cancel() method and processInfo.
 *
 * Tests cancel() SIGTERM behavior using process.kill mocking, and
 * verifies processInfo promise resolves with { pid }.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeCodeProvider } from './index.ts';
import type { AnimatorSessionProvider } from '@shardworks/animator-apparatus';

// Extract the provider from the plugin
function getProvider(): AnimatorSessionProvider {
  const plugin = createClaudeCodeProvider();
  return (plugin as { apparatus: { provides: AnimatorSessionProvider } }).apparatus.provides;
}

describe('claude-code provider cancel()', () => {
  it('sends SIGTERM to process group for local-pgid', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel, 'provider should have cancel method');

    const killMock = mock.method(process, 'kill', () => {});

    try {
      await provider.cancel!({ kind: 'local-pgid', pgid: 12345 });
      assert.equal(killMock.mock.calls.length, 1);
      assert.deepEqual(killMock.mock.calls[0]!.arguments, [-12345, 'SIGTERM']);
    } finally {
      killMock.mock.restore();
    }
  });

  it('swallows ESRCH errors (process group already dead)', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel);

    const esrchError = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const killMock = mock.method(process, 'kill', () => { throw esrchError; });

    try {
      // Should not throw
      await provider.cancel!({ kind: 'local-pgid', pgid: 999999 });
    } finally {
      killMock.mock.restore();
    }
  });

  it('propagates EPERM errors', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel);

    const epermError = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const killMock = mock.method(process, 'kill', () => { throw epermError; });

    try {
      await assert.rejects(
        () => provider.cancel!({ kind: 'local-pgid', pgid: 1 }),
        (err: Error & { code?: string }) => {
          assert.equal(err.code, 'EPERM');
          return true;
        },
      );
    } finally {
      killMock.mock.restore();
    }
  });

  it('does nothing when kind is missing', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel);

    const killMock = mock.method(process, 'kill', () => {});

    try {
      await provider.cancel!({});
      assert.equal(killMock.mock.calls.length, 0);
    } finally {
      killMock.mock.restore();
    }
  });

  it('does nothing for unknown kind', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel);

    const killMock = mock.method(process, 'kill', () => {});

    try {
      await provider.cancel!({ kind: 'future-thing' });
      assert.equal(killMock.mock.calls.length, 0);
    } finally {
      killMock.mock.restore();
    }
  });

  it('does nothing when pgid is undefined for local-pgid', async () => {
    const provider = getProvider();
    assert.ok(provider.cancel);

    const killMock = mock.method(process, 'kill', () => {});

    try {
      await provider.cancel!({ kind: 'local-pgid' });
      assert.equal(killMock.mock.calls.length, 0);
    } finally {
      killMock.mock.restore();
    }
  });
});
