# Detached Sessions

Detached sessions decouple anima sessions from the guild process so they survive guild restarts. This is an operational necessity when the guild is actively under development — restarting the guild for framework updates should not kill running sessions.

## Design Constraints

- Sessions must have **full tool access** across guild restarts (no degraded mode)
- Guild restart is a **normal event**, not a failure mode
- Architecture must extend to **Docker-hosted sessions** in the future
- **SSE transport required** — Streamable HTTP does not work with Claude Code
- Tool API logic lives on the **Instrumentarium** (sessions do not depend on the Oculus dashboard)

---

## Process Topology

Two process types. No relay, no shared daemon.

```
┌──────────────────────────────────────────────────────────┐
│  GUILD PROCESS  (restartable)                            │
│                                                          │
│  Full Arbor boot, all apparatuses, plus:                 │
│  ├── Tool HTTP API  (Instrumentarium, well-known port)   │
│  └── session-record, session-running tools (Animator)    │
│                                                          │
│  CDC fires for: tool handler writes, session lifecycle   │
└──────────────────────────────────────────────────────────┘
         ▲                              │
         │ HTTP (tool calls + session   │ spawn (detached)
         │ lifecycle, retry+DLQ)        │ config via stdin
         │                              ▼
┌────────┴─────────────────────────────────────────────────┐
│  SESSION BABYSITTER  (per-session, detached)             │
│                                                          │
│  ├── MCP/SSE server (handlers proxy to guild Tool API)   │
│  ├── Claude child process                                │
│  ├── NDJSON stdout → transcript streaming (direct SQLite)│
│  ├── Session lifecycle (HTTP tools: session-running,     │
│  │   session-record)                                     │
│  │   └── retry + DLQ (.nexus/dlq/) on guild unavailable  │
│  └── tmpDir cleanup                                      │
└──────────┬───────────────────────────────────────────────┘
           │ child
           ▼
┌──────────────────────────────────────────────────────────┐
│  CLAUDE PROCESS                                          │
│  --mcp-config → babysitter's MCP/SSE endpoint            │
└──────────────────────────────────────────────────────────┘
```

### Lifecycles

| Process | Started by | Lifetime | Restart impact |
|---|---|---|---|
| **Guild** | Operator | Minutes–hours | Tool calls retry; sessions unaffected |
| **Babysitter** | Guild (detached spawn) | One session | That session only |
| **Claude** | Babysitter (child) | One session | Session ends |

---

## Guild-Side Components

### Tool HTTP API (Instrumentarium)

The Instrumentarium gains an HTTP server that exposes all registered tools as REST endpoints. This is the generalized version of the Oculus's existing tool-to-HTTP mapping.

- Hono-based HTTP server on a well-known port (configurable, default 7471)
- Tool name to route mapping: `writ-list` → `POST /api/writ/list`
- Permission to HTTP method: read→GET, write→POST, delete→DELETE
- Zod param validation, tool handler execution, JSON response
- Serves all caller types (patron, anima, infrastructure)
- Session-scoped authorization via `X-Session-Id` header and in-memory session registry

### Session Lifecycle Tools (Animator)

Two new tools registered by the Animator, callable by infrastructure:

**`session-running`** — Records initial SessionDoc. Called by babysitter at session start.
- Writes `status: 'running'` to sessions book (fires CDC)
- Includes cancelMetadata with claude's PID

**`session-record`** — Records terminal session result. Called by babysitter on claude exit.
- Checks for cancelled status before overwriting
- Writes SessionDoc + optional TranscriptDoc (fires CDC)
- Spider collects on next crawl

### DLQ Drain

On guild startup, the Animator scans `.nexus/dlq/` for pending session results that babysitters couldn't deliver (guild was down). Each is processed through the session-record handler (fires CDC) and deleted.

### Orphan Recovery

On guild startup (after DLQ drain), sessions stuck in `running` with dead PIDs are marked failed.

---

## Session Babysitter

A per-session detached Node.js process in the claude-code package. It hosts the MCP server and claude process independently of the guild.

### Lifecycle

1. **Receive config via stdin** — guild spawns babysitter with `{ detached: true, stdio: ['pipe', 'ignore', 'inherit'] }`, writes JSON config to stdin, closes it. Config includes: sessionId, guildToolUrl, dbPath, claudeArgs, cwd, env, prompt, serialized tool definitions, metadata.

2. **Open SQLite** — direct better-sqlite3 in WAL mode for transcript streaming only.

3. **Start MCP/SSE server** — same `createMcpServer()` pattern as today, but tool handlers are HTTP proxies to the guild's Tool API with retry/backoff.

4. **Prepare session files** — tmpDir, system prompt file, mcp-config.json pointing to babysitter's MCP server.

5. **Spawn claude** — child process with NDJSON stdout capture.

6. **Report running** — call `session-running` tool on guild via HTTP (retry + DLQ).

7. **Stream transcript** — parse NDJSON, accumulate transcript, flush to `books_animator_transcripts` in SQLite on each buffer. This makes conversation content available in real-time to any consumer.

8. **Report result** — on claude exit, call `session-record` tool on guild via HTTP (retry + DLQ).

9. **Cleanup** — close MCP server, close SQLite, remove tmpDir, exit.

### Error Handling

Top-level try/catch. On unexpected error: attempt session-record with status failed, DLQ if that fails, cleanup, exit non-zero.

### Dependencies

- `better-sqlite3` — transcript streaming
- `@modelcontextprotocol/sdk` — MCP server
- NDJSON parsing functions from claude-code package
- `toolNameToRoute()` from Instrumentarium

---

## Provider Rewire

The claude-code provider's `launch()` method changes from spawning claude directly to spawning a babysitter. The babysitter is a detached process; the provider calls `proc.unref()` so the guild doesn't wait for it.

The AnimatorSessionProvider interface is preserved:
- **chunks** — completes immediately (empty). Real-time output is available via the transcripts book.
- **result** — polls sessions book for terminal status, or resolves immediately and lets Spider collect.
- **processInfo** — polls SessionDoc for cancelMetadata.pid (set by babysitter via session-running).

Tool definitions are serialized from Zod to JSON Schema for the babysitter config.

---

## What Changes vs Today

| Component | Today | Detached |
|---|---|---|
| Claude spawn | In-process child | Babysitter child (detached from guild) |
| MCP server | In-process, direct tool handlers | In babysitter, proxy handlers via HTTP |
| Transcript recording | End-of-session bulk write | Real-time streaming to SQLite |
| Session "running" status | In-process recordRunning() | session-running tool call via HTTP |
| Session result | In-process recordSession() | session-record tool call via HTTP |
| Real-time output | In-memory broadcaster | Direct transcript book query |
| Config delivery | In-process function args | JSON via stdin to babysitter |

## What Stays the Same

- **Spider tryCollect()** — reads session status from Stacks by polling. No changes.
- **Session cancel** — process.kill(pid, SIGTERM) works cross-process. No changes.
- **Loom** — resolves role → tools at dispatch time. Tool set passed to babysitter.
- **Codexes** — draft worktrees on filesystem, independent of process topology.
- **Laboratory CDC** — fires on tool handler writes and session lifecycle tools.

## Docker Extension Path

Docker sessions replace the babysitter's `spawn('claude', ...)` with a Docker container launch. The babysitter serves MCP over a network-accessible port. Claude in the container connects via container networking. Tool calls still proxy to guild HTTP API. Same architecture, different spawn mechanism.
