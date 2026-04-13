/**
 * Tests for the NDJSON stream parsing logic in the Claude Code session provider.
 *
 * Exercises parseStreamJsonMessage() and processNdjsonBuffer() — the pure
 * functions that parse Claude's --output-format stream-json output into
 * SessionChunks and accumulated metrics.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStreamJsonMessage,
  processNdjsonBuffer,
  extractFinalAssistantText,
  type StreamJsonResult,
} from './index.ts';

// ── Helper ──────────────────────────────────────────────────────────

function freshAcc(): {
  transcript: Record<string, unknown>[];
  costUsd?: number;
  tokenUsage?: StreamJsonResult['tokenUsage'];
  providerSessionId?: string;
} {
  return { transcript: [] };
}

// ── parseStreamJsonMessage ──────────────────────────────────────────

describe('parseStreamJsonMessage() purity', () => {
  const originalStderrWrite = process.stderr.write;
  let stderrCalls: string[];

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  function mockStderr() {
    stderrCalls = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  }

  it('does not write to stderr for assistant text blocks', () => {
    mockStderr();
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello world' },
        ],
      },
    }, acc);

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { type: 'text', text: 'Hello world' });
    assert.equal(stderrCalls.length, 0, 'parseStreamJsonMessage should not write to stderr');
  });

  it('does not write to stderr for tool_use blocks', () => {
    mockStderr();
    const acc = freshAcc();
    parseStreamJsonMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'bash' },
        ],
      },
    }, acc);

    assert.equal(stderrCalls.length, 0, 'parseStreamJsonMessage should not write to stderr');
  });
});

describe('parseStreamJsonMessage()', () => {
  it('parses assistant text content into text chunks', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello world' },
        ],
      },
    }, acc);

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { type: 'text', text: 'Hello world' });
    assert.equal(acc.transcript.length, 1);
  });

  it('parses assistant tool_use into tool_use chunks', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'bash' },
        ],
      },
    }, acc);

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { type: 'tool_use', tool: 'bash' });
  });

  it('parses multiple content blocks in one message', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me run that.' },
          { type: 'tool_use', name: 'bash' },
        ],
      },
    }, acc);

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.type, 'text');
    assert.equal(chunks[1]!.type, 'tool_use');
  });

  it('parses user tool_result into tool_result chunks', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_abc123' },
      ],
    }, acc);

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], { type: 'tool_result', tool: 'tu_abc123' });
  });

  it('extracts cost and token usage from result message', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'result',
      total_cost_usd: 0.42,
      session_id: 'sess-xyz',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 100,
      },
    }, acc);

    assert.equal(chunks.length, 0);
    assert.equal(acc.costUsd, 0.42);
    assert.equal(acc.providerSessionId, 'sess-xyz');
    assert.deepEqual(acc.tokenUsage, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });
  });

  it('handles result message without optional usage fields', () => {
    const acc = freshAcc();
    parseStreamJsonMessage({
      type: 'result',
      total_cost_usd: 0.10,
      usage: {
        input_tokens: 500,
        output_tokens: 100,
      },
    }, acc);

    assert.equal(acc.costUsd, 0.10);
    assert.equal(acc.tokenUsage!.cacheReadTokens, undefined);
    assert.equal(acc.tokenUsage!.cacheWriteTokens, undefined);
  });

  it('handles assistant message with no content blocks', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
      message: {},
    }, acc);

    assert.equal(chunks.length, 0);
    assert.equal(acc.transcript.length, 1);
  });

  it('handles assistant message with no message field', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'assistant',
    }, acc);

    assert.equal(chunks.length, 0);
    assert.equal(acc.transcript.length, 1);
  });

  it('ignores unknown message types', () => {
    const acc = freshAcc();
    const chunks = parseStreamJsonMessage({
      type: 'system',
      data: 'something',
    }, acc);

    assert.equal(chunks.length, 0);
    assert.equal(acc.transcript.length, 0);
  });

  it('accumulates across multiple calls', () => {
    const acc = freshAcc();

    parseStreamJsonMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Part 1' }] },
    }, acc);

    parseStreamJsonMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Part 2' }] },
    }, acc);

    parseStreamJsonMessage({
      type: 'result',
      total_cost_usd: 0.50,
      session_id: 'sess-123',
      usage: { input_tokens: 2000, output_tokens: 800 },
    }, acc);

    assert.equal(acc.transcript.length, 2);
    assert.equal(acc.costUsd, 0.50);
    assert.equal(acc.providerSessionId, 'sess-123');
  });
});

// ── extractFinalAssistantText ───────────────────────────────────────

describe('extractFinalAssistantText()', () => {
  it('returns undefined for empty transcript', () => {
    assert.equal(extractFinalAssistantText([]), undefined);
  });

  it('returns undefined when no assistant messages', () => {
    const transcript = [
      { type: 'result', total_cost_usd: 0.01 },
    ];
    assert.equal(extractFinalAssistantText(transcript), undefined);
  });

  it('extracts text from the last assistant message', () => {
    const transcript = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First response' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Final response' }] },
      },
    ];
    assert.equal(extractFinalAssistantText(transcript), 'Final response');
  });

  it('concatenates multiple text blocks from the last assistant message', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Part one. ' },
            { type: 'tool_use', name: 'bash' },
            { type: 'text', text: 'Part two.' },
          ],
        },
      },
    ];
    assert.equal(extractFinalAssistantText(transcript), 'Part one. Part two.');
  });

  it('skips non-text content blocks', () => {
    const transcript = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'bash' },
          ],
        },
      },
    ];
    assert.equal(extractFinalAssistantText(transcript), undefined);
  });

  it('skips earlier assistant messages and uses the last', () => {
    const transcript = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Earlier' }] },
      },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Later' }] },
      },
      { type: 'result', total_cost_usd: 0.05 },
    ];
    assert.equal(extractFinalAssistantText(transcript), 'Later');
  });

  it('returns undefined for assistant message with no content', () => {
    const transcript = [
      { type: 'assistant', message: {} },
    ];
    assert.equal(extractFinalAssistantText(transcript), undefined);
  });

  it('returns undefined for assistant message with no message field', () => {
    const transcript = [
      { type: 'assistant' },
    ];
    assert.equal(extractFinalAssistantText(transcript), undefined);
  });
});

// ── processNdjsonBuffer ─────────────────────────────────────────────

describe('processNdjsonBuffer()', () => {
  it('processes complete lines and returns empty remainder', () => {
    const messages: Record<string, unknown>[] = [];
    const remainder = processNdjsonBuffer(
      '{"type":"assistant"}\n{"type":"result"}\n',
      (msg) => messages.push(msg),
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.type, 'assistant');
    assert.equal(messages[1]!.type, 'result');
    assert.equal(remainder, '');
  });

  it('returns incomplete trailing data as remainder', () => {
    const messages: Record<string, unknown>[] = [];
    const remainder = processNdjsonBuffer(
      '{"type":"assistant"}\n{"type":"res',
      (msg) => messages.push(msg),
    );

    assert.equal(messages.length, 1);
    assert.equal(remainder, '{"type":"res');
  });

  it('handles empty buffer', () => {
    const messages: Record<string, unknown>[] = [];
    const remainder = processNdjsonBuffer('', (msg) => messages.push(msg));

    assert.equal(messages.length, 0);
    assert.equal(remainder, '');
  });

  it('skips blank lines', () => {
    const messages: Record<string, unknown>[] = [];
    const remainder = processNdjsonBuffer(
      '{"type":"a"}\n\n\n{"type":"b"}\n',
      (msg) => messages.push(msg),
    );

    assert.equal(messages.length, 2);
    assert.equal(remainder, '');
  });

  it('skips non-JSON lines without throwing', () => {
    const messages: Record<string, unknown>[] = [];
    const remainder = processNdjsonBuffer(
      'not-json-at-all\n{"type":"ok"}\n',
      (msg) => messages.push(msg),
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.type, 'ok');
    assert.equal(remainder, '');
  });

  it('handles multiple chunks arriving incrementally', () => {
    const messages: Record<string, unknown>[] = [];
    const handler = (msg: Record<string, unknown>) => messages.push(msg);

    let buf = processNdjsonBuffer('{"type":', handler);
    assert.equal(messages.length, 0);

    buf = processNdjsonBuffer(buf + '"assistant"}\n', handler);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.type, 'assistant');
    assert.equal(buf, '');
  });
});
