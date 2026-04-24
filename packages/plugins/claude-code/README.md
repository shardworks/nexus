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
  - `processInfo` polls the SessionDoc for `cancelHandle` (set by the babysitter via `session-running`), falls back to `{ kind: 'local-pgid', pgid: babysitterPid }`
- **`cancel(cancelMetadata)`** — dispatches on `cancelMetadata.kind`. For `local-pgid`, sends SIGTERM to the process group via `process.kill(-pgid, 'SIGTERM')`, killing both the babysitter and the claude process. Unknown kinds are logged and skipped.

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

### Rate-Limit Detection

The provider runs a **two-branch NDJSON detector** to identify rate-limited terminations and attach a structured `terminationTag` to the session result. The Animator's back-off state machine consumes the tag and transitions its pause-state doc accordingly.

```typescript
import { detectRateLimitFromNdjson } from '@shardworks/claude-code-apparatus';
```

Active detector branches (first-wins):

1. **Structural `subtype`** — `parseStreamJsonMessage` inspects every NDJSON message whose `subtype` contains `rate_limit` / `rate-limit` and emits a tag with `source: 'ndjson-result'`.
2. **Structural `is_error`** — if `msg.is_error === true` and the carried error text matches the rate-limit phrasing regex, the same tag is produced.

Everything else surfaces as plain `failed`. The previous stderr-pattern and exit-code branches were retired after two production incidents where an assistant's prose summary / a generic non-zero exit code tripped a false-positive pause. Generic non-zero exit codes surface as `'failed'`; the babysitter no longer samples claude's stderr for pattern matches, only forwards it to the per-session log file.

When a non-zero exit arrives without an NDJSON termination tag, the babysitter captures a `terminationDiagnostic: { exitCode, stderrExcerpt? }` on the session-record payload so operators can review the signal that fell through — without the Animator widening its pause gate on it.

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
  logDir: string;              // Directory for per-session log files
  claudeArgs: string[];        // CLI args for claude (--model, --system-prompt-file, etc.)
  cwd: string;                 // Working directory for the claude process
  env: Record<string, string>; // Environment variables for the claude process
  prompt: string;              // Initial prompt piped to claude's stdin
  tools: SerializedTool[];     // Tool definitions with JSON Schema params
  startedAt: string;           // ISO timestamp of session start
  provider: string;            // Provider name (e.g. "claude-code")
  metadata?: Record<string, unknown>;  // Optional session metadata
  systemPromptTmpDir?: string;         // Temp dir for system prompt file (cleaned up in finally)
}

interface SerializedTool {
  name: string;
  description: string;
  params: Record<string, unknown>;  // JSON Schema
  method: 'GET' | 'POST' | 'DELETE';  // HTTP method for tool server routing
}
```

### Lifecycle

1. **Read config** from stdin, parse JSON, validate required fields
2. **Open SQLite** (WAL mode) for real-time transcript streaming
3. **Start MCP/SSE proxy server** — registers tools that forward calls to the guild's Tool HTTP API with retry and exponential backoff
4. **Prepare session files** — temp directory, mcp-config.json pointing to the proxy server
5. **Spawn claude** — pipes prompt to stdin, captures NDJSON stdout
6. **Report "running"** — calls `session-running` tool on guild via HTTP (DLQ fallback). Reports `cancelHandle: { kind: 'local-pgid', pgid: process.pid }` (babysitter's own PID, which equals its PGID because it was spawned with `detached: true`)
7. **Start heartbeat** — after running report completes, sends `session-heartbeat` every 30s to refresh `lastActivityAt` on the guild. Heartbeat failures are silently dropped (the 90s staleness threshold tolerates missed heartbeats)
8. **Install SIGTERM handler** — sets a `cancelledBySignal` flag, stops the heartbeat timer, and propagates SIGTERM to the claude child process. The normal exit path checks this flag and reports status `cancelled` instead of computing from exit code
9. **Stream transcript** — parses NDJSON, writes to `books_animator_transcripts` table in SQLite after each message batch
10. **Report result** — stops heartbeat, calls `session-record` tool on guild via HTTP (DLQ fallback)
11. **Cleanup** — close MCP server, close SQLite, remove temp directory and system prompt temp directory

### Session Logs

Each babysitter process writes its own per-session log file, independent of the guild's stderr. This eliminates EPIPE crashes when the guild restarts (which would invalidate an inherited stderr fd).

- **Location**: `<guildHome>/logs/sessions/<sessionId>.log`
- **Format**: Plain text, `[babysitter]`-prefixed lines. Claude subprocess stderr is also forwarded into the same file.
- **Lifetime**: Log files persist until manually deleted. They are not cleaned up automatically.
- **Ownership**: Each log file is owned by its babysitter process. The babysitter opens the file in append mode immediately after reading config from stdin, redirects all `process.stderr.write` output to it, and closes the fd on exit.

The first line of each log file is a startup banner:

```
[babysitter] session=<sessionId> pid=<pid> pgid=<pgid> log=<path> started at <iso>
```

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
