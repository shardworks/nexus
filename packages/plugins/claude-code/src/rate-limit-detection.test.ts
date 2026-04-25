/**
 * Tests for rate-limit signature detection in the claude-code provider.
 *
 * The active detector is structural NDJSON inspection — the two branches
 * of `detectRateLimitFromNdjson` (subtype / is_error). The previous
 * stderr-pattern and exit-code branches were retired after producing
 * false-positive pauses; this file also pins the narrowed behaviour of
 * `resolveTerminalStatus`, which now maps non-zero exits to `'failed'`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectRateLimitFromNdjson,
  parseStreamJsonMessage,
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

  it('tags an assistant message carrying a top-level error: "rate_limit" field', () => {
    // Observed live shape for claude rate-limit termination: a regular
    // assistant message with `error: "rate_limit"` at the top level
    // (peer of `message`), no `is_error` flag, no subtype.
    const tag = detectRateLimitFromNdjson({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "You've hit your limit · resets 11:20pm (UTC)" }],
      },
      error: 'rate_limit',
    });
    assert.ok(tag);
    assert.equal(tag!.kind, 'rate-limit');
    assert.equal(tag!.source, 'ndjson-result');
    assert.match(tag!.detail ?? '', /rate_limit/);
  });

  it('does NOT tag a message whose top-level error text is unrelated', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'oops' }] },
      error: 'invalid_request',
    });
    assert.equal(tag, null);
  });

  it('does NOT tag a result message whose `result` text mentions rate limit', () => {
    // The prose `result`-text branch was removed because it matched an
    // assistant's summary of a prior rate-limit event and paused the
    // guild on a false positive.
    const tag = detectRateLimitFromNdjson({
      type: 'result',
      result: 'Error: Rate limit exceeded. Please try again later.',
    });
    assert.equal(tag, null);
  });

  it('returns null on ordinary assistant messages', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    assert.equal(tag, null);
  });

  it('returns null on a result message without matching error text', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'result',
      result: 'Done!',
      total_cost_usd: 0.01,
    });
    assert.equal(tag, null);
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
      exitCode: 7,
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

  it('maps a generic non-zero exit code to failed (exit-code branch retired)', () => {
    const resolved = resolveTerminalStatus({ exitCode: 7, transcript: [] });
    assert.equal(resolved.status, 'failed');
    assert.equal(resolved.terminationTag, undefined);
    assert.match(resolved.error ?? '', /exited with code 7/);
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
