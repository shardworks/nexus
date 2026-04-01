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
  launch(config: SessionProviderConfig): Promise<SessionProviderResult>;
  launchStreaming?(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}
```

Both `launch()` and `launchStreaming()` are implemented. They share session preparation logic (temp directory, argument assembly) and differ only in how they consume the child process's stdout:

- **`launch()`** — accumulates all stream-json output, resolves when the process exits.
- **`launchStreaming()`** — yields `SessionChunk` objects as they arrive via an async iterable, while also accumulating the full result.

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

The package contains a module (`mcp-server.ts`) that creates an MCP server from `ToolDefinition` objects. This is the designated MCP server for guild tool sessions — one per session, serving the anima's permission-gated tool set.

### `createMcpServer(tools)`

```typescript
async function createMcpServer(tools: ToolDefinition[]): Promise<McpServer>
```

Creates an MCP server instance with the given tools registered. Each tool is registered with the MCP SDK using:
- Tool name and description from the definition
- Zod param schema (the SDK handles JSON Schema conversion)
- Handler wrapped with Zod validation and error formatting

Tools with `callableFrom` set that does not include `'mcp'` are filtered out. Tools without `callableFrom` are included (available on all channels by default).

### `startMcpServer(config)`

```typescript
async function startMcpServer(config: McpServerProcessConfig): Promise<void>
```

Process entry point for running the MCP server as a standalone stdio process. Designed to be spawned by Claude's runtime via `--mcp-config`:

1. Reads config (guild home path + permissions)
2. Boots the guild runtime via `createGuild()`
3. Resolves the tool set via The Instrumentarium
4. Creates the MCP server with resolved tools
5. Connects via `StdioServerTransport`

### MCP Config Format

The claude-code provider writes a temporary MCP config file for `--mcp-config`:

```json
{
  "mcpServers": {
    "nexus-guild": {
      "command": "node",
      "args": ["<path-to-mcp-server-entry>", "<config.json>"],
      "env": {}
    }
  }
}
```

The config file passed to the MCP server process:

```json
{
  "home": "/absolute/path/to/guild-root",
  "permissions": ["stdlib:read", "stdlib:write", "stacks:read"],
  "strict": false
}
```

The MCP server process boots its own guild instance — tool handlers call `guild()` internally, so a live guild runtime is required. This means each session has two guild instances: one in the main process (The Animator's) and one in the MCP server process. Guild boot is fast (reads `guild.json`, loads plugins, starts apparatus) and the instances are independent.

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
- **Guild boot cost in MCP server process.** Each session spawns a separate guild instance for the MCP server. Is this acceptable, or should we explore in-process MCP serving? Current assessment: acceptable — guild boot is fast and the isolation is clean.
- **Tool handler `guild()` context.** Tool handlers access guild infrastructure via the `guild()` singleton. In the MCP server process, this singleton points at the MCP server's own guild instance. Are there any concerns with two guild instances accessing the same `.nexus/nexus.db` simultaneously? SQLite handles concurrent readers, but concurrent writers could contend.

---

## Future: Tool-Equipped Sessions

When The Animator gains Instrumentarium integration, the session preparation changes:

### Updated `SessionProviderConfig`

```typescript
interface SessionProviderConfig {
  systemPrompt?: string;
  initialPrompt?: string;
  model: string;
  conversationId?: string;
  cwd: string;
  /** Resolved tools for the session. Provider creates MCP server from these. */
  tools?: ToolDefinition[];
  /** Permission grants, used if the provider boots its own guild for MCP. */
  permissions?: string[];
}
```

### Updated `prepareSession()`

```
prepareSession(config)
  │
  ├─ ... existing steps ...
  │
  ├─ 6. If tools provided:
  │     Write MCP server config to temp dir
  │     Write --mcp-config JSON to temp dir
  │     --mcp-config <path>
  │     --strict-mcp-config  (only guild tools, no ambient MCP)
  │
  └─ 7. Consider switching to --bare mode
        (full Loom composition + MCP = complete session control)
```

### MCP Server Lifecycle

Claude's runtime manages the MCP server lifecycle. The `--mcp-config` flag tells Claude to spawn the server process at session start and kill it at session end. The provider does not manage the MCP server process directly — it writes the config, Claude does the rest.

This is the standard MCP pattern: the AI runtime owns server lifecycle. The guild's MCP server is no different from any external MCP server (GitHub, Slack, etc.) from Claude's perspective.
