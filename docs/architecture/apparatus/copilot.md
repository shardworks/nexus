# The Copilot Session Provider — API Contract

Status: **Draft — MVP**

Package: `@shardworks/copilot-apparatus` · Plugin id: `copilot`

> **⚠️ MVP scope.** This spec covers the session provider implementation: calling the GitHub Models REST API, running an in-process agentic tool-call loop, streaming via SSE, and reporting structured results back to The Animator. Conversation resume (`conversationId`) is not supported.

---

## Purpose

The Copilot apparatus is a **session provider** — a pluggable backend that The Animator delegates to for launching and communicating with a specific AI system. It implements `AnimatorSessionProvider` from `@shardworks/animator-apparatus` and is discovered via guild config:

```json
{
  "animator": {
    "sessionProvider": "copilot"
  }
}
```

The apparatus calls the GitHub Models REST API (OpenAI-compatible chat completions endpoint), runs an in-process agentic tool-call loop when tools are supplied, and delivers streaming output via SSE. Unlike the Claude Code provider, it spawns no subprocess and requires no MCP server — tool handlers are called directly in-process.

---

## Dependencies

```
requires: []
```

The Copilot apparatus has no apparatus dependencies. It implements `AnimatorSessionProvider` (imported as a type from `@shardworks/animator-apparatus`) but does not call The Animator at runtime — the relationship is reversed: The Animator calls the provider.

Tool definitions and resolved tools are imported from `@shardworks/tools-apparatus` as compile-time type dependencies only. No MCP SDK is required.

---

## `AnimatorSessionProvider` Implementation (`provides`)

The apparatus provides an implementation of `AnimatorSessionProvider`:

```typescript
interface AnimatorSessionProvider {
  name: 'copilot';
  launch(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}
```

A single `launch()` method handles both streaming and non-streaming sessions. When `config.streaming` is true, the provider uses the streaming API and yields `SessionChunk` objects in real time. When false, it accumulates all output internally and returns empty chunks. The return shape is always `{ chunks, result }`.

The apparatus reads `CopilotConfig` from `guild().guildConfig().copilot` in `start()` and caches it as a closure variable for use in `launch()`.

---

## Session Lifecycle

```
launch(config)
  │
  ├─ 1. Resolve config: apiEndpoint, tokenEnvVar, maxRounds
  ├─ 2. Validate token from process.env[tokenEnvVar]
  │     └─ Throw if missing or empty
  ├─ 3. Build initial messages array:
  │     ├─ { role: 'system', content: systemPrompt }  (if present)
  │     └─ { role: 'user', content: initialPrompt }   (if present)
  ├─ 4. Convert tools to OpenAI format (z.toJSONSchema for params)
  ├─ 5. Build toolMap: Map<name, ResolvedTool> for O(1) lookup
  ├─ 6. Make initial API call (streaming or non-streaming)
  └─ 7. Enter agentic loop:
        ├─ If no tool_calls on last assistant message → break
        ├─ If round >= maxRounds → break
        ├─ Execute each tool call (catch errors → tool result message)
        ├─ Append tool result messages to messages + transcript
        └─ Make next API call → repeat
```

---

## Agentic Tool-Call Loop

The provider implements an in-process tool-call loop. This differs from the Claude Code provider, which delegates tool execution to the `claude` CLI via MCP.

```
round = 0

loop:
  check assistant message tool_calls
  if none → exit loop
  if round >= maxRounds → exit loop (safety valve)
  round++

  for each tool_call:
    look up tool by name in toolMap
    if not found → result = "Error: Unknown tool: {name}"
    else:
      try:
        args = JSON.parse(tool_call.function.arguments)
        parsed = tool.definition.params.parse(args)
        rawResult = await tool.definition.handler(parsed)
        result = rawResult (string) or JSON.stringify(rawResult)
      catch err:
        result = "Error: {err.message}"

    append { role: 'tool', content: result, tool_call_id } to messages + transcript
    if streaming: yield { type: 'tool_result', tool: tool_call_id }

  make next API call (streaming or non-streaming)
  process response → loop
```

Tool handler errors are caught and returned as tool result messages — the model receives the error description and may retry, clarify, or recover. The session does not fail.

When `maxRounds` is reached, the loop exits and the session completes normally (`status: 'completed'`, `exitCode: 0`) using the last available assistant response. The limit is a safety valve, not an error condition.

---

## Streaming

When `config.streaming` is true, the provider:

1. Makes API calls with `stream: true` and `stream_options: { include_usage: true }`.
2. Reads `response.body` as a `ReadableStream`, decodes with `TextDecoder`, and parses SSE `data:` lines.
3. Yields `SessionChunk` objects in real time:
   - `{ type: 'text', text }` — text content delta (also written to stderr for terminal visibility)
   - `{ type: 'tool_use', tool: name }` — when a tool call's name is first seen in a delta
   - `{ type: 'tool_result', tool: toolCallId }` — after each tool call is executed
4. Accumulates tool call fragments by index across deltas to reconstruct the full tool call.
5. Extracts usage from the final streaming chunk (via `stream_options.include_usage`).
6. Streaming continues throughout the agentic loop — chunks stream during each API call, pause during tool execution, and resume on the next call.

The streaming chunk delivery mechanism uses a push queue + resolve callback pattern, bridging the async generator (SSE events) into a pull-based async iterable compatible with `for await...of` consumers.

---

## Token Usage

The provider accumulates token usage across all API calls in the session:

```
tokenUsage.inputTokens  += response.usage.prompt_tokens     (each call)
tokenUsage.outputTokens += response.usage.completion_tokens (each call)
```

For streaming, usage is included in the final SSE chunk via `stream_options: { include_usage: true }`. For non-streaming, usage is in the response body's `usage` field.

`costUsd` is always `undefined` — the GitHub Models API does not report per-call costs.

---

## Result Construction

After the loop exits:

- `status: 'completed'`, `exitCode: 0` on success.
- `status: 'failed'`, `exitCode: 1` on API error or network failure — with `error` containing the message.
- `providerSessionId` = `id` field from the last API response.
- `output` = content of the last assistant message with no `tool_calls` (walking backwards).
- `transcript` = full message array built during the session (system, user, assistant, tool messages).

---

## Configuration

Plugin configuration in `guild.json`:

```json
{
  "copilot": {
    "apiEndpoint": "https://models.inference.ai.azure.com",
    "tokenEnvVar": "GITHUB_TOKEN",
    "maxToolRounds": 50
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiEndpoint` | `string` | `https://models.inference.ai.azure.com` | Base URL for the chat completions API |
| `tokenEnvVar` | `string` | `GITHUB_TOKEN` | Environment variable name holding the Bearer token |
| `maxToolRounds` | `number` | `50` | Maximum agentic tool-call iterations before stopping |

All fields are optional — defaults apply when absent or when `guild.json` has no `copilot` section.

The token is read from `process.env[tokenEnvVar]` at `launch()` time. When the env var is missing or empty, `launch()` throws synchronously (inside the result promise) with a message naming the expected variable.

The model comes from `SessionProviderConfig.model`, passed through from The Animator's guild settings resolution. The `copilot` config section does not set a model default.

---

## Ignored Config Fields

The following `SessionProviderConfig` fields are intentionally ignored:

| Field | Reason |
|-------|--------|
| `conversationId` | Conversation resume not supported by the GitHub Models API in this implementation |
| `cwd` | No subprocess is spawned |
| `environment` | No subprocess is spawned; environment variables are not injected into API calls |

---

## Open Questions

- **Conversation resume.** The GitHub Models API is stateless (no server-side history). Resume could be implemented by storing and re-sending the full message history, but this requires Stacks integration and is deferred to a future iteration.

- **`callableBy` filtering.** The claude-code provider filters tools by `callableBy: ['anima']` in its MCP server. The copilot provider currently passes all tools through. Should it apply the same filter? Likely yes — needs confirmation.

---

## Future: Conversation Resume

Multi-turn conversation support could be added by storing the full message array in The Stacks alongside the session transcript, then reloading it when `conversationId` is provided. The API call would include the full message history, effectively resuming the conversation.

---

## Implementation Notes

- **No MCP server.** The copilot provider calls tool handlers directly in-process, unlike claude-code which routes tool calls through an HTTP MCP server. This is simpler because the provider owns the full request/response cycle.
- **SSE `[DONE]` sentinel.** The GitHub Models streaming API follows the OpenAI convention of sending `data: [DONE]` as the final SSE line. The parser skips this sentinel.
- **Trailing slash handling.** The `apiEndpoint` has trailing slashes stripped before use to avoid double-slash URLs in the fetch call.
- **`z.toJSONSchema`.** Requires Zod 4.x. The `z.toJSONSchema()` function converts a Zod schema to a JSON Schema object for inclusion in the OpenAI tools array.
