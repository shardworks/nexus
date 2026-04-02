# `@shardworks/animator-apparatus`

The Animator brings animas to life. It is the guild's session apparatus — the single entry point for making an anima do work. Two API levels serve different callers:

- **`summon()`** — the high-level "make an anima do a thing" call. Passes the role to The Loom for identity composition, then launches a session with the work prompt. This is what the summon relay, the CLI, and most callers use.
- **`animate()`** — the low-level call for callers that compose their own `AnimaWeave` (e.g. The Parlour for multi-turn conversations).

Both methods return an `AnimateHandle` synchronously — a `{ chunks, result }` pair. The `result` promise resolves when the session completes. The `chunks` async iterable yields output as the session runs when `streaming: true` is set; otherwise it completes immediately with no items.

Depends on `@shardworks/stacks-apparatus` for persistence. Uses `@shardworks/loom-apparatus` for context composition (resolved at call time by `summon()`, not a startup dependency). The session provider (e.g. `@shardworks/claude-code-apparatus`) is discovered at runtime via guild config.

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
console.log(session.status);           // 'completed' | 'failed' | 'timeout'
console.log(session.costUsd);          // 0.42
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

### Types

```typescript
interface SummonRequest {
  prompt: string;                // The work prompt (sent to provider directly)
  role?: string;                 // Role name (passed to The Loom for composition)
  cwd: string;                   // Working directory for the session
  conversationId?: string;       // Optional, for multi-turn resume
  metadata?: Record<string, unknown>; // Merged with { trigger: 'summon', role }
  streaming?: boolean;           // Enable streaming output (default false)
}

interface AnimateRequest {
  context: AnimaWeave;           // Pre-composed identity context
  prompt?: string;               // Work prompt (sent to provider as initialPrompt)
  cwd: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  streaming?: boolean;           // Enable streaming output (default false)
}

interface AnimateHandle {
  chunks: AsyncIterable<SessionChunk>; // Empty when not streaming
  result: Promise<SessionResult>;
}

interface SessionResult {
  id: string;                    // Generated by The Animator (ses-{hex})
  status: 'completed' | 'failed' | 'timeout';
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
}

type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };
```

## Configuration

The Animator reads its config from `guild.json["animator"]`:

```json
{
  "animator": {
    "sessionProvider": "claude-code"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `sessionProvider` | `string` | `'claude-code'` | Plugin id of the apparatus that implements `AnimatorSessionProvider`. Looked up via `guild().apparatus()`. |

## Session Provider Interface

Session providers are apparatus plugins whose `provides` object implements `AnimatorSessionProvider`:

```typescript
interface AnimatorSessionProvider {
  name: string;
  launch(config: SessionProviderConfig): Promise<SessionProviderResult>;
  launchStreaming?(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}

interface SessionProviderConfig {
  systemPrompt?: string;         // From AnimaWeave (Loom output)
  initialPrompt?: string;        // From AnimateRequest.prompt (work prompt)
  model: string;
  conversationId?: string;
  cwd: string;
}

interface SessionProviderResult {
  status: 'completed' | 'failed' | 'timeout';
  exitCode: number;
  error?: string;
  providerSessionId?: string;
  tokenUsage?: TokenUsage;
  costUsd?: number;
}
```

The Animator imports these types; provider packages import them from `@shardworks/animator-apparatus` and implement them.

## Support Kit

The Animator contributes a `sessions` book and inspection/dispatch tools:

### Books

| Book | Indexes | Description |
|---|---|---|
| `sessions` | `startedAt`, `status`, `conversationId`, `provider` | Session records — one per `animate()` call |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `session-list` | `read` | List recent sessions with optional filters (status, provider, conversationId, limit) |
| `session-show` | `read` | Show full detail for a single session by id |
| `summon` | `animate` | Summon an anima from the CLI — compose context and launch a session |

The `summon` tool is CLI-only (`callableBy: 'cli'`). It calls `animator.summon()` with the guild home as the working directory.

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
  type AnimatorSessionProvider,
  type SessionProviderConfig,
  type SessionProviderResult,
  type SessionDoc,
  type AnimatorConfig,
} from '@shardworks/animator-apparatus';
```

The default export is a pre-created apparatus plugin instance:

```typescript
import animator from '@shardworks/animator-apparatus';
// animator is { apparatus: { requires: ['stacks'], recommends: ['loom'], provides: AnimatorApi, ... } }
```
