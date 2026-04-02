# Claude Code Session Provider — API Contract

Status: **Draft — MVP**

Package: `@shardworks/claude-code-apparatus` · Plugin id: `claude-code`

> **⚠️ MVP scope.** This spec covers the session provider implementation: launching Claude Code CLI processes in autonomous mode, parsing stream-json telemetry, and reporting structured results back to The Animator. The MCP tool server module exists but is not yet wired into the session lifecycle — see [Future: Tool-Equipped Sessions](#future-tool-equipped-sessions).

---

## Purpose

The Claude Code apparatus is a **session provider** — a pluggable backend that The Animator delegates to for launching and communicating with a specific AI system. It implements `AnimatorSessionProvider` from `@shardworks/animator-apparatus` and is discovered via guild config:

```json
{
  "animator": {
    "sessionProvider": "claude-code"
  }
}
```

The apparatus handles the mechanics of the Claude Code CLI: process spawning, argument assembly, system prompt file management, stream-json NDJSON parsing, and telemetry extraction (cost, token usage, session id). It does not handle session lifecycle, recording, or identity composition — those belong to The Animator and The Loom respectively.

The package also contains the **MCP tool server** — a module that creates an MCP server from resolved tool definitions, serving guild tools to Claude during sessions. This module is not yet integrated into the session lifecycle but is the designated home for MCP server functionality.

---

## Dependencies

```
requires: []
```

The Claude Code apparatus has no apparatus dependencies. It implements `AnimatorSessionProvider` (imported as a type from `@shardworks/animator-apparatus`) but does not call The Animator at runtime — the relationship is reversed: The Animator calls the provider.

The MCP server module imports types from `@shardworks/tools-apparatus` (`ToolDefinition`, `isToolDefinition`) and uses `@modelcontextprotocol/sdk` for the MCP protocol implementation. These are compile-time dependencies, not runtime apparatus dependencies.

---

## `AnimatorSessionProvider` Implementation (`provides`)

The apparatus provides a stateless implementation of `AnimatorSessionProvider`:

```typescript
interface AnimatorSessionProvider {
  name: string;
  launch(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}
```

A single `launch()` method handles both streaming and non-streaming sessions. When `config.streaming` is true, the provider spawns Claude and yields `SessionChunk` objects as they arrive via an async iterable. When false, it accumulates all output internally and returns empty chunks. The return shape is always `{ chunks, result }` — the Animator does not branch on streaming capability.

Internally, the provider delegates to one of two spawn helpers based on the streaming flag:
- **`spawnClaudeStreamJson()`** — accumulates all stream-json output, resolves when the process exits. Used for non-streaming sessions.
- **`spawnClaudeStreamingJson()`** — yields chunks in real time via an async iterable while accumulating the full result. Used for streaming sessions.

The apparatus has no startup logic — `start()` is a no-op. The provider is stateless and safe for concurrent use.

---

## Session Preparation

Both launch methods share a `prepareSession()` step that writes temporary files and assembles CLI arguments:

```
prepareSession(config)
  │
  ├─ 1. Create temp directory (nsg-session-XXXXX)
  ├─ 2. Build base args:
  │     --setting-sources user
  │     --dangerously-skip-permissions
  │     --model <config.model>
  ├─ 3. If systemPrompt provided:
  │     Write to temp/system-prompt.md
  │     --system-prompt-file <path>
  ├─ 4. If conversationId provided:
  │     --resume <conversationId>
  └─ 5. Return { tmpDir, args }
```

The caller adds the final arguments (`--print`, `--output-format stream-json`, `--verbose`) and the initial prompt, then spawns the `claude` process. The temp directory is cleaned up in a `finally` block after the process exits.

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--setting-sources user` | Use only user-level settings, not project-level |
| `--dangerously-skip-permissions` | Bypass interactive permission prompts (autonomous mode) |
| `--model` | Model selection from guild settings |
| `--print` | Autonomous mode — no interactive input, prompt via argument |
| `--output-format stream-json` | Structured NDJSON output on stdout |
| `--verbose` | Include detailed telemetry in stream-json output |
| `--system-prompt-file` | System prompt from file (composed by The Loom) |
| `--resume` | Resume an existing conversation by provider session id |

### Bare Mode (Future)

When sessions are fully composed by The Loom (system prompt, tools, CLAUDE.md), the provider should use `--bare` mode:

```
--bare    Skip hooks, LSP, plugin sync, attribution, auto-memory, background
          prefetches, keychain reads, and CLAUDE.md auto-discovery.
          Context is explicitly provided via:
          --system-prompt[-file], --mcp-config, --settings, --add-dir, etc.
```

This ensures the session context is entirely what The Loom wove — no ambient CLAUDE.md or project settings leak in. Not yet implemented; current sessions may pick up ambient project configuration.

---

## Stream-JSON Parsing

The `claude` CLI with `--output-format stream-json` emits NDJSON (newline-delimited JSON) on stdout. Each line is a message with a `type` field:

| Message type | Content | Extracted data |
|-------------|---------|----------------|
| `assistant` | Model response with content blocks | Transcript entry; text chunks → stderr + `SessionChunk` |
| `user` | User messages including tool results | Transcript entry; tool_result chunks → `SessionChunk` |
| `result` | Final summary after session completes | `costUsd`, `tokenUsage`, `providerSessionId` |

### Content Block Types (within `assistant` messages)

| Block type | Action |
|-----------|--------|
| `text` | Written to stderr (real-time visibility); emitted as `{ type: 'text', text }` chunk |
| `tool_use` | Emitted as `{ type: 'tool_use', tool: name }` chunk |

### Parsing Architecture

Two internal functions handle the parsing pipeline:

- **`processNdjsonBuffer(buffer, handler)`** — splits an incoming buffer on newlines, parses each complete JSON line, and calls the handler. Returns the remaining incomplete buffer. Gracefully skips non-JSON lines.

- **`parseStreamJsonMessage(msg, accumulator)`** — processes a single parsed message, accumulating transcript entries and telemetry into the accumulator object, and returning any `SessionChunk` objects for streaming consumers.

The stderr write of assistant text content is a deliberate side effect — it provides real-time session output visibility in the terminal. See [The Animator § CLI streaming behavior](./animator.md#cli-streaming-behavior) for the rationale.

---

## MCP Tool Server

The package contains a module (`mcp-server.ts`) that creates an MCP server from `ToolDefinition` objects, and an HTTP server helper (`startMcpHttpServer()`) that serves it over Streamable HTTP on an ephemeral localhost port. Each anima session gets its own MCP server instance serving that session's permission-gated tool set.

### `createMcpServer(tools)`

```typescript
async function createMcpServer(tools: ToolDefinition[]): Promise<McpServer>
```

Creates an MCP server instance with the given tools registered. Each tool is registered with the MCP SDK using:
- Tool name and description from the definition
- Zod param schema (the SDK handles JSON Schema conversion)
- Handler wrapped with Zod validation and error formatting

Tools with `callableBy` set that does not include `'anima'` are filtered out. Tools without `callableBy` are included (available to all callers by default).

### `startMcpHttpServer(tools)`

```typescript
async function startMcpHttpServer(tools: ToolDefinition[]): Promise<McpHttpHandle>

interface McpHttpHandle {
  /** URL for --mcp-config (e.g. "http://localhost:PORT/mcp") */
  url: string;
  /** Shut down the HTTP server and MCP transport. */
  close(): Promise<void>;
}
```

Starts an in-process HTTP server serving the MCP tool set via the Streamable HTTP transport. The server:

1. Calls `createMcpServer(tools)` to build the MCP server instance
2. Creates a `StreamableHTTPServerTransport` in stateless mode (one session per server — no session tracking needed)
3. Connects the MCP server to the transport
4. Starts a Node.js `http.createServer()` listening on `127.0.0.1` with port `0` (OS-assigned ephemeral port)
5. Routes all requests to the transport's `handleRequest()`
6. Returns a handle with the URL and a `close()` function

The HTTP server binds to localhost only — it is not network-accessible. The ephemeral port avoids conflicts when multiple sessions run concurrently.

### Transport Choice: HTTP vs Stdio

The MCP SDK supports multiple transports. We chose in-process HTTP over the more common stdio child-process approach:

| Concern | Stdio (child process) | HTTP (in-process) |
|---------|----------------------|-------------------|
| Guild instances | Two (SQLite contention risk) | One (shared) |
| Tool resolution | Must re-resolve in child | Already resolved by Loom |
| Boot latency | Guild boot per session | ~0 (just start HTTP listener) |
| Lifecycle | Claude manages | Provider manages |
| Entry point | Needs runnable script file | No extra file |
| Permissions | Must serialize & re-resolve | Not needed — tools in memory |

The in-process approach eliminates the need for a separate MCP server process entry point, avoids duplicate guild boot, and removes the SQLite concurrent-writer concern entirely. Tool definitions (including Zod schemas and handler functions) are passed directly — no serialization boundary.

### MCP Config Format

The provider writes a temporary `--mcp-config` JSON file:

```json
{
  "mcpServers": {
    "nexus-guild": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp"
    }
  }
}
```

Claude connects to the HTTP server as an MCP client using the Streamable HTTP transport. From Claude's perspective, this is no different from any remote MCP server.

### Server Lifecycle

The provider owns the MCP server lifecycle — it starts the server before launching the Claude session and stops it after the session exits:

```
prepareSession(config)
  │
  ├─ ... existing steps (temp dir, args, system prompt, resume) ...
  │
  └─ If config.tools has entries:
      ├─ startMcpHttpServer(tools) → { url, close }
      ├─ Write --mcp-config JSON to temp dir (pointing at url)
      ├─ Add --mcp-config <path> to args
      ├─ Add --strict-mcp-config to args
      └─ Return close() in PreparedSession for cleanup
```

Cleanup happens in the same `finally` block that removes the temp directory:

```
launch(config)
  ├─ prepareSession() → { tmpDir, args, mcpClose? }
  ├─ spawn claude process
  └─ on exit:
      ├─ mcpClose?.() — shut down HTTP server + transport
      └─ rmSync(tmpDir) — remove temp files
```

The `close()` function:
1. Closes the `StreamableHTTPServerTransport` (terminates any active SSE connections)
2. Closes the `http.Server` (stops accepting new connections)

If the Claude process crashes or is killed, the cleanup still runs — the `close` handler on the child process fires regardless of exit reason.

### Concurrency

Each session gets its own MCP server on its own ephemeral port. Multiple concurrent sessions each have independent HTTP servers, all sharing the same in-process guild instance. This is safe because:
- Tool handlers access guild infrastructure via `guild()`, which is process-global
- Read operations (stacks queries, config reads) are naturally concurrent
- Write operations (stacks puts) go through SQLite, which handles concurrency in WAL mode

---

## Configuration

The Claude Code apparatus reads no direct configuration from `guild.json`. It is selected as a session provider via The Animator's config:

```json
{
  "animator": {
    "sessionProvider": "claude-code"
  }
}
```

The `claude-code` value is the default when `sessionProvider` is not specified. The model comes from `guild.json["settings"]["model"]`, resolved by The Animator before being passed in `SessionProviderConfig`.

---

## Open Questions

- **`--bare` mode.** When should the provider switch from the current `--setting-sources user` to full `--bare` mode? Likely when The Loom produces real system prompts and MCP config is attached. Need to verify that `--bare` + `--mcp-config` + `--system-prompt-file` gives us full control with no ambient leakage.

---

## Future: Server Reuse

Currently each session gets its own MCP HTTP server, even when consecutive sessions have identical tool sets (same role, same permissions). A future optimization could pool and reuse MCP servers:

- **Key by tool set** — hash the sorted list of tool names to produce a cache key
- **Reference counting** — track active sessions per server; close when count drops to zero
- **Idle timeout** — close unused servers after a configurable idle period
- **Stale detection** — invalidate the cache when tool registrations change (plugin reload, guild restart)

This would eliminate per-session HTTP server startup for batch operations (e.g., dispatching multiple artificer sessions). The savings are modest — HTTP server start is fast — but it reduces port churn and simplifies cleanup in high-throughput scenarios.

Not implemented; revisit if session launch latency becomes a concern.
