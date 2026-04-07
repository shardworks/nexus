/**
 * Tests for the Copilot session provider apparatus.
 *
 * Uses Node's built-in test runner and mocks globalThis.fetch to avoid
 * real network calls. Covers all requirements specified in the plan.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { z } from 'zod';

import {
  createCopilotProvider,
  convertTools,
  extractOutput,
  parseSseLines,
} from './index.ts';

import type { CopilotConfig } from './index.ts';
import type { SessionProviderConfig } from '@shardworks/animator-apparatus';
import type { ResolvedTool } from '@shardworks/tools-apparatus';

// ── Test helpers ────────────────────────────────────────────────────

/** Build a minimal SessionProviderConfig for testing. */
function makeConfig(overrides: Partial<SessionProviderConfig> = {}): SessionProviderConfig {
  return {
    model: 'gpt-4o',
    cwd: '/tmp',
    ...overrides,
  };
}

/** Build a minimal ResolvedTool for testing. */
function makeTool(
  name: string,
  handler: (params: Record<string, unknown>) => unknown = () => 'tool result',
): ResolvedTool {
  return {
    definition: {
      name,
      description: `Tool ${name}`,
      params: z.object({ input: z.string().optional() }),
      handler: handler as (params: unknown) => unknown,
    },
    pluginId: 'test',
  };
}

/** Build a non-streaming ChatCompletionResponse. */
function makeApiResponse(
  content: string | null,
  options: {
    id?: string;
    toolCalls?: Array<{ id: string; name: string; args: string }>;
    promptTokens?: number;
    completionTokens?: number;
  } = {},
) {
  const id = options.id ?? 'chatcmpl-test123';
  return {
    id,
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content,
          ...(options.toolCalls
            ? {
                tool_calls: options.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.args },
                })),
              }
            : {}),
        },
        finish_reason: options.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: options.promptTokens ?? 100,
      completion_tokens: options.completionTokens ?? 50,
    },
  };
}

/** Build an SSE stream body from array of ChatCompletionChunk JSON objects. */
function makeSseStream(chunks: object[], done = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}\n`);
  }
  if (done) lines.push('data: [DONE]\n');
  const body = lines.join('');

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

/** Mock global fetch. Returns a cleanup function that restores the original. */
function mockFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

/** Collect all chunks from an async iterable. */
async function collectChunks<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

// ── Guild mock ──────────────────────────────────────────────────────

// We mock guild() to return a minimal GuildConfig. The apparatus reads
// guild().guildConfig().copilot in start(), which we call manually in tests.

let mockCopilotConfig: CopilotConfig = {};

// Patch guild module to return controlled config
import { setGuild } from '@shardworks/nexus-core';

// Set up a minimal mock guild before tests
function setupGuild(copilotConfig: CopilotConfig = {}) {
  mockCopilotConfig = copilotConfig;
  setGuild({
    home: '/tmp/test-guild',
    guildConfig: () => ({
      name: 'test-guild',
      nexus: '0.0.0',
      plugins: [],
      copilot: mockCopilotConfig,
    }),
    apparatus: <T>(_name: string): T => { throw new Error('not implemented'); },
    config: <T>(_pluginId: string): T => ({} as T),
    writeConfig: () => {},
    kits: () => [],
    apparatuses: () => [],
    failedPlugins: () => [],
  });
}

// ── Helper: create and start a provider ────────────────────────────

function createStartedProvider(copilotConfig: CopilotConfig = {}) {
  setupGuild(copilotConfig);
  const plugin = createCopilotProvider();
  if (!('apparatus' in plugin)) throw new Error('Expected apparatus plugin');
  plugin.apparatus.start({ on: () => {} });
  return plugin.apparatus.provides as import('@shardworks/animator-apparatus').AnimatorSessionProvider;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('convertTools', () => {
  it('converts ResolvedTool array to OpenAI function tool format', () => {
    const tools = [
      makeTool('search'),
      makeTool('compute'),
    ];
    const result = convertTools(tools);

    assert.equal(result.length, 2);
    assert.equal(result[0]!.type, 'function');
    assert.equal(result[0]!.function.name, 'search');
    assert.equal(result[0]!.function.description, 'Tool search');
    assert.ok(typeof result[0]!.function.parameters === 'object');
    assert.equal(result[1]!.function.name, 'compute');
  });

  it('produces valid JSON Schema from Zod schema', () => {
    const tool = {
      ...makeTool('test'),
      definition: {
        ...makeTool('test').definition,
        params: z.object({
          query: z.string().describe('Search query'),
          limit: z.number().optional(),
        }),
      },
    };
    const [converted] = convertTools([tool]);
    const params = converted!.function.parameters;

    // Should be a JSON Schema object
    assert.equal((params as { type: string }).type, 'object');
    assert.ok('properties' in params);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(convertTools([]), []);
  });
});

describe('extractOutput', () => {
  it('returns content of the last assistant message with no tool_calls', () => {
    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'world' },
    ];
    assert.equal(extractOutput(messages), 'world');
  });

  it('skips assistant messages that have tool_calls', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool' as const, content: 'result', tool_call_id: 'c1' },
      { role: 'assistant' as const, content: 'final answer' },
    ];
    assert.equal(extractOutput(messages), 'final answer');
  });

  it('returns undefined when no suitable assistant message exists', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    assert.equal(extractOutput(messages), undefined);
  });

  it('returns undefined when last assistant message has null content', () => {
    const messages = [
      { role: 'assistant' as const, content: null },
    ];
    assert.equal(extractOutput(messages), undefined);
  });
});

describe('parseSseLines', () => {
  it('parses data lines and calls handler', () => {
    const received: string[] = [];
    const remaining = parseSseLines(
      'data: {"hello":"world"}\ndata: {"foo":"bar"}\n',
      (d) => received.push(d),
    );
    assert.deepEqual(received, ['{"hello":"world"}', '{"foo":"bar"}']);
    assert.equal(remaining, '');
  });

  it('skips [DONE] sentinel', () => {
    const received: string[] = [];
    parseSseLines('data: {"text":"hi"}\ndata: [DONE]\n', (d) => received.push(d));
    assert.deepEqual(received, ['{"text":"hi"}']);
  });

  it('ignores non-data lines (empty, comments, event:)', () => {
    const received: string[] = [];
    parseSseLines('event: message\ndata: {"ok":true}\n: comment\n\n', (d) => received.push(d));
    assert.deepEqual(received, ['{"ok":true}']);
  });

  it('returns incomplete last line as remaining buffer', () => {
    const received: string[] = [];
    const remaining = parseSseLines('data: {"a":1}\ndata: {"b"', (d) => received.push(d));
    assert.deepEqual(received, ['{"a":1}']);
    assert.equal(remaining, 'data: {"b"');
  });
});

describe('createCopilotProvider', () => {
  it('returns a plugin with apparatus.provides having name "copilot"', () => {
    setupGuild();
    const plugin = createCopilotProvider();
    assert.ok('apparatus' in plugin);
    const provider = plugin.apparatus.provides as { name: string };
    assert.equal(provider.name, 'copilot');
  });

  it('reads copilot config from guild at start() time', () => {
    // Just verify start() doesn't throw; the config is used during launch()
    const provider = createStartedProvider({ tokenEnvVar: 'MY_TOKEN', maxToolRounds: 5 });
    assert.equal(provider.name, 'copilot');
  });
});

describe('launch() — missing token', () => {
  it('throws when the token env var is missing', async () => {
    const provider = createStartedProvider({ tokenEnvVar: 'MISSING_TOKEN_XYZ' });
    delete process.env['MISSING_TOKEN_XYZ'];

    const { result } = provider.launch(makeConfig());
    await assert.rejects(result, /MISSING_TOKEN_XYZ/);
  });

  it('uses GITHUB_TOKEN by default', async () => {
    const provider = createStartedProvider();
    const savedToken = process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];

    const { result } = provider.launch(makeConfig());
    await assert.rejects(result, /GITHUB_TOKEN/);

    if (savedToken !== undefined) process.env['GITHUB_TOKEN'] = savedToken;
  });
});

describe('launch() — non-streaming single-turn', () => {
  let restoreToken: (() => void) | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = 'test-token';
    restoreToken = () => { delete process.env['GITHUB_TOKEN']; };
  });

  afterEach(() => {
    restoreToken?.();
    restoreFetch?.();
  });

  it('happy path: single-turn completion with no tools', async () => {
    const apiResp = makeApiResponse('Hello from the model', {
      id: 'chatcmpl-abc123',
      promptTokens: 120,
      completionTokens: 30,
    });

    restoreFetch = mockFetch(async (url, opts) => {
      assert.ok(String(url).includes('/chat/completions'));
      const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      assert.equal(body['model'], 'gpt-4o');
      assert.equal(body['stream'], false);
      assert.ok(!('tools' in body)); // No tools in request

      const msgs = body['messages'] as Array<{ role: string; content: string }>;
      assert.equal(msgs[0]!.role, 'system');
      assert.equal(msgs[0]!.content, 'You are a helpful assistant');
      assert.equal(msgs[1]!.role, 'user');
      assert.equal(msgs[1]!.content, 'Say hello');

      const headers = (opts as RequestInit).headers as Record<string, string>;
      assert.equal(headers['Authorization'], 'Bearer test-token');

      return new Response(JSON.stringify(apiResp), { status: 200 });
    });

    const provider = createStartedProvider();
    const { chunks, result } = provider.launch(makeConfig({
      systemPrompt: 'You are a helpful assistant',
      initialPrompt: 'Say hello',
    }));

    const chunkItems = await collectChunks(chunks);
    assert.equal(chunkItems.length, 0); // Non-streaming: no chunks

    const res = await result;
    assert.equal(res.status, 'completed');
    assert.equal(res.exitCode, 0);
    assert.equal(res.output, 'Hello from the model');
    assert.equal(res.providerSessionId, 'chatcmpl-abc123');
    assert.deepEqual(res.tokenUsage, { inputTokens: 120, outputTokens: 30 });
    assert.equal(res.costUsd, undefined);

    // Transcript: system, user, assistant
    assert.equal(res.transcript?.length, 3);
    assert.equal((res.transcript?.[0] as { role: string })?.role, 'system');
    assert.equal((res.transcript?.[1] as { role: string })?.role, 'user');
    assert.equal((res.transcript?.[2] as { role: string })?.role, 'assistant');
  });

  it('uses custom apiEndpoint from config', async () => {
    let capturedUrl = '';
    restoreFetch = mockFetch(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(makeApiResponse('ok')), { status: 200 });
    });

    const provider = createStartedProvider({ apiEndpoint: 'https://custom.endpoint.com' });
    const { result } = provider.launch(makeConfig({ initialPrompt: 'test' }));
    await result;

    assert.ok(capturedUrl.startsWith('https://custom.endpoint.com'));
  });

  it('ignores conversationId, cwd, and environment without errors', async () => {
    restoreFetch = mockFetch(async () =>
      new Response(JSON.stringify(makeApiResponse('ok')), { status: 200 }),
    );

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      conversationId: 'conv-123',
      cwd: '/some/path',
      environment: { FOO: 'bar' },
      initialPrompt: 'test',
    }));

    const res = await result;
    assert.equal(res.status, 'completed');
  });

  it('handles absent systemPrompt and initialPrompt', async () => {
    let capturedBody: Record<string, unknown> = {};
    restoreFetch = mockFetch(async (_, opts) => {
      capturedBody = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(makeApiResponse('ok')), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig());
    const res = await result;

    assert.equal(res.status, 'completed');
    assert.deepEqual(capturedBody['messages'], []); // Empty messages array
  });

  it('returns status: failed on HTTP error', async () => {
    restoreFetch = mockFetch(async () =>
      new Response('Unauthorized', { status: 401 }),
    );

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({ initialPrompt: 'hi' }));
    const res = await result;

    assert.equal(res.status, 'failed');
    assert.equal(res.exitCode, 1);
    assert.ok(res.error?.includes('401'));
  });

  it('returns status: failed on network failure (fetch throws)', async () => {
    restoreFetch = mockFetch(async () => {
      throw new Error('DNS resolution failed');
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({ initialPrompt: 'hi' }));
    const res = await result;

    assert.equal(res.status, 'failed');
    assert.equal(res.exitCode, 1);
    assert.ok(res.error?.includes('DNS resolution failed'));
  });
});

describe('launch() — agentic tool-call loop', () => {
  let restoreToken: (() => void) | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = 'test-token';
    restoreToken = () => { delete process.env['GITHUB_TOKEN']; };
  });

  afterEach(() => {
    restoreToken?.();
    restoreFetch?.();
  });

  it('happy path: tool-calling session with 2 API calls', async () => {
    const toolHandler = mock.fn((_params: unknown) => 'tool output from handler');
    const tool = makeTool('my-tool', toolHandler);

    let callCount = 0;
    restoreFetch = mockFetch(async (_, opts) => {
      callCount++;
      const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      const messages = body['messages'] as Array<{ role: string }>;

      if (callCount === 1) {
        // First call: return a response with tool_calls
        return new Response(JSON.stringify(makeApiResponse(null, {
          id: 'chatcmpl-round1',
          toolCalls: [{ id: 'call-1', name: 'my-tool', args: '{"input":"test"}' }],
          promptTokens: 100,
          completionTokens: 10,
        })), { status: 200 });
      }

      // Second call: verify tool result is included, return final response
      assert.ok(messages.some((m) => m.role === 'tool'));
      return new Response(JSON.stringify(makeApiResponse('Final answer', {
        id: 'chatcmpl-round2',
        promptTokens: 150,
        completionTokens: 20,
      })), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      initialPrompt: 'Use my-tool',
      tools: [tool],
    }));

    const res = await result;
    assert.equal(res.status, 'completed');
    assert.equal(res.exitCode, 0);
    assert.equal(res.output, 'Final answer');
    assert.equal(res.providerSessionId, 'chatcmpl-round2'); // Last response id
    assert.deepEqual(res.tokenUsage, { inputTokens: 250, outputTokens: 30 }); // Summed
    assert.equal(callCount, 2);
    assert.equal(toolHandler.mock.callCount(), 1);

    // Transcript: user, assistant(tool_calls), tool(result), assistant(final)
    assert.equal(res.transcript?.length, 4);
    assert.equal((res.transcript?.[0] as { role: string })?.role, 'user');
    assert.equal((res.transcript?.[1] as { role: string })?.role, 'assistant');
    assert.equal((res.transcript?.[2] as { role: string })?.role, 'tool');
    assert.equal((res.transcript?.[3] as { role: string })?.role, 'assistant');
  });

  it('includes tools array in API request when tools are provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    restoreFetch = mockFetch(async (_, opts) => {
      capturedBody = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(makeApiResponse('done')), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('search'), makeTool('write')],
      initialPrompt: 'go',
    }));
    await result;

    const tools = capturedBody['tools'] as Array<{ type: string; function: { name: string } }>;
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 2);
    assert.equal(tools[0]!.type, 'function');
    assert.equal(tools[0]!.function.name, 'search');
    assert.equal(tools[1]!.function.name, 'write');
  });

  it('handles tool handler error — sends error message back to model', async () => {
    const failingTool = makeTool('bad-tool', () => { throw new Error('database offline'); });

    let secondCallMessages: Array<{ role: string; content: string }> = [];
    let callCount = 0;
    restoreFetch = mockFetch(async (_, opts) => {
      callCount++;
      const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      if (callCount === 1) {
        return new Response(JSON.stringify(makeApiResponse(null, {
          toolCalls: [{ id: 'call-err', name: 'bad-tool', args: '{}' }],
        })), { status: 200 });
      }
      secondCallMessages = body['messages'] as Array<{ role: string; content: string }>;
      return new Response(JSON.stringify(makeApiResponse('OK despite error')), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      tools: [failingTool],
      initialPrompt: 'try bad-tool',
    }));

    const res = await result;
    assert.equal(res.status, 'completed'); // Session does NOT fail
    assert.equal(res.exitCode, 0);
    assert.equal(callCount, 2);

    // The tool result message should contain the error
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(toolMsg.content.includes('Error: database offline'));
  });

  it('handles unknown tool name — sends error message back to model', async () => {
    let secondCallMessages: Array<{ role: string; content: string }> = [];
    let callCount = 0;
    restoreFetch = mockFetch(async (_, opts) => {
      callCount++;
      const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      if (callCount === 1) {
        return new Response(JSON.stringify(makeApiResponse(null, {
          toolCalls: [{ id: 'call-x', name: 'nonexistent-tool', args: '{}' }],
        })), { status: 200 });
      }
      secondCallMessages = body['messages'] as Array<{ role: string; content: string }>;
      return new Response(JSON.stringify(makeApiResponse('Handled unknown tool')), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('known-tool')],
      initialPrompt: 'try nonexistent',
    }));

    const res = await result;
    assert.equal(res.status, 'completed');

    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
    assert.ok(toolMsg?.content.includes('Unknown tool: nonexistent-tool'));
  });

  it('enforces maxToolRounds — stops after limit and completes normally', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      // Always return tool_calls to trigger more rounds
      return new Response(JSON.stringify(makeApiResponse(null, {
        id: `chatcmpl-round${callCount}`,
        toolCalls: [{ id: `call-${callCount}`, name: 'loop-tool', args: '{}' }],
      })), { status: 200 });
    });

    const provider = createStartedProvider({ maxToolRounds: 3 });
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('loop-tool')],
      initialPrompt: 'loop forever',
    }));

    const res = await result;
    assert.equal(res.status, 'completed'); // Completes normally, not as failure
    assert.equal(res.exitCode, 0);
    // Initial call + 3 rounds = 4 total calls
    assert.equal(callCount, 4);
  });

  it('accumulates token usage across multiple rounds', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount <= 3) {
        return new Response(JSON.stringify(makeApiResponse(null, {
          toolCalls: [{ id: `c${callCount}`, name: 'counter', args: '{}' }],
          promptTokens: 100,
          completionTokens: 50,
        })), { status: 200 });
      }
      return new Response(JSON.stringify(makeApiResponse('done', {
        promptTokens: 100,
        completionTokens: 50,
      })), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('counter')],
      initialPrompt: 'count',
    }));

    const res = await result;
    // 4 API calls × 100 input + 4 × 50 output = 400/200
    assert.deepEqual(res.tokenUsage, { inputTokens: 400, outputTokens: 200 });
    assert.equal(res.costUsd, undefined);
  });

  it('uses providerSessionId from the last API response', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(makeApiResponse(null, {
          id: 'chatcmpl-first',
          toolCalls: [{ id: 'c1', name: 'tool', args: '{}' }],
        })), { status: 200 });
      }
      return new Response(JSON.stringify(makeApiResponse('done', { id: 'chatcmpl-last' })), { status: 200 });
    });

    const provider = createStartedProvider();
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('tool')],
      initialPrompt: 'run tool',
    }));

    const res = await result;
    assert.equal(res.providerSessionId, 'chatcmpl-last');
  });
});

describe('launch() — streaming', () => {
  let restoreToken: (() => void) | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = 'test-token';
    restoreToken = () => { delete process.env['GITHUB_TOKEN']; };
  });

  afterEach(() => {
    restoreToken?.();
    restoreFetch?.();
  });

  it('yields text chunks from streamed response', async () => {
    const streamChunks = [
      { id: 'chatcmpl-s1', choices: [{ delta: { content: 'Hello' }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-s1', choices: [{ delta: { content: ' world' }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-s1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];

    restoreFetch = mockFetch(async (_, opts) => {
      const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
      assert.equal(body['stream'], true);
      assert.ok((body['stream_options'] as Record<string, unknown>)?.['include_usage']);
      return new Response(makeSseStream(streamChunks), { status: 200 });
    });

    const provider = createStartedProvider();
    const { chunks, result } = provider.launch(makeConfig({
      streaming: true,
      initialPrompt: 'hi',
    }));

    const received = await collectChunks(chunks);
    const res = await result;

    assert.deepEqual(received, [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ]);
    assert.equal(res.status, 'completed');
    assert.equal(res.output, 'Hello world');
    assert.deepEqual(res.tokenUsage, { inputTokens: 10, outputTokens: 5 });
  });

  it('yields tool_use chunk when tool call is streamed', async () => {
    const streamChunks = [
      {
        id: 'chatcmpl-t1',
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call-123', type: 'function', function: { name: 'my-tool', arguments: '' } }],
          },
          finish_reason: null,
        }],
        usage: null,
      },
      {
        id: 'chatcmpl-t1',
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"input":"test"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: null,
      },
      { id: 'chatcmpl-t1', choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ];

    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(makeSseStream(streamChunks), { status: 200 });
      }
      // Second call: return text response
      const finalChunks = [
        { id: 'chatcmpl-t2', choices: [{ delta: { content: 'Tool done' }, finish_reason: null }], usage: null },
        { id: 'chatcmpl-t2', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 15 } },
      ];
      return new Response(makeSseStream(finalChunks), { status: 200 });
    });

    const provider = createStartedProvider();
    const { chunks, result } = provider.launch(makeConfig({
      streaming: true,
      tools: [makeTool('my-tool')],
      initialPrompt: 'use my-tool',
    }));

    const received = await collectChunks(chunks);
    const res = await result;

    // Should have: tool_use chunk, tool_result chunk, text chunk
    const toolUseChunks = received.filter((c) => c.type === 'tool_use');
    const toolResultChunks = received.filter((c) => c.type === 'tool_result');
    const textChunks = received.filter((c) => c.type === 'text');

    assert.equal(toolUseChunks.length, 1);
    assert.equal((toolUseChunks[0] as { type: string; tool: string })?.tool, 'my-tool');
    assert.equal(toolResultChunks.length, 1);
    assert.equal((toolResultChunks[0] as { type: string; tool: string })?.tool, 'call-123');
    assert.equal(textChunks.length, 1);
    assert.equal((textChunks[0] as { type: string; text: string })?.text, 'Tool done');

    assert.equal(res.status, 'completed');
    // Token usage summed across both calls
    assert.deepEqual(res.tokenUsage, { inputTokens: 50, outputTokens: 25 });
  });

  it('returns failed result on streaming API error', async () => {
    restoreFetch = mockFetch(async () =>
      new Response('Forbidden', { status: 403 }),
    );

    const provider = createStartedProvider();
    const { chunks, result } = provider.launch(makeConfig({
      streaming: true,
      initialPrompt: 'hi',
    }));

    const received = await collectChunks(chunks);
    const res = await result;

    assert.equal(received.length, 0);
    assert.equal(res.status, 'failed');
    assert.equal(res.exitCode, 1);
    assert.ok(res.error?.includes('403'));
  });

  it('non-streaming returns empty chunks iterable', async () => {
    restoreFetch = mockFetch(async () =>
      new Response(JSON.stringify(makeApiResponse('done')), { status: 200 }),
    );

    const provider = createStartedProvider();
    const { chunks, result } = provider.launch(makeConfig({
      streaming: false,
      initialPrompt: 'hi',
    }));

    const received = await collectChunks(chunks);
    assert.equal(received.length, 0);

    const res = await result;
    assert.equal(res.status, 'completed');
  });
});

describe('config defaults', () => {
  let restoreToken: (() => void) | undefined;
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    process.env['GITHUB_TOKEN'] = 'test-token';
    restoreToken = () => { delete process.env['GITHUB_TOKEN']; };
  });

  afterEach(() => {
    restoreToken?.();
    restoreFetch?.();
  });

  it('uses default endpoint when copilot config is absent', async () => {
    let capturedUrl = '';
    restoreFetch = mockFetch(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(makeApiResponse('ok')), { status: 200 });
    });

    const provider = createStartedProvider(); // No copilot config
    const { result } = provider.launch(makeConfig({ initialPrompt: 'hi' }));
    await result;

    assert.ok(capturedUrl.startsWith('https://models.inference.ai.azure.com'));
  });

  it('uses default maxToolRounds of 50', async () => {
    let callCount = 0;
    restoreFetch = mockFetch(async () => {
      callCount++;
      // Always return tool_calls
      return new Response(JSON.stringify(makeApiResponse(null, {
        toolCalls: [{ id: `c${callCount}`, name: 't', args: '{}' }],
      })), { status: 200 });
    });

    const provider = createStartedProvider(); // No maxToolRounds config
    const { result } = provider.launch(makeConfig({
      tools: [makeTool('t')],
      initialPrompt: 'loop',
    }));

    const res = await result;
    assert.equal(res.status, 'completed');
    // Initial call + 50 rounds = 51 total
    assert.equal(callCount, 51);
  });

  it('uses custom config values', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    restoreFetch = mockFetch(async (url, opts) => {
      capturedUrl = String(url);
      capturedAuth = ((opts as RequestInit).headers as Record<string, string>)['Authorization'] ?? '';
      return new Response(JSON.stringify(makeApiResponse('ok')), { status: 200 });
    });

    process.env['MY_CUSTOM_TOKEN'] = 'custom-token-value';
    const provider = createStartedProvider({
      apiEndpoint: 'https://custom.endpoint.com',
      tokenEnvVar: 'MY_CUSTOM_TOKEN',
    });
    const { result } = provider.launch(makeConfig({ initialPrompt: 'hi' }));
    await result;

    assert.ok(capturedUrl.startsWith('https://custom.endpoint.com'));
    assert.equal(capturedAuth, 'Bearer custom-token-value');
    delete process.env['MY_CUSTOM_TOKEN'];
  });
});
