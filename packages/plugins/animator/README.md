# `@shardworks/animator-apparatus`

The Animator brings animas to life. It is the guild's session apparatus — the single entry point for making an anima do work. Two API levels serve different callers:

- **`summon()`** — the high-level "make an anima do a thing" call. Passes the role to The Loom for identity composition, then launches a session with the work prompt. This is what the summon relay, the CLI, and most callers use.
- **`animate()`** — the low-level call for callers that compose their own `AnimaWeave` (e.g. The Parlour for multi-turn conversations). Rejects at the top with a synthesized `SessionResult { status: 'rate-limited', … }` when the rate-limit back-off machine is paused; no SessionDoc is written for the rejected call.
- **`getSessionCosts()`** — bulk per-session cost/token lookup for read-side consumers. First read-side helper on `AnimatorApi`; used by Spider's rig-view aggregator to compose rig-level totals and per-engine breakdowns without reaching into the `sessions` book directly.
- **`getStatus()`** — returns the rate-limit back-off state document verbatim (see § Rate-Limit Back-Off). Consumers compose their own dispatchability predicate: `state === 'running' OR pausedUntil <= now`.

Both methods return an `AnimateHandle` synchronously — a `{ chunks, result }` pair. The `result` promise resolves when the session completes. The `chunks` async iterable yields output as the session runs when `streaming: true` is set; otherwise it completes immediately with no items.

Depends on `@shardworks/stacks-apparatus` for persistence (session records and full transcripts). Uses `@shardworks/loom-apparatus` for context composition (resolved at call time by `summon()`, not a startup dependency). The session provider (e.g. `@shardworks/claude-code-apparatus`) is discovered at runtime via guild config.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/animator-apparatus": "workspace:*"
  }
}
```

## API

The Animator exposes its API via `guild().apparatus<AnimatorApi>('animator')`:

```typescript
import { guild } from '@shardworks/nexus-core';
import type { AnimatorApi } from '@shardworks/animator-apparatus';

const animator = guild().apparatus<AnimatorApi>('animator');
```

### `summon(request): AnimateHandle`

Summon an anima — compose context via The Loom and launch a session. This is the primary entry point for dispatching work. Returns synchronously.

```typescript
const { result } = animator.summon({
  prompt: 'Build the frobnicator module with tests',
  role: 'artificer',              // passed to The Loom for composition
  cwd: '/path/to/workdir',
  metadata: {                     // optional, merged with auto-generated metadata
    writId: 'wrt-8a4c9e2',
  },
});

const session = await result;
console.log(session.status);           // 'completed' | 'failed' | 'timeout' | 'cancelled'
console.log(session.costUsd);          // 0.42
console.log(session.output);           // final assistant message text
console.log(session.metadata?.trigger); // 'summon' (auto-populated)
console.log(session.metadata?.role);    // 'artificer' (auto-populated from request)
```

With streaming:

```typescript
const { chunks, result } = animator.summon({
  prompt: 'Build the frobnicator module with tests',
  role: 'artificer',
  cwd: '/path/to/workdir',
  streaming: true,
});

for await (const chunk of chunks) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
}

const session = await result;
```

The Loom owns system prompt composition — given the role, it produces the system prompt from the anima's identity layers (role instructions, curriculum, temperament, charter). The work prompt bypasses The Loom and goes directly to the session provider. At MVP, the Loom does not yet compose a system prompt (returns `undefined`); the session runs with the work prompt only. As the Loom gains composition logic, `summon()` callers get richer sessions without changing their code.

Requires The Loom apparatus to be installed. Throws with a clear error if not available.

### `animate(request): AnimateHandle`

Launch a session with a pre-composed context. Use this when you've already built an `AnimaWeave` yourself (e.g. The Parlour assembling inter-turn context for a multi-turn conversation). Returns synchronously.

```typescript
const { result } = animator.animate({
  context: animaWeave,            // from The Loom or self-composed
  prompt: 'Do the thing',         // work prompt, sent directly to provider
  cwd: '/path/to/workdir',
  conversationId: 'conv-xyz',    // optional, for multi-turn resume
  metadata: {                     // optional, recorded as-is
    trigger: 'consult',
    animaName: 'coco',
  },
});

const session = await result;
```

With streaming:

```typescript
const { chunks, result } = animator.animate({
  context: animaWeave,
  prompt: 'Build the feature',
  cwd: '/path/to/workdir',
  streaming: true,
});

for await (const chunk of chunks) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
}

const session = await result;
```

If the session provider doesn't support streaming, `chunks` completes immediately with no items and `result` resolves normally via the non-streaming path — regardless of the `streaming` flag.

### `cancel(sessionId, options?): Promise<SessionDoc>`

Cancel a running session. Patches the SessionDoc to `'cancelled'` with `endedAt`, `durationMs`, and an optional reason. If the provider supports cancellation and `cancelHandle` is available, delegates to the provider's `cancel()` method to kill the process.

```typescript
const doc = await animator.cancel(sessionId, { reason: 'Cost overrun' });
console.log(doc.status);  // 'cancelled'
console.log(doc.error);   // 'Cost overrun'
```

**Idempotent:** calling `cancel()` on a session that is already in a terminal state (`completed`, `failed`, `timeout`, `cancelled`) returns the existing SessionDoc without modification. Throws if the session ID does not exist.

**Cross-process:** the `cancelHandle` field on `SessionDoc` stores a tagged cancel handle for cross-process cancellation (e.g. `{ kind: 'local-pgid', pgid: number }` for local process groups). This allows any process with Stacks access to cancel a session launched by another process.

### `getSessionCosts(sessionIds): Promise<Map<string, SessionCost>>`

Bulk per-session cost/token lookup. Resolves cost and token-usage snapshots for the given session ids in a single round-trip against the sessions book. Intended for UI-facing aggregators that compose rig-level totals or per-engine breakdowns.

```typescript
const costs = await animator.getSessionCosts(['ses-a', 'ses-b', 'ses-missing']);
costs.get('ses-a');        // { costUsd: 0.15, inputTokens: 1000, outputTokens: 200 }
costs.get('ses-missing');  // undefined — ids not present in the book are omitted
```

**Missing ids:** session ids not present in the sessions book are omitted from the returned Map. Callers decide whether that means "zero contribution" (Spider's rig-view does) or something else.

**Empty input:** returns an empty Map without touching The Stacks.

**Shape:** deliberately minimal — `costUsd` (zero when the session exists but has not reported cost), plus optional `inputTokens` / `outputTokens` when the provider reported token usage. Consumers that need other `SessionDoc` fields should look them up separately.

### Types

```typescript
interface SummonRequest {
  prompt: string;                // The work prompt (sent to provider directly)
  role?: string;                 // Role name (passed to The Loom for composition)
  cwd: string;                   // Working directory for the session
  conversationId?: string;       // Optional, for multi-turn resume
  metadata?: Record<string, unknown>; // Merged with { trigger: 'summon', role }
  environment?: Record<string, string>; // Per-request env overrides (merged with weave)
  streaming?: boolean;           // Enable streaming output (default false)
}

interface AnimateRequest {
  context: AnimaWeave;           // Pre-composed identity context
  prompt?: string;               // Work prompt (sent to provider as initialPrompt)
  cwd: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  environment?: Record<string, string>; // Per-request env overrides (merged with weave)
  streaming?: boolean;           // Enable streaming output (default false)
}

interface AnimateHandle {
  chunks: AsyncIterable<SessionChunk>; // Empty when not streaming
  result: Promise<SessionResult>;
}

interface SessionResult {
  id: string;                    // Generated by The Animator (ses-{hex})
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
  startedAt: string;             // ISO-8601
  endedAt: string;               // ISO-8601
  durationMs: number;
  provider: string;              // e.g. 'claude-code'
  exitCode: number;
  error?: string;
  conversationId?: string;
  providerSessionId?: string;
  tokenUsage?: TokenUsage;
  costUsd?: number;
  metadata?: Record<string, unknown>;
  output?: string;               // Final assistant message text
}

type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };

interface SessionCost {
  costUsd: number;               // Zero when the session exists but has not reported cost
  inputTokens?: number;          // From the session's tokenUsage, if reported
  outputTokens?: number;         // From the session's tokenUsage, if reported
}
```

## Configuration

The Animator reads its config from `guild.json["animator"]`:

```json
{
  "animator": {
    "sessionProvider": "claude-code",
    "rateLimitBackoff": {
      "initialMs": 900000,
      "maxMs": 3600000,
      "factor": 2
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `sessionProvider` | `string` | `'claude-code'` | Plugin id of the apparatus that implements `AnimatorSessionProvider`. Looked up via `guild().apparatus()`. |
| `rateLimitBackoff.initialMs` | `number` | `900_000` (15 min) | Initial pause window when the first rate-limit hit arrives. |
| `rateLimitBackoff.maxMs` | `number` | `3_600_000` (1 h) | Upper bound for the pause window after exponential back-off. |
| `rateLimitBackoff.factor` | `number` | `2` | Multiplier applied per successive failed resume attempt. |

The `rateLimitBackoff` block is validated fail-loud at startup (a patron override of the Animator's default silent-default convention, scoped to this block only). Malformed values throw; a missing block uses the defaults.

## Session Provider Interface

Session providers are apparatus plugins whose `provides` object implements `AnimatorSessionProvider`:

```typescript
interface AnimatorSessionProvider {
  name: string;
  launch(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
    processInfo?: Promise<Record<string, unknown>>; // e.g. { kind: 'local-pgid', pgid: number }
  };
  cancel?(cancelMetadata: Record<string, unknown>): Promise<void>;
}

interface SessionProviderConfig {
  systemPrompt?: string;         // From AnimaWeave (Loom output)
  initialPrompt?: string;        // From AnimateRequest.prompt (work prompt)
  model: string;
  conversationId?: string;
  cwd: string;
  environment?: Record<string, string>; // Merged env vars (weave + request overrides)
}

interface SessionProviderResult {
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
  exitCode: number;
  error?: string;
  providerSessionId?: string;
  tokenUsage?: TokenUsage;
  costUsd?: number;
  transcript?: TranscriptMessage[];  // Full NDJSON message array
  output?: string;                   // Final assistant message text
  /**
   * Structured termination tag. Providers attach this when the terminal
   * status reflects a specific detected condition (today: rate-limit).
   * The Animator forwards it onto the SessionDoc / SessionResult so
   * downstream consumers don't have to pattern-match freeform error text.
   */
  terminationTag?: { kind: 'rate-limit'; source: 'ndjson-result'; detail?: string };
}
```

The Animator imports these types; provider packages import them from `@shardworks/animator-apparatus` and implement them.

## Oculus Page

The Animator contributes an **Animator** page to the Oculus dashboard (`id: 'animator'`) for viewing and managing sessions.

### Session List

- Displays sessions with status badge, role, writ title, cost (with token breakdown tooltip on hover), duration, and start time.
- Filters: status dropdown, date range (from/to).
- Auto-refreshes every 12 seconds.
- Running sessions show a **Cancel** button.

### Session Detail

Click a session row to view full metadata, a real-time session log (SSE streaming for running sessions), and the full transcript.

### Custom Routes

Three API routes under `/api/animator/`:

| Route | Description |
|---|---|
| `GET /api/animator/status` | Returns the rate-limit back-off status doc verbatim (`state`, `pausedUntil`, `backoffLevel`, …). Drives the Spider Oculus pause banner. |
| `GET /api/animator/sessions` | Enriched session list with `role`, `writTitle` (resolved from Clerk), and `tokenUsage`. Supports `status`, `from`, `to`, `limit` query params. |
| `GET /api/animator/session-transcript` | Returns `{ messages, sessionStatus }` for a session. |
| `GET /api/animator/session-stream` | SSE stream — emits `chunk`, `transcript`, and `done` events. Handles completed sessions, running sessions with/without broadcaster. |

## Support Kit

The Animator contributes two books, inspection/dispatch tools, an Oculus page, and custom routes:

### Books

| Book | Indexes | Description |
|---|---|---|
| `sessions` | `startedAt`, `status`, `conversationId`, `provider` | Session records — one per `animate()` call. Includes `output` (final assistant text). |
| `transcripts` | `sessionId` | Full NDJSON transcripts — one per session. Drives web UIs, operational logs, debugging. |
| `state` | — | Operational state (guild self-heartbeat). Single well-known document `guild-heartbeat`. |
| `status` | — | Rate-limit back-off state. Single well-known document `current`. See § Rate-Limit Back-Off. |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `session-list` | `read` | List recent sessions with optional filters (status, provider, conversationId, limit) |
| `session-show` | `read` | Show full detail for a single session by id |
| `summon` | `animate` | Summon an anima from the CLI — compose context and launch a session |
| `session-cancel` | `animate` | Cancel a running session by id, with optional reason |
| `session-running` | `write` | Record initial "running" state for a detached session |
| `session-record` | `write` | Record a terminal session result for a detached session |
| `session-heartbeat` | `write` | Refresh session liveness timestamp (called periodically by babysitters) |
| `animator-status` | `read` | Show the Animator's current rate-limit pause state (`--json` for machine-parseable output) |

The `summon` and `session-cancel` tools are patron-only (`callableBy: 'patron'`). The `session-running`, `session-record`, and `session-heartbeat` tools are infrastructure-facing (`callableBy: 'anima'`) — called by session babysitters over the Tool HTTP API to report detached session lifecycle events. See `docs/architecture/detached-sessions.md`.

### Startup Routines

On startup the Animator runs recovery and starts background timers (all non-blocking):

1. **DLQ Drain** — Scans `.nexus/dlq/` for JSON files containing session-record payloads that babysitters couldn't deliver (guild was down). Each file is processed through the session-record handler and deleted on success. The directory is created if it doesn't exist.

2. **Downtime Credit** — Reads the previous `guild-heartbeat` document from the `state` book to compute how long the guild was down. This credit is applied to the initial reconciliation pass so sessions that were healthy before the guild went down aren't falsely marked as stale.

3. **Heartbeat-based Reconciliation** — Scans sessions in `pending` and `running` states. When `now - lastActivityAt - downtimeCredit > 90s`, the session is transitioned to `failed`. Sessions without `lastActivityAt` (legacy) are backfilled and skipped for one pass. Runs once at startup (with downtime credit) and then periodically every 30s (without credit) via an unref'd timer with a single-flight guard.

4. **Guild Self-Heartbeat** — Writes `guildAliveAt` to the `state` book every 30s via an unref'd timer. This timestamp is used to compute the downtime credit on the next startup.

## Rate-Limit Back-Off

When the claude-code provider (or any future provider that sets a `terminationTag`) reports a rate-limited session terminal, the Animator opens a pause window that blocks further dispatch across every caller — Spider, Parlour, and CLI paths alike. The state lives in a single-row `status` book keyed at `'current'`:

```typescript
interface AnimatorStatusDoc {
  id: 'current';
  state: 'running' | 'paused';
  pausedSince?: string;
  pausedUntil?: string;
  pauseReason?: 'rate-limit';
  backoffLevel: number;
  backoffLastHitAt?: string;
  lastTriggeringSession?: string;
}
```

State transitions:

- **Rate-limited terminal while running** → opens a fresh pause with `pausedUntil = now + initialMs`, `backoffLevel: 0`.
- **Rate-limited terminal while paused (no resume dispatch yet)** → coalesces; level and bounds unchanged.
- **Rate-limited terminal after a resume attempt dispatched** → increments `backoffLevel`, multiplies the window by `factor`, caps at `maxMs`.
- **Any non-rate-limit terminal** → resets `backoffLevel` to `0` and flips state to `running`.

`animate()` pre-checks the cached status at the top of the function. When paused and `pausedUntil > now`, it returns a handle whose `result` resolves to a synthesized `SessionResult { status: 'rate-limited', terminationTag, … }` and no SessionDoc is written. In-flight sessions are not proactively cancelled.

Daemon restarts leave the persisted doc untouched; the first dispatch after `pausedUntil` elapses naturally flips the state back to `running` (the "natural probe" semantic).

## Exports

The main export provides the apparatus factory, API types, and provider interface types:

```typescript
import {
  createAnimator,
  type AnimatorApi,
  type AnimateHandle,
  type AnimateRequest,
  type SummonRequest,
  type SessionResult,
  type SessionChunk,
  type TokenUsage,
  type SessionCost,
  type AnimatorSessionProvider,
  type SessionProviderConfig,
  type SessionProviderResult,
  type SessionDoc,
  type TranscriptDoc,
  type TranscriptMessage,
  type AnimatorConfig,
  type AnimatorRateLimitBackoffConfig,
  type AnimatorStatusDoc,
  type AnimatorPauseReason,
  type SessionTerminationTag,
} from '@shardworks/animator-apparatus';
```

The default export is a pre-created apparatus plugin instance:

```typescript
import animator from '@shardworks/animator-apparatus';
// animator is { apparatus: { requires: ['stacks'], recommends: ['loom'], provides: AnimatorApi, ... } }
```
