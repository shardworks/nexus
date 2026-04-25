/**
 * Tests for rate-limit signature detection in the claude-code provider.
 *
 * The active detector is a single evidence-driven branch:
 * `detectRateLimitFromNdjson` matches the rate-limit pattern against
 * the top-level `error` field of an NDJSON message — the shape claude
 * actually emits on rate-limited assistant termination. Two earlier
 * speculative branches (`subtype` substring, `is_error: true` + error
 * text) were retired after observation showed no live provider emission
 * fires either path; the previous stderr-pattern and exit-code branches
 * had been retired earlier for false-positive pauses. This file also
 * pins the narrowed behaviour of `resolveTerminalStatus`, which maps
 * non-zero exits to `'failed'`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectRateLimitFromNdjson,
  parseStreamJsonMessage,
  type StreamJsonResult,
} from './index.ts';
import { resolveTerminalStatus } from './runtime.ts';
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
  it('tags an assistant message carrying a top-level error: "rate_limit" field', () => {
    // Live observed shape for claude rate-limit termination: an
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

  it('matches the broader rate-limit pattern (e.g. 429) on the top-level error field', () => {
    const tag = detectRateLimitFromNdjson({ error: 'HTTP 429: too many requests' });
    assert.ok(tag);
    assert.equal(tag!.source, 'ndjson-result');
  });

  it('does NOT tag a message whose top-level error text is unrelated', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'oops' }] },
      error: 'invalid_request',
    });
    assert.equal(tag, null);
  });

  it('does NOT tag a `result`-text branch (retired — false-positive on assistant prose summaries)', () => {
    const tag = detectRateLimitFromNdjson({
      type: 'result',
      result: 'Error: Rate limit exceeded. Please try again later.',
    });
    assert.equal(tag, null);
  });

  it('does NOT tag a speculative subtype-only shape (retired — never observed)', () => {
    // The `subtype: "rate_limit_error"` shape was an early speculative
    // branch retained through one narrowing pass and then dropped after
    // no live emission was observed against it. Add it back with a real
    // example if the provider's shape ever requires it.
    const tag = detectRateLimitFromNdjson({ type: 'result', subtype: 'rate_limit_error' });
    assert.equal(tag, null);
  });

  it('does NOT tag a speculative is_error+error-text shape (retired — never observed)', () => {
    const tag = detectRateLimitFromNdjson({ is_error: true, error: 'HTTP 429: rate limit' });
    // Note: this shape WOULD match the new top-level-error branch
    // because `error` is a string with rate-limit text. The retirement
    // is about not requiring `is_error: true` as a gate — the active
    // branch fires on any top-level `error` matching the pattern.
    assert.ok(tag); // top-level branch fires here regardless of is_error
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
  it('writes a terminationTag on the accumulator when it sees a top-level error: "rate_limit"', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'limit hit' }] },
      error: 'rate_limit',
    }, acc);
    assert.ok(acc.terminationTag);
    assert.equal(acc.terminationTag!.kind, 'rate-limit');
  });

  it('is first-wins — a later success does not clear the tag', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({ error: 'rate_limit' }, acc);
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
      terminationTag: { kind: 'rate-limit', source: 'ndjson-result', detail: 'rate_limit' },
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
