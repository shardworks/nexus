# `@shardworks/claude-code-apparatus`

Claude Code session provider apparatus for Nexus. Implements the `AnimatorSessionProvider` interface for the Claude Code CLI, enabling the Animator to launch and manage AI sessions. Also provides the **Session Babysitter** — a detached process that hosts sessions independently of the guild lifecycle.

Depends on `@shardworks/animator-apparatus` (types), `@shardworks/tools-apparatus` (tool definitions and routing), and `@shardworks/nexus-core`.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/claude-code-apparatus": "workspace:*"
  }
}
```

## API

### Session Provider

The default export is a `Plugin` whose apparatus `provides` an `AnimatorSessionProvider`:

```typescript
import createClaudeCodeProvider from '@shardworks/claude-code-apparatus';

// In guild.json:
// { "animator": { "sessionProvider": "claude-code" } }
```

The provider implements `launch()` and `cancel()`:

- **`launch(config)`** — spawns a **detached babysitter process** that hosts the session independently of the guild. The babysitter spawns `claude` in autonomous mode, streams transcripts to SQLite, and reports lifecycle events via HTTP. Returns `{ chunks, result, processInfo }` where:
  - `chunks` completes immediately (empty) — real-time output is available via the transcripts book
  - `result` polls the sessions book for terminal status (resolves when the babysitter calls `session-record`)
  - `processInfo` polls the SessionDoc for `cancelMetadata.pid` (set by the babysitter via `session-running`)
- **`cancel(cancelMetadata)`** — sends SIGTERM to the claude process using the PID from `cancelMetadata`. Works cross-process regardless of parent-child relationships.

### Stream Parsing

Exported utilities for parsing Claude's NDJSON output:

```typescript
import {
  processNdjsonBuffer,
  parseStreamJsonMessage,
  extractFinalAssistantText,
} from '@shardworks/claude-code-apparatus';
```

- **`processNdjsonBuffer(buffer, handler)`** — splits NDJSON buffer on newlines, calls handler for each parsed JSON object, returns remaining incomplete buffer.
- **`parseStreamJsonMessage(msg, acc)`** — processes a single NDJSON message, accumulates transcript/metrics, returns `SessionChunk[]`.
- **`extractFinalAssistantText(transcript)`** — walks transcript backwards to find the last assistant message's text content.

## Session Babysitter

The babysitter is a standalone Node.js script that runs as a detached process, hosting a claude session independently of the guild. It survives guild restarts.

### Entry Point

```bash
node dist/babysitter.js  # reads config from stdin
```

Or import the module for programmatic use:

```typescript
import { runBabysitter } from '@shardworks/claude-code-apparatus/babysitter';
```

### Config (via stdin)

The spawning process writes JSON config to the babysitter's stdin:

```typescript
interface BabysitterConfig {
  sessionId: string;           // Pre-generated session ID
  guildToolUrl: string;        // Guild's Tool HTTP API URL (e.g. "http://127.0.0.1:7471")
  dbPath: string;              // Path to guild's SQLite database
  claudeArgs: string[];        // CLI args for claude (--model, --system-prompt-file, etc.)
  cwd: string;                 // Working directory for the claude process
  env: Record<string, string>; // Environment variables for the claude process
  prompt: string;              // Initial prompt piped to claude's stdin
  tools: SerializedTool[];     // Tool definitions with JSON Schema params
  startedAt: string;           // ISO timestamp of session start
  provider: string;            // Provider name (e.g. "claude-code")
  metadata?: Record<string, unknown>;  // Optional session metadata
}

interface SerializedTool {
  name: string;
  description: string;
  params: Record<string, unknown>;  // JSON Schema
}
```

### Lifecycle

1. **Read config** from stdin, parse JSON, validate required fields
2. **Open SQLite** (WAL mode) for real-time transcript streaming
3. **Start MCP/SSE proxy server** — registers tools that forward calls to the guild's Tool HTTP API with retry and exponential backoff
4. **Prepare session files** — temp directory, mcp-config.json pointing to the proxy server
5. **Spawn claude** — pipes prompt to stdin, captures NDJSON stdout
6. **Report "running"** — calls `session-running` tool on guild via HTTP (DLQ fallback)
7. **Stream transcript** — parses NDJSON, writes to `books_animator_transcripts` table in SQLite after each message batch
8. **Report result** — calls `session-record` tool on guild via HTTP (DLQ fallback)
9. **Cleanup** — close MCP server, close SQLite, remove temp directory

### Error Handling

- **Tool call proxy errors**: retried with exponential backoff (1s initial, 8s max, 60s timeout). If retries exhaust, returns error to claude as MCP tool result — doesn't crash.
- **Lifecycle reporting errors**: if guild is unreachable, payload is written to `.nexus/dlq/{sessionId}[-running].json` for later drain.
- **Top-level errors**: attempts to report `status: 'failed'` to guild, falls back to DLQ, then exits non-zero.

## Exports

| Entry point | Description |
|---|---|
| `.` (`src/index.ts`) | Session provider plugin, stream parsing utilities |
| `./babysitter` (`src/babysitter.ts`) | Babysitter module — `runBabysitter()`, config parsing, proxy server, transcript DB |

### Internal Modules

| Module | Description |
|---|---|
| `src/detached.ts` | Detached launch — `launchDetached()`, tool serialization (`serializeTools()`), polling helpers |

## Configuration

Configured in `guild.json` under the `animator` key:

```json
{
  "animator": {
    "sessionProvider": "claude-code"
  }
}
```

No additional configuration fields. The model is passed per-session via the Animator.
