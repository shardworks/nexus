/**
 * Tests for rate-limit signature detection in the claude-code provider.
 *
 * Covers the three-branch cascade declared by decision D5:
 *   1. NDJSON `result` / error message inspection (first-wins)
 *   2. Stderr pattern match
 *   3. Distinguished exit code mapping
 *
 * Also verifies the cascade ordering inside resolveTerminalStatus() —
 * the babysitter's one-stop seat for translating a StreamJsonResult and
 * optional status override into the payload sent to session-record.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectRateLimitFromNdjson,
  detectRateLimitFromStderr,
  detectRateLimitFromExitCode,
  parseStreamJsonMessage,
  RATE_LIMIT_EXIT_CODE,
  type StreamJsonResult,
} from './index.ts';
import { resolveTerminalStatus } from './babysitter.ts';
import type { SessionTerminationTag } from '@shardworks/animator-apparatus';

function freshAcc(): {
  transcript: Record<string, unknown>[];
  costUsd?: number;
  tokenUsage?: StreamJsonResult['tokenUsage'];
  providerSessionId?: string;
  terminationTag?: SessionTerminationTag;
} {
  return { transcript: [] };
}

// ── NDJSON detection ────────────────────────────────────────────────

describe('detectRateLimitFromNdjson()', () => {
  it('tags messages with a rate_limit subtype', () => {
    const tag = detectRateLimitFromNdjson({ type: 'result', subtype: 'rate_limit_error' });
    assert.ok(tag);
    assert.equal(tag!.kind, 'rate-limit');
    assert.equal(tag!.source, 'ndjson-result');
    assert.match(tag!.detail ?? '', /rate_limit_error/);
  });

  it('tags is_error messages whose error text matches the pattern', () => {
    const tag = detectRateLimitFromNdjson({
      is_error: true,
      error: 'HTTP 429: rate limit exceeded',
    });
    assert.ok(tag);
    assert.equal(tag!.source, 'ndjson-result');
  });

  it('tags result messages whose result text mentions rate limit', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'result',
      result: 'Error: Rate limit exceeded. Please try again later.',
    });
    assert.ok(tag);
    assert.equal(tag!.source, 'ndjson-result');
  });

  it('returns null on ordinary assistant messages', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    assert.equal(tag, null);
  });

  it('returns null on a result message without matching text', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'result',
      result: 'Done!',
      total_cost_usd: 0.01,
    });
    assert.equal(tag, null);
  });
});

// ── stderr detection ────────────────────────────────────────────────

describe('detectRateLimitFromStderr()', () => {
  it('matches "rate limit" phrasing case-insensitively', () => {
    const tag = detectRateLimitFromStderr('Error: Rate Limit reached, retry later.\n');
    assert.ok(tag);
    assert.equal(tag!.source, 'stderr-pattern');
  });

  it('matches 429 status code', () => {
    const tag = detectRateLimitFromStderr('HTTP/1.1 429 Too Many Requests\n');
    assert.ok(tag);
  });

  it('matches "usage limit" phrasing', () => {
    const tag = detectRateLimitFromStderr('Your usage limit has been reached for today.\n');
    assert.ok(tag);
  });

  it('returns null on ordinary stderr', () => {
    const tag = detectRateLimitFromStderr('[babysitter] MCP proxy server listening on port 12345\n');
    assert.equal(tag, null);
  });

  it('bounds the detail excerpt to 200 characters', () => {
    const longLine = 'rate limit exceeded: ' + 'x'.repeat(500);
    const tag = detectRateLimitFromStderr(longLine);
    assert.ok(tag);
    assert.ok((tag!.detail ?? '').length <= 200);
  });
});

// ── exit code detection ────────────────────────────────────────────

describe('detectRateLimitFromExitCode()', () => {
  it('tags the distinguished exit code', () => {
    const tag = detectRateLimitFromExitCode(RATE_LIMIT_EXIT_CODE);
    assert.ok(tag);
    assert.equal(tag!.source, 'exit-code');
  });

  it('returns null for exit code 0', () => {
    assert.equal(detectRateLimitFromExitCode(0), null);
  });

  it('returns null for generic non-zero exit codes', () => {
    assert.equal(detectRateLimitFromExitCode(1), null);
    assert.equal(detectRateLimitFromExitCode(137), null);
  });
});

// ── parseStreamJsonMessage cascade integration ──────────────────────

describe('parseStreamJsonMessage() rate-limit accumulation', () => {
  it('writes a terminationTag on the accumulator when it sees a rate-limit subtype', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({ type: 'result', subtype: 'rate_limit_error' }, acc);
    assert.ok(acc.terminationTag);
    assert.equal(acc.terminationTag!.kind, 'rate-limit');
  });

  it('is first-wins — a later success does not clear the tag', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({ is_error: true, error: '429 rate limit' }, acc);
    parseStreamJsonMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'after' }] },
    }, acc);
    assert.ok(acc.terminationTag);
    assert.equal(acc.terminationTag!.source, 'ndjson-result');
  });

  it('leaves terminationTag undefined on an ordinary happy-path transcript', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done' }] },
    }, acc);
    parseStreamJsonMessage({
      type: 'result',
      total_cost_usd: 0.05,
      session_id: 'sess-42',
      usage: { input_tokens: 10, output_tokens: 5 },
    }, acc);
    assert.equal(acc.terminationTag, undefined);
  });
});

// ── resolveTerminalStatus cascade ───────────────────────────────────

describe('resolveTerminalStatus()', () => {
  it('honours a cancel override over everything else', () => {
    const result: StreamJsonResult = {
      exitCode: RATE_LIMIT_EXIT_CODE,
      transcript: [],
      terminationTag: { kind: 'rate-limit', source: 'ndjson-result' },
    };
    const resolved = resolveTerminalStatus(result, 'cancelled');
    assert.equal(resolved.status, 'cancelled');
    assert.equal(resolved.terminationTag, undefined);
  });

  it('promotes a pre-populated NDJSON termination tag to rate-limited even on exit 0', () => {
    const result: StreamJsonResult = {
      exitCode: 0,
      transcript: [],
      terminationTag: { kind: 'rate-limit', source: 'ndjson-result', detail: 'rate_limit_error' },
    };
    const resolved = resolveTerminalStatus(result);
    assert.equal(resolved.status, 'rate-limited');
    assert.ok(resolved.terminationTag);
    assert.equal(resolved.terminationTag!.source, 'ndjson-result');
  });

  it('falls back to the distinguished exit-code branch when no tag is present', () => {
    const result: StreamJsonResult = {
      exitCode: RATE_LIMIT_EXIT_CODE,
      transcript: [],
    };
    const resolved = resolveTerminalStatus(result);
    assert.equal(resolved.status, 'rate-limited');
    assert.ok(resolved.terminationTag);
    assert.equal(resolved.terminationTag!.source, 'exit-code');
  });

  it('returns completed for exit 0 with no rate-limit signal', () => {
    const resolved = resolveTerminalStatus({ exitCode: 0, transcript: [] });
    assert.equal(resolved.status, 'completed');
    assert.equal(resolved.terminationTag, undefined);
  });

  it('returns failed for a generic non-zero exit code', () => {
    const resolved = resolveTerminalStatus({ exitCode: 1, transcript: [] });
    assert.equal(resolved.status, 'failed');
    assert.match(resolved.error ?? '', /exited with code 1/);
    assert.equal(resolved.terminationTag, undefined);
  });
});
