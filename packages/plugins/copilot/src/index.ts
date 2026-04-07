/**
 * Copilot Session Provider
 *
 * Apparatus plugin that implements AnimatorSessionProvider using the
 * GitHub Models REST API (OpenAI-compatible). The Animator discovers
 * this via guild config:
 *
 *   guild.json["animator"]["sessionProvider"] = "copilot"
 *
 * Calls the chat completions endpoint, runs an in-process agentic
 * tool-call loop when tools are supplied, and supports streaming via SSE.
 *
 * Key design choice: calls tool handlers directly in-process (no MCP server).
 * This is simpler than the claude-code approach since we control the API
 * request/response cycle directly.
 */

import { z } from 'zod';

import { guild } from '@shardworks/nexus-core';
import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import type {
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
} from '@shardworks/animator-apparatus';
import type { ResolvedTool } from '@shardworks/tools-apparatus';

// ── Config types ────────────────────────────────────────────────────

/** Plugin configuration stored at guild.json["copilot"]. */
export interface CopilotConfig {
  /**
   * Chat completions API base endpoint URL.
   * Default: 'https://models.inference.ai.azure.com'
   */
  apiEndpoint?: string;
  /**
   * Name of the environment variable holding the API bearer token.
   * Default: 'GITHUB_TOKEN'
   */
  tokenEnvVar?: string;
  /**
   * Maximum number of tool-call rounds in the agentic loop.
   * When reached, the session completes with the last available response.
   * Default: 50
   */
  maxToolRounds?: number;
}

// GuildConfig module augmentation — merged with other augmentations via declaration merging
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    copilot?: CopilotConfig;
  }
}

// ── Internal types ──────────────────────────────────────────────────

/** OpenAI-compatible chat completion message. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Index signature makes ChatMessage compatible with Record<string, unknown>. */
  [key: string]: unknown;
}

/** OpenAI-compatible tool call from an assistant response. */
interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI-compatible function tool definition for the API request. */
interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI-compatible chat completion response (non-streaming). */
interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/** OpenAI-compatible streaming chunk. */
interface ChatCompletionChunk {
  id: string;
  choices: Array<{
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  } | null;
}

/** A single transcript message entry. Matches the TranscriptMessage alias in animator types. */
type TranscriptEntry = Record<string, unknown>;

/** Accumulated metrics across API calls. */
interface SessionAccumulator {
  transcript: TranscriptEntry[];
  tokenUsage: { inputTokens: number; outputTokens: number };
  providerSessionId?: string;
}

// ── Tool conversion ─────────────────────────────────────────────────

/**
 * Convert ResolvedTool array to OpenAI function tool format.
 *
 * Uses z.toJSONSchema() to convert Zod params schema to JSON Schema.
 *
 * @internal Exported for testing only.
 */
export function convertTools(tools: ResolvedTool[]): ToolDef[] {
  return tools.map((rt) => ({
    type: 'function' as const,
    function: {
      name: rt.definition.name,
      description: rt.definition.description,
      parameters: z.toJSONSchema(rt.definition.params) as Record<string, unknown>,
    },
  }));
}

// ── Output extraction ───────────────────────────────────────────────

/**
 * Extract the output text from the last assistant message with no tool_calls.
 *
 * Walks the messages array backwards to find the last assistant message
 * that is a "final" response (no pending tool calls).
 *
 * @internal Exported for testing only.
 */
export function extractOutput(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    if (msg.tool_calls && msg.tool_calls.length > 0) continue;
    if (msg.content) return msg.content;
  }
  return undefined;
}

// ── SSE parsing ─────────────────────────────────────────────────────

/**
 * Parse SSE data lines from a buffer, invoking handler for each parsed data value.
 * Returns the remaining incomplete buffer.
 *
 * @internal Exported for testing only.
 */
export function parseSseLines(buffer: string, handler: (data: string) => void): string {
  let idx: number;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      handler(data);
    }
  }
  return buffer;
}

// ── API helpers ─────────────────────────────────────────────────────

/**
 * Make a non-streaming API call and return the parsed response.
 *
 * @throws When the HTTP response is not ok, with the status and body.
 */
async function callApi(
  apiEndpoint: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  apiTools: ToolDef[],
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${apiEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(apiTools.length > 0 ? { tools: apiTools } : {}),
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub Models API error: ${response.status} ${body}`);
  }

  return response.json() as Promise<ChatCompletionResponse>;
}

/**
 * Make a streaming API call, yielding chunks and returning the accumulated assistant message.
 *
 * Parses SSE events, yields SessionChunk objects in real time, and accumulates
 * tool call fragments across delta chunks. Returns the fully assembled assistant
 * message and final usage info.
 */
async function* callApiStreaming(
  apiEndpoint: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  apiTools: ToolDef[],
  acc: SessionAccumulator,
): AsyncGenerator<SessionChunk, ChatMessage, undefined> {
  const response = await fetch(`${apiEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(apiTools.length > 0 ? { tools: apiTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub Models API error: ${response.status} ${body}`);
  }

  if (!response.body) {
    throw new Error('GitHub Models API error: no response body for streaming request');
  }

  // Accumulate tool call fragments keyed by index
  const toolCallFragments = new Map<number, { id: string; name: string; arguments: string }>();
  let textContent = '';
  let lastId = '';
  let buffer = '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const chunks: ChatCompletionChunk[] = [];
      buffer = parseSseLines(buffer, (data) => {
        try {
          chunks.push(JSON.parse(data) as ChatCompletionChunk);
        } catch {
          // Skip malformed JSON
        }
      });

      for (const chunk of chunks) {
        if (chunk.id) lastId = chunk.id;

        // Accumulate usage from the final chunk (stream_options.include_usage)
        if (chunk.usage) {
          acc.tokenUsage.inputTokens += chunk.usage.prompt_tokens;
          acc.tokenUsage.outputTokens += chunk.usage.completion_tokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content delta
        if (delta.content != null && delta.content !== '') {
          textContent += delta.content;
          process.stderr.write(delta.content);
          yield { type: 'text', text: delta.content };
        }

        // Tool call deltas — accumulate by index
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallFragments.get(tc.index);
            if (!existing) {
              // First fragment for this tool call — must have id and name
              const frag = {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              };
              toolCallFragments.set(tc.index, frag);
              if (frag.name) {
                yield { type: 'tool_use', tool: frag.name };
              }
            } else {
              // Subsequent fragment — accumulate arguments and fill in missing fields
              if (tc.id && !existing.id) existing.id = tc.id;
              if (tc.function?.name && !existing.name) {
                existing.name = tc.function.name;
                yield { type: 'tool_use', tool: existing.name };
              }
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastId) acc.providerSessionId = lastId;

  // Reconstruct the full assistant message from accumulated deltas
  const toolCalls: ToolCall[] = [];
  for (const [, frag] of toolCallFragments) {
    toolCalls.push({
      id: frag.id,
      type: 'function',
      function: { name: frag.name, arguments: frag.arguments },
    });
  }

  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: textContent || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return assistantMsg;
}

// ── Agentic loop (non-streaming) ────────────────────────────────────

/**
 * Run the full agentic tool-call loop without streaming.
 *
 * Makes API calls, executes tools, sends results back, and repeats until
 * the model returns a response with no tool_calls or the iteration limit.
 */
async function runAgenticLoop(
  apiEndpoint: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  apiTools: ToolDef[],
  toolMap: Map<string, ResolvedTool>,
  maxRounds: number,
  acc: SessionAccumulator,
): Promise<void> {
  // Make the initial API call
  let apiResponse = await callApi(apiEndpoint, token, model, messages, apiTools);

  acc.tokenUsage.inputTokens += apiResponse.usage?.prompt_tokens ?? 0;
  acc.tokenUsage.outputTokens += apiResponse.usage?.completion_tokens ?? 0;
  acc.providerSessionId = apiResponse.id;

  const firstChoice = apiResponse.choices[0];
  if (!firstChoice) return;

  let assistantMsg: ChatMessage = {
    role: 'assistant',
    content: firstChoice.message.content,
    ...(firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0
      ? { tool_calls: firstChoice.message.tool_calls }
      : {}),
  };
  messages.push(assistantMsg);
  acc.transcript.push(assistantMsg as TranscriptEntry);

  let round = 0;

  while (
    assistantMsg.tool_calls &&
    assistantMsg.tool_calls.length > 0 &&
    round < maxRounds
  ) {
    round++;

    // Execute each tool call and collect results
    for (const toolCall of assistantMsg.tool_calls) {
      const toolResult = await executeToolCall(toolCall, toolMap);
      const toolMsg: ChatMessage = {
        role: 'tool',
        content: toolResult,
        tool_call_id: toolCall.id,
      };
      messages.push(toolMsg);
      acc.transcript.push(toolMsg as TranscriptEntry);
    }

    // Make the next API call with tool results
    apiResponse = await callApi(apiEndpoint, token, model, messages, apiTools);

    acc.tokenUsage.inputTokens += apiResponse.usage?.prompt_tokens ?? 0;
    acc.tokenUsage.outputTokens += apiResponse.usage?.completion_tokens ?? 0;
    acc.providerSessionId = apiResponse.id;

    const choice = apiResponse.choices[0];
    if (!choice) break;

    assistantMsg = {
      role: 'assistant',
      content: choice.message.content,
      ...(choice.message.tool_calls && choice.message.tool_calls.length > 0
        ? { tool_calls: choice.message.tool_calls }
        : {}),
    };
    messages.push(assistantMsg);
    acc.transcript.push(assistantMsg as TranscriptEntry);
  }
}

/**
 * Run the full agentic tool-call loop with streaming.
 *
 * Yields chunks from each API call, executes tools, sends results back.
 */
async function* runAgenticLoopStreaming(
  apiEndpoint: string,
  token: string,
  model: string,
  messages: ChatMessage[],
  apiTools: ToolDef[],
  toolMap: Map<string, ResolvedTool>,
  maxRounds: number,
  acc: SessionAccumulator,
): AsyncGenerator<SessionChunk, void, undefined> {
  // Make the initial streaming API call
  const gen = callApiStreaming(apiEndpoint, token, model, messages, apiTools, acc);
  let assistantMsg: ChatMessage;

  // Yield chunks from the generator and capture the return value
  while (true) {
    const result = await gen.next();
    if (result.done) {
      assistantMsg = result.value;
      break;
    }
    yield result.value;
  }

  messages.push(assistantMsg);
  acc.transcript.push(assistantMsg as TranscriptEntry);

  let round = 0;

  while (
    assistantMsg.tool_calls &&
    assistantMsg.tool_calls.length > 0 &&
    round < maxRounds
  ) {
    round++;

    // Execute each tool call and collect results
    for (const toolCall of assistantMsg.tool_calls) {
      const toolResult = await executeToolCall(toolCall, toolMap);
      const toolMsg: ChatMessage = {
        role: 'tool',
        content: toolResult,
        tool_call_id: toolCall.id,
      };
      messages.push(toolMsg);
      acc.transcript.push(toolMsg as TranscriptEntry);
      yield { type: 'tool_result', tool: toolCall.id };
    }

    // Make the next streaming API call
    const nextGen = callApiStreaming(apiEndpoint, token, model, messages, apiTools, acc);
    while (true) {
      const result = await nextGen.next();
      if (result.done) {
        assistantMsg = result.value;
        break;
      }
      yield result.value;
    }

    messages.push(assistantMsg);
    acc.transcript.push(assistantMsg as TranscriptEntry);
  }
}

// ── Tool execution ─────────────────────────────────────────────────

/**
 * Execute a single tool call and return the result string.
 *
 * Catches all errors and returns them as error strings rather than
 * propagating — the model receives the error and may retry or recover.
 */
async function executeToolCall(
  toolCall: ToolCall,
  toolMap: Map<string, ResolvedTool>,
): Promise<string> {
  const tool = toolMap.get(toolCall.function.name);
  if (!tool) {
    return `Error: Unknown tool: ${toolCall.function.name}`;
  }

  try {
    const args = JSON.parse(toolCall.function.arguments) as unknown;
    const parsed = tool.definition.params.parse(args);
    const rawResult = await tool.definition.handler(parsed);
    if (typeof rawResult === 'string') return rawResult;
    return JSON.stringify(rawResult, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

// ── Provider implementation ──────────────────────────────────────────

/**
 * Create the Copilot session provider apparatus.
 *
 * The apparatus reads CopilotConfig from guild config at start() time
 * and provides an AnimatorSessionProvider backed by the GitHub Models API.
 */
export function createCopilotProvider(): Plugin {
  let config: CopilotConfig = {};

  const provider: AnimatorSessionProvider = {
    name: 'copilot',

    launch(sessionConfig: SessionProviderConfig): {
      chunks: AsyncIterable<SessionChunk>;
      result: Promise<SessionProviderResult>;
    } {
      // Resolve config values with defaults
      const apiEndpoint = (config.apiEndpoint ?? 'https://models.inference.ai.azure.com').replace(/\/$/, '');
      const tokenEnvVar = config.tokenEnvVar ?? 'GITHUB_TOKEN';
      const maxRounds = config.maxToolRounds ?? 50;

      const acc: SessionAccumulator = {
        transcript: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      };

      // Build initial messages from config
      const messages: ChatMessage[] = [];
      if (sessionConfig.systemPrompt) {
        const systemMsg: ChatMessage = { role: 'system', content: sessionConfig.systemPrompt };
        messages.push(systemMsg);
        acc.transcript.push(systemMsg as TranscriptEntry);
      }
      if (sessionConfig.initialPrompt) {
        const userMsg: ChatMessage = { role: 'user', content: sessionConfig.initialPrompt };
        messages.push(userMsg);
        acc.transcript.push(userMsg as TranscriptEntry);
      }

      // Convert tools
      const tools = sessionConfig.tools ?? [];
      const apiTools = convertTools(tools);
      const toolMap = new Map<string, ResolvedTool>(
        tools.map((rt) => [rt.definition.name, rt]),
      );

      if (sessionConfig.streaming) {
        // ── Streaming mode ────────────────────────────────────────────
        // Use a push queue + resolve callback to bridge the async generator
        // into a pull-based async iterable.

        const chunkQueue: SessionChunk[] = [];
        let chunkResolve: (() => void) | null = null;
        let done = false;
        let streamError: Error | null = null;

        const result: Promise<SessionProviderResult> = (async () => {
          // Validate token
          const token = process.env[tokenEnvVar];
          if (!token) {
            throw new Error(
              `Copilot session provider requires a GitHub token. ` +
              `Set the ${tokenEnvVar} environment variable.`,
            );
          }

          try {
            const gen = runAgenticLoopStreaming(
              apiEndpoint, token, sessionConfig.model, messages, apiTools, toolMap, maxRounds, acc,
            );

            for await (const chunk of gen) {
              chunkQueue.push(chunk);
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              const notify = chunkResolve as (() => void) | null;
              chunkResolve = null;
              notify?.();
            }

            return {
              status: 'completed' as const,
              exitCode: 0,
              providerSessionId: acc.providerSessionId,
              tokenUsage: acc.tokenUsage,
              costUsd: undefined,
              transcript: acc.transcript,
              output: extractOutput(messages),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            streamError = err instanceof Error ? err : new Error(message);
            return {
              status: 'failed' as const,
              exitCode: 1,
              error: message,
              transcript: acc.transcript,
              tokenUsage: acc.tokenUsage.inputTokens > 0 ? acc.tokenUsage : undefined,
            };
          } finally {
            done = true;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            const notify = chunkResolve as (() => void) | null;
            chunkResolve = null;
            notify?.();
          }
        })();

        // Async iterable that drains the chunk queue, pausing between batches
        const chunks: AsyncIterable<SessionChunk> = {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<SessionChunk>> {
                while (true) {
                  if (chunkQueue.length > 0) {
                    return { value: chunkQueue.shift()!, done: false };
                  }
                  if (done || streamError) {
                    return { value: undefined as unknown as SessionChunk, done: true };
                  }
                  await new Promise<void>((resolve) => { chunkResolve = resolve; });
                }
              },
            };
          },
        };

        return { chunks, result };
      }

      // ── Non-streaming mode ─────────────────────────────────────────
      // Chunks iterable is immediately done; all work happens in result.

      const emptyChunks: AsyncIterable<SessionChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<SessionChunk>> {
              return Promise.resolve({ value: undefined as unknown as SessionChunk, done: true });
            },
          };
        },
      };

      const result: Promise<SessionProviderResult> = (async () => {
        // Validate token
        const token = process.env[tokenEnvVar];
        if (!token) {
          throw new Error(
            `Copilot session provider requires a GitHub token. ` +
            `Set the ${tokenEnvVar} environment variable.`,
          );
        }

        try {
          await runAgenticLoop(
            apiEndpoint, token, sessionConfig.model, messages, apiTools, toolMap, maxRounds, acc,
          );

          return {
            status: 'completed' as const,
            exitCode: 0,
            providerSessionId: acc.providerSessionId,
            tokenUsage: acc.tokenUsage,
            costUsd: undefined,
            transcript: acc.transcript,
            output: extractOutput(messages),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            status: 'failed' as const,
            exitCode: 1,
            error: message,
            transcript: acc.transcript,
            tokenUsage: acc.tokenUsage.inputTokens > 0 ? acc.tokenUsage : undefined,
          };
        }
      })();

      return { chunks: emptyChunks, result };
    },
  };

  return {
    apparatus: {
      requires: [],
      provides: provider,

      start(_ctx: StartupContext): void {
        config = guild().guildConfig().copilot ?? {};
      },
    },
  };
}

export default createCopilotProvider();
