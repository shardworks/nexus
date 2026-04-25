# The Spider — API Contract

Status: **Ready — MVP**

Package: `@shardworks/spider-apparatus` · Plugin id: `spider`

> **⚠️ MVP scope.** This spec covers a static rig graph: every commission gets the same five-engine pipeline (`draft → implement → review → revise → seal`). No origination, no dynamic extension, no capability resolution. The Spider runs engines directly — the Executor earns its independence later. See [What This Spec Does NOT Cover](#what-this-spec-does-not-cover) for the full list.

---

## Purpose

The Spider is the spine of the guild's rigging system. It runs a structured engine pipeline for each commission, advancing the rig one step at a time via a `crawl()` step function.

The Spider owns the rig's structural lifecycle — spawn, traverse, complete — and delegates everything else. Engine designs come from the Fabricator. Sessions come from the Animator. Draft bindings come from the Scriptorium. Writ transitions are handled by a CDC handler, not inline. The Spider itself is stateless between `crawl()` calls; all state lives in the Stacks.

---

## Dependencies

```
requires: ['fabricator', 'clerk', 'stacks']
```

- **The Fabricator** — resolves engine designs by `designId`.
- **The Clerk** — queries open writs; receives writ transitions via CDC; triggers rig cancellation via CDC on writs book.
- **The Stacks** — persists rigs book, reads sessions and writs books, hosts CDC handlers on both rigs and writs books.

Engines pull their own apparatus dependencies (Scriptorium, Animator, Loom) via the `guild()` singleton — these are not Spider dependencies.

### Reference docs

- **The Rigging System** (`docs/architecture/rigging.md`) — full rigging architecture (Spider, Fabricator, Executor, Manifester). This spec implements a subset.
- **The Fabricator** (`docs/architecture/apparatus/fabricator.md`) — engine design registry and `EngineDesign` type definitions.
- **The Scriptorium** (`docs/architecture/apparatus/scriptorium.md`) — draft binding API (`openDraft`, `seal`, `abandonDraft`).
- **The Animator** (`docs/architecture/apparatus/animator.md`) — session API (`summon`, `animate`), `AnimateHandle`, `SessionResult`.
- **The Clerk** (`docs/architecture/apparatus/clerk.md`) — writ lifecycle API.
- **The Stacks** (`docs/architecture/apparatus/stacks.md`) — CDC phases, cascade vs notification, `watch()` API.

---

## The Engine Interface

Engines are the unit of work in a rig. Each engine implements a standard interface defined by the Fabricator apparatus (`@shardworks/fabricator-apparatus`). The `EngineDesign`, `EngineRunContext`, and `EngineRunResult` types are owned and exported by the Fabricator — see the Fabricator spec (`docs/architecture/apparatus/fabricator.md`) for full type definitions. Engines pull their own apparatus dependencies via `guild().apparatus(...)` — same pattern as tool handlers.

The Spider resolves engine designs by `designId` from the Fabricator at runtime: `fabricator.getEngineDesign(id)`.

### Kit contribution

The Spider contributes its five engine designs via its support kit:

```typescript
// In spider-apparatus plugin
supportKit: {
  engines: {
    'draft':          draftEngine,
    'implement':      implementEngine,
    'review':         reviewEngine,
    'revise':         reviseEngine,
    'seal':           sealEngine,
    'anima-session':  animaSessionEngine,
    'manual-merge':   manualMergeEngine,
  },
  roles: {
    'mender': { permissions: [], instructionsFile: 'loom-roles/mender.md' },
  },
  tools: [crawlOneTool, crawlContinualTool],
},
```

The `manual-merge` engine is grafted onto the rig by `seal` when Scriptorium reports a rebase-conflict failure; it is not part of the static five-engine template. The `mender` role is registered through Loom's role-kit contribution path so the Spider can summon the mender anima without the guild operator adding anything to `guild.json`. See the [`seal` engine section](#seal-clockwork) for the recovery tail contract.

The Fabricator scans kit `engines` contributions at startup (same pattern as the Instrumentarium scanning tools). The Spider contributes its engines like any other kit — no special registration path.

---

## The Walk Function

The Spider's core is a single step function:

```typescript
interface SpiderApi {
  /**
   * Examine guild state and perform the single highest-priority action.
   * Returns a description of what was done, or null if there's nothing to do.
   */
  crawl(): Promise<CrawlResult | null>
}

type CrawlResult =
  | { action: 'engine-completed'; rigId: string; engineId: string }
  | { action: 'engine-started';   rigId: string; engineId: string }
  | { action: 'engine-held';      rigId: string; engineId: string; holdReason: string }
  | { action: 'engine-retrying';  rigId: string; engineId: string; attemptCount: number }
  | { action: 'engine-skipped';   rigId: string; engineId: string; cascadeSkipped?: string[] }
  | { action: 'engine-grafted';   rigId: string; engineId: string; graftedEngineIds: string[] }
  | { action: 'rig-spawned';      rigId: string; writId: string }
  | { action: 'rig-completed';    rigId: string; writId: string; outcome: 'completed' | 'failed' | 'cancelled' }
  | { action: 'writ-unstuck';     writId: string }
```

The variants describe the shapes of the actions the crawl loop reports:

- `engine-completed` — an engine reached `'completed'` (collected from a session terminal, or finished inline as a clockwork run). The rig is still running.
- `engine-started` — a quick engine's `run()` returned `'launched'`; the engine moved to `'running'` and the loop will poll its session on subsequent ticks.
- `engine-held` — a pending engine entered (or remained in) a hold; `holdReason` carries the BlockType id or the `'retry-backoff'` sentinel. Other engines in the rig may still be running.
- `engine-retrying` — a transient failure routed through the unified failure handler's retryable-within-budget branch; the engine is now `'pending'` with `holdReason = 'retry-backoff'` and `attemptCount` reflects the just-incremented value.
- `engine-skipped` — an engine's `when` expression evaluated false; the engine moved to `'skipped'`. `cascadeSkipped` lists any downstream conditional engines that cascade-skipped on the same tick.
- `engine-grafted` — an engine's run or collect produced a `graft` request; new engine slots were appended to the rig. `graftedEngineIds` lists the appended engines in declaration order.
- `rig-spawned` — a new rig was created for a ready writ.
- `rig-completed` — the tick caused a rig to reach a terminal state. `outcome` is restricted to `'completed' | 'failed' | 'cancelled'` — there is no `'stuck'` outcome (engine-failure terminal goes to `'failed'` directly via the unified failure handler).
- `writ-unstuck` — the auto-unstick scan returned a writ from `phase = 'stuck'` to `'open'` because every recorded cause cleared (every `failed-blocker` reached `'completed'`, or a `cycle` was broken by external action).

Each `crawl()` call does exactly one thing. The priority ordering, in the six phases the tick walks in turn:

1. **Collect terminal sessions (`tryCollect`).** Scan running engines for sessions that have reached a terminal status. For each, drive the engine's terminal outcome through `collect()` (or the generic default yields) and into the unified failure handler when the session failed; this can leave the engine `'completed'`, `'failed'` (terminal), `'pending'` (rate-limit hold or retry back-off), or — when the rig completes — drive a `rig-completed`. Collection runs first so downstream engines see freed upstreams as soon as possible.
2. **Process grafts (`tryProcessGrafts`).** Apply any deferred `graft` requests carried out of step 1's collected results, validating against the per-rig engine cap and template constraints before appending. A graft validation failure routes through the unified failure handler's terminal branch.
3. **Run a ready engine (`tryRun`).** Find the highest-priority engine for which `evaluateDispatchPredicate(engine, rig)` returns true (see [Dispatch predicate](#dispatch-predicate)). Append a fresh `attempts[]` row, then call `design.run()` for clockwork engines or launch a session via `summon` for quick engines. Failures in this phase route through the unified failure handler.
4. **Auto-unstick (`autoUnstick`).** Scan writs in `phase = 'stuck'` whose `status.spider.stuckCause` is one of the dependency-recovery causes (`'failed-blocker'`, `'cycle'`) and return any whose recorded blockers have all cleared back to `'open'`. Operator-stuck writs and writs with no `status.spider` slot are left alone.
5. **Animator pause gate.** If the Animator's global pause flag is set (rate-limit ceiling reached), short-circuit before spawning new rigs — running engines and ongoing collection still proceed, but no new dispatch slot is opened. The dispatch predicate in step 3 also honours this gate via the `animator-paused` BlockType.
6. **Spawn a rig (`trySpawn`).** If an open writ has no rig and a `rigTemplateMappings` entry exists for its type, spawn the rig from the mapped template and return `rig-spawned`. Unmapped writ types remain in `'open'` for non-dispatch handling.

**Dispatch precedence is: config wins over kit; two kits are a hard error.** A config-level `rigTemplateMappings` entry always wins over any kit contribution for the same writ type. Two kits contributing a mapping for the same writ type is a guild-config hazard and fails the guild at startup — the error names both contributing plugins and the conflicting writ type. Operators resolve by removing one of the kit mappings or by overriding via `spider.rigTemplateMappings` in `guild.json`. The winner is never selected by kit load order. This same fail-loud rule applies framework-wide at every kit-vs-kit merge site — Clerk `writTypes`, Spider `blockTypes`, and Fabricator engine designs all refuse to start under a duplicate contribution with the same error shape.

If nothing qualifies at any level, return null (the guild is idle, every candidate writ is gated on non-terminal `spider.follows` blockers, or all work is blocked on running quick engines).

### Operational model

The Spider exports two tools:

```
nsg crawl-continual   # starts polling loop, crawls every ~5s, runs indefinitely
nsg crawl-one         # single step (useful for debugging/testing)
```

The `crawl-continual` loop: call `crawl()`, sleep `pollIntervalMs` (default 5000), repeat. When `crawl()` returns null, the loop doesn't stop — it keeps polling. New writs posted via `nsg commission-post` from a separate terminal are picked up on the next poll cycle. Pass `--maxIdleCycles N` to stop after N consecutive idle cycles.

---

## Rig Data Model

### Rig

```typescript
type RigStatus = 'running' | 'completed' | 'failed' | 'cancelled'

interface Rig {
  id: string
  writId: string
  status: RigStatus
  engines: EngineInstance[]
  createdAt: string                // ISO-8601, written at rig spawn
  terminalAt?: string              // ISO-8601, set the FIRST time the rig enters a terminal status
  cancelledAt?: string             // ISO-8601, set when an operator cancels the rig via SpiderApi.cancel
  resolutionEngineId?: string      // engine id whose yields supply the writ's resolution summary
}
```

Stored in the Stacks `rigs` book. One rig per writ. The Spider reads and updates rigs via normal Stacks `put()`/`patch()` operations.

**Rig status is derived.** The Spider never writes `status` independently — it is a pure projection of the rig's engine states plus the operator-cancel marker, recomputed via `deriveRigStatus(rig)` after every engine-state mutation. The rules, in order:

- If `cancelledAt` is set, the rig is `'cancelled'` (operator-cancel short-circuit — the rollup never reverts to `'running'` once the operator has cancelled).
- Else, if any engine has `status === 'running'`, the rig is `'running'`.
- Else, if any engine has `status === 'failed'` (and no engine is running), the rig is `'failed'`.
- Else, if every engine is terminal and at least one engine has `status === 'completed'`, the rig is `'completed'`.
- Else (every engine is terminal and none completed — i.e. all-skipped or all-cancelled), the rig is `'cancelled'`.

> **Note (legacy tolerance).** Rigs persisted before this reshape may carry the historical `'stuck'` or `'blocked'` status values. The new state machine writes neither — engine failure now retries in place and, on exhaustion, transitions the rig directly to `'failed'` (see [Engine Failure](#engine-failure)). Readers and filters tolerate the legacy strings without crashing; operators can recover lingering pre-reshape stucks via `nsg writ-rescue-stuck`.

**`terminalAt` — keep-first terminal timestamp.** The Spider writes `terminalAt` in the same transaction as every rig terminal-status transition (`completed`, `failed`, `cancelled`), routed through a single `terminalAtPatch(rig)` helper. The helper returns `{}` if `rig.terminalAt` is already set, pinning the moment the rig first stopped making forward progress. Downstream observers (the dashboard's end-time display, the timeseries view) need this earlier timestamp so elapsed-time readings don't jump on subsequent transitions (e.g. `failed → cancelled`). Rigs persisted before `terminalAt` existed simply omit the field; consumers fall back to the latest `attempts[-1].endedAt` across engines and finally to `rig.createdAt`.

**`resolutionEngineId` — resolution summary anchor.** Set at rig spawn time from the rig template's `resolutionEngine` field. Names the engine whose yields the CDC handler reads when composing the writ's resolution message on `rig→completed`. See [CDC Handlers](#cdc-handlers) for the three-step fallback ladder.

### Engine Instance

```typescript
type EngineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'

interface EngineAttempt {
  startedAt: string                   // ISO-8601, written when the dispatcher picks the engine up
  endedAt?: string                    // ISO-8601, written by the failure / success handler at attempt close
  status?: 'completed' | 'failed'     // terminal attempt outcome; absent while in-flight
  error?: string                      // error message if the attempt failed
  sessionId?: string                  // Animator session id for this attempt, if any
  yields?: unknown                    // yields produced when the attempt completed
}

interface EngineInstance {
  id: string                          // unique within the rig (e.g. 'draft', 'implement')
  designId: string                    // engine design id — resolved from the Fabricator
  status: EngineStatus
  upstream: string[]                  // ids of engines that must complete first (empty = first engine)
  givensSpec: Record<string, unknown> // spawn-time-resolved givens; ${yields.*} stays literal until run-time
  when?: string                       // optional conditional activation expression (template syntax)

  // Per-dispatch history — `attempts[attempts.length - 1]` is authoritative for
  // the latest sessionId, yields, error, and timestamps. Engine-level scalar
  // `yields` / `error` / `sessionId` / `startedAt` / `completedAt` no longer
  // exist; downstream code reads through the latest attempt row.
  attempts?: EngineAttempt[]
  attemptCount?: number               // retry-budget counter; only the retryable-within-budget branch increments

  // Hold metadata — present only while the engine is `'pending'` due to a
  // back-off window or an external-gate BlockType. Cleared when the hold
  // resolves (poll-clear, window expiration, or operator resume).
  holdUntil?: string                  // ISO-8601 — engine may not dispatch before this stamp
  holdReason?: string                 // BlockType id ('animator-paused', 'writ-phase', …) or 'retry-backoff'
  holdCondition?: unknown             // BlockType-specific condition payload (validated by conditionSchema)
  lastCheckedAt?: string              // ISO-8601 — last dispatch-predicate check, gated by pollIntervalMs
}
```

**`EngineStatus` — the six-value engine lifecycle.**

- `'pending'` — awaiting dispatch. Covers both "not yet tried" and "held" engines; a hold is represented as `pending` plus `holdReason` / `holdUntil` / `holdCondition` metadata on the engine instance. The dispatch predicate (see [Dispatch predicate](#dispatch-predicate)) is the sole arbiter of when a pending engine actually runs.
- `'running'` — currently executing (a clockwork run in progress, or a launched anima session being polled by `tryCollect`).
- `'completed'` — finished successfully. The latest `attempts[]` row carries the yields.
- `'failed'` — terminally failed (retry budget exhausted, or the failure was definitional — graft validation, unknown design or block type, non-JSON-serializable yields).
- `'cancelled'` — cancelled by operator action or by cascade from a failed upstream engine.
- `'skipped'` — the engine's `when` expression evaluated false; the engine was never run, and its downstream conditional engines may have cascade-skipped in turn.

> **There is no engine-level `'blocked'` value.** Holds live entirely on the `'pending'` row via the hold-metadata fields. Anything a previous design called "blocked" is now "pending with `holdReason`".

An engine is **ready** when: `status === 'pending'`, every upstream engine is in `'completed'` or `'skipped'`, no `holdUntil` is set in the future, and (for an external-gate hold) the registered BlockType's `check()` returns `'cleared'`. See [Dispatch predicate](#dispatch-predicate) for the full check.

### The Static Graph

Every spawned rig gets this engine list:

```typescript
function spawnStaticRig(writ: Writ, config: SpiderConfig): EngineInstance[] {
  return [
    { id: 'draft',     designId: 'draft',     status: 'pending', upstream: [],
      givensSpec: { writ }, attempts: [] },
    { id: 'implement', designId: 'implement', status: 'pending', upstream: ['draft'],
      givensSpec: { writ, role: config.role }, attempts: [] },
    { id: 'review',    designId: 'review',    status: 'pending', upstream: ['implement'],
      givensSpec: { writ, role: 'reviewer', buildCommand: config.buildCommand, testCommand: config.testCommand }, attempts: [] },
    { id: 'revise',    designId: 'revise',    status: 'pending', upstream: ['review'],
      givensSpec: { writ, role: config.role }, attempts: [] },
    { id: 'seal',      designId: 'seal',      status: 'pending', upstream: ['revise'],
      givensSpec: {}, attempts: [] },
  ]
}
```

The `givensSpec` is populated from the Spider's config at rig spawn time. The rig is self-contained after spawning — no runtime config lookups needed. The `writ` is passed as a given to engines that need it (most do; `seal` doesn't). All engines start with `attempts: []` — yields are populated on the latest attempt row when the engine completes (see [Yield Types](#yield-types-and-data-flow)).

The rig's status is derived from the engine states by `deriveRigStatus(rig)` after every engine-state mutation — see [Rig status is derived](#rig). When the terminal engine (`seal`) reaches `'completed'`, the rollup yields `'completed'`. When any engine terminally fails and no engine is running, the rollup yields `'failed'`.

### Pending engines and hold metadata

The `'pending'` status carries three operationally distinct shapes that the dispatch predicate distinguishes by hold metadata:

- **Fresh pending.** No hold fields are set. The engine has either never been dispatched or its prior attempt completed and a downstream engine is still propagating. The dispatch predicate runs the upstream / `holdUntil` / BlockType checks against an empty hold; the engine dispatches as soon as upstream is ready.
- **Rate-limit hold.** The engine returned to `'pending'` from the rate-limit branch of the unified failure handler: `holdReason = 'animator-paused'`, `holdCondition = { sessionId }`, and `holdUntil` is set when the Animator's back-off carries a deadline. **`attemptCount` is NOT incremented** — the engine yielded its slot to the rate limiter, not to a budget-consuming retry. The latest `attempts[]` row is closed without an `error` (the rate-limit terminal is not classified as a retryable failure).
- **Retry back-off hold.** The engine returned to `'pending'` from the retryable-within-budget branch: `holdReason = 'retry-backoff'`, `holdUntil` is set from the configured back-off, and `attemptCount` IS incremented (this attempt has consumed budget). The latest `attempts[]` row is closed with `status: 'failed'` and the captured `error`.

In all three shapes the latest `attempts[]` row is authoritative for `yields` / `error` / `sessionId` — there are no scalar engine-level mirrors of those fields. `lastCheckedAt` is updated by the dispatch predicate every time it consults a registered BlockType, and `pollIntervalMs` (declared by the BlockType) gates whether `check()` actually re-runs on a given crawl.

### Dispatch predicate

A pending engine is dispatchable when, and only when, **all** of the following hold (`evaluateDispatchPredicate(engine, rig)`):

1. `engine.status === 'pending'`.
2. Every engine in `engine.upstream` has terminal status `'completed'` or `'skipped'`.
3. Either `engine.holdUntil` is absent, or its ISO timestamp is in the past (the back-off window has elapsed).
4. Either no `holdReason` is set (no external gate), or the registered BlockType's `check(holdCondition)` returns `{ status: 'cleared' }` — honouring the BlockType's `pollIntervalMs` against `lastCheckedAt`, so `check()` re-runs at most once per declared interval.

The predicate is the single source of truth for "may this engine run now?" — `tryRun` uses it directly and never recomputes any of the four checks itself.

`'retry-backoff'` is an internal sentinel and is **not** registered as a BlockType — its hold is purely timer-driven, so check 4 is skipped when `holdReason === 'retry-backoff'` and check 3 alone clears the hold. All other registered hold reasons (`'animator-paused'`, `'writ-phase'`, `'scheduled-time'`, `'patron-input'`, `'book-updated'`, …) flow through the BlockType's `check()`.

When a hold clears, the predicate surfaces the cleared hold as a `priorBlock` advisory on `EngineRunContext` — the dispatched engine receives `priorBlock = { reason, condition }` describing what was just released. Engines are not required to consume it; it exists so engines that care (e.g. an idempotency-sensitive run) can branch on the unblock reason.

A `'failed'` result from a BlockType's `check()` is **not** a transient signal — the dispatch predicate routes the engine straight through the unified failure handler's terminal branch with the BlockType's optional `reason` recorded as the engine's error. The engine never runs.

---

## Yield Types and Data Flow

Each engine produces typed yields that downstream engines consume. The yields are stored on the latest `EngineInstance.attempts[]` row (`attempts[attempts.length - 1].yields`) — there is no scalar `yields` mirror on the engine instance.

**Serialization constraint:** Because yields are persisted to the Stacks (JSON-backed), all yield values **must be JSON-serializable**. The Spider validates this at storage time — if an engine returns a non-serializable value (function, circular reference, etc.), the failure routes through the unified failure handler's terminal branch (definitional failure) and the engine moves to `'failed'`. This is important because engines are a plugin extension point — kit authors need a hard boundary, not a silent corruption.

When the Spider runs an engine, it assembles givens from the givensSpec. Givens template expressions using `${yields.*}` syntax are resolved at engine start time from upstream yields (see [Givens Template Expressions](#givens-template-expressions)). All upstream yields are also available via the `context.upstream` escape hatch:

```typescript
function assembleGivensAndContext(rig: Rig, engine: EngineInstance) {
  // Collect all completed engine yields for the context escape hatch.
  // All completed yields are included regardless of graph distance —
  // simpler than chain-walking and equivalent for the static graph.
  const upstream: Record<string, unknown> = {}
  for (const e of rig.engines) {
    if (e.status === 'completed') {
      const last = e.attempts?.[e.attempts.length - 1]
      if (last?.yields !== undefined) upstream[e.id] = last.yields
    }
  }

  // Givens = givensSpec only. Upstream data stays on context.
  const givens = { ...engine.givensSpec }

  const context: EngineRunContext = {
    engineId: engine.id,
    upstream,
  }

  return { givens, context }
}
```

Givens contain only what the givensSpec declares — static values set at rig spawn time (writ, role, buildCommand, etc.). Engines that need upstream data (worktree path, review findings, etc.) pull it from `context.upstream` by engine id. This keeps the givens contract clean: what you see in the givensSpec is exactly what the engine receives.

### `DraftYields`

```typescript
interface DraftYields {
  draftId: string         // the draft binding's unique id (from DraftRecord.id)
  codexName: string       // which codex this draft is on (from DraftRecord.codexName)
  branch: string          // git branch name for the draft (from DraftRecord.branch)
  path: string            // absolute path to the draft worktree (from DraftRecord.path)
  baseSha: string         // commit SHA at draft open — used to compute diffs later
}
```

**Produced by:** `draft` engine
**Consumed by:** all downstream engines. Establishes the physical workspace.

> **Note:** Field names mirror the Scriptorium's `DraftRecord` type (`codexName`, `branch`, `path`) rather than inventing Spider-specific aliases. `baseSha` is the only field the draft engine adds itself — by reading `HEAD` after opening the draft.

### `ImplementYields`

```typescript
interface ImplementYields {
  sessionId: string
  sessionStatus: 'completed' | 'failed'
  conversationId?: string
}
```

**Produced by:** `implement` engine (set by Spider's collect step when session completes)
**Consumed by:** `review` (needs to know the session completed)

### Default Quick-Engine Yields

Quick engines that define no custom `collect` method receive the generic default yields:

```typescript
interface DefaultQuickYields {
  sessionId: string
  sessionStatus: 'completed' | 'failed'
  output?: string
  conversationId?: string
}
```

The `conversationId` is included when the session provider supports conversation resumption (e.g., Claude Code's `--resume`). This enables conversation chaining across engines via `${yields.<engineId>.conversationId}` in rig template givens. The `anima-session` engine relies on this for multi-step workflows where downstream engines resume an upstream engine's conversation.

### `ReviewYields`

```typescript
interface ReviewYields {
  sessionId: string
  passed: boolean                      // reviewer's overall assessment
  findings: string                     // structured markdown: what passed, what's missing, what's wrong
  mechanicalChecks: MechanicalCheck[]  // build/test results run before the reviewer session
}

interface MechanicalCheck {
  name: 'build' | 'test'
  passed: boolean
  output: string    // stdout+stderr, truncated to 4KB
  durationMs: number
}
```

**Produced by:** `review` engine
**Consumed by:** `revise` (needs `passed` to decide whether to do work, needs `findings` as context)

The `mechanicalChecks` are run by the engine *before* launching the reviewer session — their results are included in the reviewer's prompt.

### `ReviseYields`

```typescript
interface ReviseYields {
  sessionId: string
  sessionStatus: 'completed' | 'failed'
}
```

**Produced by:** `revise` engine (set by Spider's collect step when session completes)
**Consumed by:** `seal` (no data dependency — seal just needs revise to be done)

### `SealYields`

```typescript
interface SealYields {
  sealedCommit: string                     // the commit SHA at head of target after sealing (from SealResult)
  strategy: 'fast-forward' | 'rebase'      // merge strategy used (from SealResult)
  retries: number                          // rebase retry attempts needed (from SealResult)
  inscriptionsSealed: number               // number of commits incorporated (from SealResult)
}
```

**Produced by:** `seal` engine
**Consumed by:** nothing (terminal). Used by the CDC handler for the writ transition resolution message.

> **Note:** Field names mirror the Scriptorium's `SealResult` type. The Scriptorium's `seal()` method pushes the target branch to the remote after sealing.

### `SealRecoveryYields`

```typescript
interface SealRecoveryYields {
  ok: false                                  // always false — recovery is only reported on a failed attempt
  reason: string                             // Scriptorium's `Sealing seized: …` message
  grafted: true                              // marker that the engine queued a recovery tail instead of throwing
}
```

**Produced by:** `seal` engine, but **only** when Scriptorium's `seal()` throws a rebase-conflict failure (message prefixed `Sealing seized:`) and recovery is enabled. The engine completes with these yields and grafts a `manual-merge → seal (retry)` tail onto the rig.
**Consumed by:** `manual-merge` (reads `reason` out of upstream yields to include in the mender's prompt).

### `ManualMergeYields`

```typescript
interface ManualMergeYields {
  sessionId: string                          // the mender anima session
  merged: true                               // reconciliation succeeded; the retry seal can now run
}
```

**Produced by:** `manual-merge` engine when the mender anima emits `### Merge: SUCCESS`.
**Consumed by:** nothing — the retry `seal` engine only needs the draft branch to be rebased in the worktree (a side effect of the mender's work), not any data flowing through yields.

---

## Engine Implementations

Each engine is an `EngineDesign` contributed by the Spider's support kit. The engine's `run()` method receives assembled givens and a thin context, and returns an `EngineRunResult`. Engines pull apparatus dependencies via `guild().apparatus(...)`.

### `draft` (clockwork)

Opens a draft binding on the commission's target codex.

```typescript
async run(givens: Record<string, unknown>, _context: EngineRunContext): Promise<EngineRunResult> {
  const scriptorium = guild().apparatus<ScriptoriumApi>('codexes')
  const writ = givens.writ as Writ
  const draft = await scriptorium.openDraft({ codexName: writ.codex, associatedWith: writ.id })
  const baseSha = await getHeadSha(draft.path)

  return {
    status: 'completed',
    yields: { draftId: draft.id, codexName: draft.codexName, branch: draft.branch, path: draft.path, baseSha } satisfies DraftYields,
  }
}
```

### `implement` (quick)

Summons an anima to do the commissioned work.

```typescript
async run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult> {
  const animator = guild().apparatus<AnimatorApi>('animator')
  const writ = givens.writ as Writ
  const draft = context.upstream.draft as DraftYields

  const prompt = `${writ.body}\n${EXECUTION_EPILOGUE}`

  const handle = animator.summon({
    role: givens.role as string,
    prompt,
    cwd: draft.path,
    environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
    metadata: { engineId: context.engineId, writId: writ.id },
  })

  return { status: 'launched', sessionId: handle.sessionId }
}
```

The implement engine appends an execution epilogue to the writ body. When the body contains a `<task-manifest>` (produced by the Astrolabe sage-writer), the epilogue instructs the anima to work through tasks in order, run each task's `<verify>` command as a checkpoint, and commit after each task or logical group. When no manifest is present, behaviour is unchanged — the epilogue's instructions are conditional on the manifest's presence.

**Collect step:** The implement engine has no `collect` method — the Spider uses the generic default: `{ sessionId, sessionStatus, output? }`.

### `review` (quick)

Runs mechanical checks, then summons a reviewer anima to assess the implementation.

```typescript
async run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult> {
  const animator = guild().apparatus<AnimatorApi>('animator')
  const writ = givens.writ as Writ
  const draft = context.upstream.draft as DraftYields

  // 1. Run mechanical checks synchronously
  const checks: MechanicalCheck[] = []
  if (givens.buildCommand) {
    checks.push(await runCheck('build', givens.buildCommand as string, draft.path))
  }
  if (givens.testCommand) {
    checks.push(await runCheck('test', givens.testCommand as string, draft.path))
  }

  // 2. Compute diff since draft opened
  const diff = await gitDiff(draft.path, draft.baseSha)
  const status = await gitStatus(draft.path)

  // 3. Assemble review prompt
  const prompt = assembleReviewPrompt(writ, diff, status, checks)

  // 4. Launch reviewer session
  const handle = animator.summon({
    role: givens.role as string,
    prompt,
    cwd: draft.path,
    metadata: {
      engineId: context.engineId,
      writId: writ.id,
      mechanicalChecks: checks,  // stash for collect step to retrieve
    },
  })

  return { status: 'launched', sessionId: handle.sessionId }
}
```

**Review prompt template:**

```markdown
# Code Review

You are reviewing work on a commission. Your job is to assess whether the
implementation satisfies the spec, identify any gaps or problems, and produce
a structured findings document.

## The Commission (Spec)

{writ.body}

## Implementation Diff

Changes since the draft was opened:

```diff
{git diff draft.baseSha..HEAD in worktree}
```

## Current Worktree State

```
{git status --porcelain}
```

## Mechanical Check Results

{for each check}
### {name}: {PASSED | FAILED}
```
{output, truncated to 4KB}
```
{end for}

## Instructions

Assess the implementation against the spec. Produce your findings in this format:

### Overall: PASS or FAIL

### Completeness
- Which spec requirements are addressed?
- Which are missing or partially addressed?

### Correctness
- Are there bugs, logic errors, or regressions?
- Do the tests pass? If not, what fails?

### Quality
- Code style consistent with the codebase?
- Appropriate test coverage for new code?
- Any concerns about the approach?

### Required Changes (if FAIL)
Numbered list of specific changes needed, in priority order.

Produce your findings as your final message in the format above.
```

**Collect step:** The review engine defines a `collect` method that the Spider calls when the session completes. The engine looks up the session record itself and parses the reviewer's structured findings. No file is written to the worktree (review artifacts don't belong in the codebase).

```typescript
async collect(sessionId: string, _givens: Record<string, unknown>, _context: EngineRunContext): Promise<ReviewYields> {
  const stacks = guild().apparatus<StacksApi>('stacks')
  const session = await stacks.readBook<SessionDoc>('animator', 'sessions').get(sessionId)
  const findings = session?.output ?? ''
  const passed = /^###\s*Overall:\s*PASS/mi.test(findings)
  const mechanicalChecks = (session?.metadata?.mechanicalChecks as MechanicalCheck[]) ?? []
  return { sessionId, passed, findings, mechanicalChecks }
}
```

**Dependency:** The Animator's `SessionResult.output` field (the final assistant message text) must be available for this to work. See the Animator spec (`docs/architecture/apparatus/animator.md`) — the `output` field is populated from the session provider's transcript at recording time.

### `revise` (quick)

Summons an anima to address review findings.

```typescript
async run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult> {
  const animator = guild().apparatus<AnimatorApi>('animator')
  const writ = givens.writ as Writ
  const draft = context.upstream.draft as DraftYields
  const review = context.upstream.review as ReviewYields

  const status = await gitStatus(draft.path)
  const diff = await gitDiffUncommitted(draft.path)
  const prompt = assembleRevisionPrompt(writ, review, status, diff)

  const handle = animator.summon({
    role: givens.role as string,
    prompt,
    cwd: draft.path,
    environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
    metadata: { engineId: context.engineId, writId: writ.id },
  })

  return { status: 'launched', sessionId: handle.sessionId }
}
```

**Revision prompt template:**

```markdown
# Revision Pass

You are revising prior work on a commission based on review findings.

## The Commission (Spec)

{writ.body}

## Review Findings

{review.findings}

## Review Result: {PASS | FAIL}

{if review.passed}
The review passed. No changes are required. Confirm the work looks correct
and exit. Do not make unnecessary changes or spend unnecessary time reassessing.
{else}
The review identified issues that need to be addressed. See "Required Changes"
in the findings above. Address each item, then commit your changes.
{end if}

## Current State

```
{git status --porcelain}
```

```diff
{git diff HEAD, if any uncommitted changes}
```

Commit all changes before ending your session.
```

**Collect step:** The revise engine has no `collect` method — the Spider uses the generic default: `{ sessionId, sessionStatus, output? }`.

### `anima-session` (quick)

A generic engine that summons an anima session. Unlike the other quick engines which embed prompt logic, `anima-session` is a reusable building block — the prompt, role, and conversation context are supplied entirely through givens.

```typescript
async run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult> {
  const animator = guild().apparatus<AnimatorApi>('animator')
  const writ = givens.writ as WritDoc | undefined
  const draft = context.upstream['draft'] as DraftYields | undefined

  const handle = animator.summon({
    role: givens.role as string,
    prompt: givens.prompt as string,
    cwd: givens.cwd as string ?? draft?.path,
    ...(givens.conversationId ? { conversationId: givens.conversationId as string } : {}),
    environment: writ ? { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` } : {},
    metadata: { engineId: context.engineId, ...(writ ? { writId: writ.id } : {}) },
  })

  return { status: 'launched', sessionId: handle.sessionId }
}
```

**Givens:**
- `role` *(required)* — the Loom role to summon
- `prompt` *(required)* — the work prompt for this session
- `cwd` *(optional)* — working directory; falls back to `upstream.draft.path` if available
- `conversationId` *(optional)* — conversation to resume (typically wired from an upstream engine's yields via `${yields.<engineId>.conversationId}`)
- `writ` *(optional)* — the writ, if the engine needs it for git identity or metadata

**Yields:** The default quick-engine yields: `{ sessionId, sessionStatus, output?, conversationId }`. The `conversationId` in yields enables downstream engines to resume the same conversation by referencing `${yields.<engineId>.conversationId}` in their givens.

**Collect step:** No custom `collect` — uses the Spider's generic default.

This engine is contributed by the Spider's support kit alongside the five existing engines. Kit-contributed rig templates and guild-configured templates can both reference `anima-session` as a `designId`.

### `seal` (clockwork)

Closes a draft binding — either sealing (merging inscriptions) or abandoning (discarding the worktree).

**Givens:**
- `abandon` *(optional, boolean)* — when truthy, abandons the draft instead of sealing. Used by rigs that need codebase access but don't produce inscriptions (e.g. planning rigs).
- `recover` *(optional, boolean, default `true`)* — when set to `false`, disables the rebase-conflict recovery tail. Used by the grafted retry seal to prevent infinite recovery layering (one attempt only). The default `true` path is what the five-engine template spawns.

**Happy path.** On successful `scriptorium.seal()`, the engine returns `SealYields` and the rig completes.

**Abandon path.** When `givens.abandon` is truthy, the engine calls `abandonDraft` instead. Abandon failures always re-throw — recovery does not apply, and the engine fails through the unified failure handler, which (after retry budget is exhausted) drives the rig terminally to `'failed'`.

**Rebase-conflict recovery tail.** When `scriptorium.seal()` throws an error whose message starts with `Sealing seized:` (Scriptorium's rebase-conflict signal) **and** `givens.recover !== false`, the engine catches the throw and grafts a two-engine recovery tail instead of failing:

1. `manual-merge` (quick) — summons the `spider.mender` anima in the draft worktree to rebase-and-resolve by hand.
2. `seal` (clockwork, retry) — runs with `givens.recover = false` so a second failure cannot chain another recovery layer.

The original seal engine completes (not fails) with `SealRecoveryYields = { ok: false, reason, grafted: true }`. The `graftTail` points at the retry seal's engine id, so any hypothetical downstream engine declared after the original seal waits for the retry seal to finish. Current templates have nothing after seal, but the contract is preserved for future templates.

All other `seal()` throws — auth, network, missing branch, push race, any message not prefixed `Sealing seized:` — re-throw unchanged. Recovery is scoped narrowly to the one failure mode that mender can actually address.

```typescript
async run(givens, ctx) {
  const scriptorium = guild().apparatus<ScriptoriumApi>('codexes')
  const draft = ctx.upstream.draft as DraftYields

  if (givens.abandon) {
    await scriptorium.abandonDraft({ /* ... */ })   // abandon failures re-throw
    return { status: 'completed', yields: { abandoned: true } }
  }

  const recoverEnabled = givens.recover !== false

  try {
    const result = await scriptorium.seal({ /* ... */ })
    return { status: 'completed', yields: { /* SealYields */ } }
  } catch (err) {
    if (!recoverEnabled || !isRebaseConflictFailure(err)) throw err

    const reason = err instanceof Error ? err.message : String(err)
    const manualMergeEngineId = `${ctx.engineId}-manual-merge`
    const retrySealEngineId   = `${ctx.engineId}-retry`

    return {
      status: 'completed',
      yields: { ok: false, reason, grafted: true } satisfies SealRecoveryYields,
      graft: [
        {
          id: manualMergeEngineId,
          designId: 'manual-merge',
          upstream: [ctx.engineId],
          givens: { writ: '${writ}', role: 'spider.mender', cwd: '${yields.draft.path}' },
        },
        {
          id: retrySealEngineId,
          designId: 'seal',
          upstream: [manualMergeEngineId],
          givens: { recover: false },   // prevents a second recovery layer
        },
      ],
      graftTail: retrySealEngineId,
    }
  }
}
```

The seal engine does **not** transition the writ — that's handled by the CDC handler on the rigs book.

### `manual-merge` (quick)

Summoned by the `seal` engine's recovery tail. Runs the `spider.mender` anima inside the existing draft worktree to reconcile rebase conflicts so the retry seal can fast-forward. The mender is explicitly denied `git push` — the grafted retry seal performs the push.

**Givens:**
- `writ` *(WritDoc)* — the commission, so the mender can read the spec when deciding how to resolve conflicts.
- `role` *(optional, string, default `'spider.mender'`)* — the anima role to summon.
- `cwd` *(string)* — the draft worktree path. The seal engine resolves this from `${yields.draft.path}` at graft time.

**Prompt composition.** The engine assembles the work prompt inline from four sources: the writ body (spec), Scriptorium's `Sealing seized:` reason (pulled from the upstream seal engine's `SealRecoveryYields`), draft context (codex name, branch, worktree path), and the current `git status --porcelain=v1 -b` output. The anima's identity and tools come from the Loom via the `spider.mender` role — the Spider contributes the role through its supportKit with no permissions (the mender only needs `git`, available on the host) and an `instructionsFile` pointing at `loom-roles/mender.md`.

**Output contract.** The mender must end its final message with exactly one marker line:
- `### Merge: SUCCESS` — reconciliation complete; the draft branch is rebased onto the target and ready for a fast-forward seal.
- `### Merge: FAILURE` — the mender could not reconcile safely; reason explained in the lines above the marker.

**Collect step.** The custom `collect()` reads `session.output`, matches the marker (case-insensitive, line-anchored), and either returns `ManualMergeYields = { sessionId, merged: true }` on SUCCESS, or throws on FAILURE or missing marker. The Spider's `tryCollect` catches the throw and routes the engine through the unified failure handler — once the retry budget is exhausted the engine moves to `'failed'`, the cascade cancels the queued retry seal, and the rig rolls up to `'failed'`. The retry seal never runs.

The marker prefix (`### Merge:`) deliberately differs from the review engine's `### Overall:` prefix to avoid cross-talk.

---

## CDC Handlers

The Spider registers two CDC handlers at startup. Both are Phase 1 (cascade) — their effects join the same transaction as the triggering update.

### Writ cancelled → rig cancellation

**Book:** `clerk/writs`
**Phase:** Phase 1 (cascade)
**Trigger:** writ status transitions to `cancelled`

When a writ is cancelled, the Spider looks up the associated rig via `forWrit()` and cancels it. This ensures rigs don't keep running after their writ is resolved — for example, when a writ is cancelled directly via the Clerk, or when a parent writ's cancellation cascades to its children. The handler routes cancellation through the legacy-tolerant cancel API so that pre-reshape rigs persisted with `'stuck'` or `'blocked'` are cancelled cleanly alongside the four-state machine; there is no `'stuck'` arm or stuck-specific guard.

Silent no-ops: if no rig exists for the writ (writ was never dispatched), or the rig is already terminal, the handler returns without action. Only `cancelled` triggers rig cancellation — writs transitioning to `completed` or `failed` do not cancel the rig.

### Rig terminal state → writ transition

**Book:** `spider/rigs`
**Phase:** Phase 1 (cascade)
**Trigger:** rig status transitions to `completed`, `failed`, or `cancelled`

When a rig reaches a terminal state, the handler transitions the associated writ to match. There is no intermediate `'stuck'` arm — the engine-failure path now routes terminal failure through the unified failure handler, which transitions the writ directly to `'failed'`.

- **`rig.completed` → `writ: completed`**, with the writ resolution composed via a three-step fallback ladder: (a) if the rig's `resolutionEngineId` names an engine in `'completed'` state with yields, format the resolution from that engine's yields; (b) otherwise, if the rig has a completed engine with `designId === 'seal'` whose yields satisfy `SealYields`, format from those yields; (c) otherwise, fall back to the most recent completed engine that produced yields. This ladder makes a writ's resolution stable for templates that opt into a custom `resolutionEngine` while still working for the static draft → seal pipeline.
- **`rig.failed` → `writ: failed`**, with the writ resolution mirroring the failed engine's last-attempt error (`attempts[-1].error` from the engine that drove the rollup to `'failed'`). The writ does not pass through any intermediate `'stuck'` state.
- **`rig.cancelled` → `writ: cancelled`**, cascading the rig's cancellation onto its writ.

A guard reads the writ's current status first — if the writ is already terminal (e.g., it was cancelled before the rig), the handler skips the `clerk.transition()` call. This breaks the circular cascade path: writ cancelled → rig cancelled → rig CDC fires → writ already terminal → skip.

Because both handlers are Phase 1, their effects are atomic with the triggering update. If either handler fails, the triggering status change rolls back.

---

## Engine Failure

When an engine attempt terminates with a non-success outcome — a clockwork `run()` throws, a quick engine's session reaches a `'failed'` terminal, or a registered BlockType returns `{ status: 'failed' }` — the Spider routes the attempt through **the unified failure handler** (`handleEngineFailure`). The handler closes the in-flight `attempts[]` row, classifies the failure into one of three branches, and patches the rig in a single transaction.

The three branches are mutually exclusive — every terminal attempt takes exactly one path:

1. **Rate-limit hold.** The Animator reported a rate-limit terminal (`session.terminalReason === 'rate-limit'`). The handler closes the attempt row without an `error`, sets the engine back to `'pending'` with `holdReason = 'animator-paused'` and `holdCondition = { sessionId }`, and copies the Animator's back-off deadline into `holdUntil` when one is provided. **`attemptCount` is NOT incremented** — rate-limit yields the dispatch slot, it does not consume retry budget. The hold clears on the next crawl when the Animator's `isDispatchable` predicate returns true; see `docs/architecture/apparatus/animator.md` for the dispatchability-predicate contract.
2. **Retryable within budget.** The failure was transient (a clockwork throw classified as retryable, or a non-rate-limit session terminal) **and** `attemptCount < design.retry.maxAttempts`. The handler closes the attempt row with `status: 'failed'` and the captured `error`, increments `attemptCount`, sets the engine back to `'pending'` with `holdReason = 'retry-backoff'`, and computes `holdUntil` from the engine design's back-off config. Downstream engines stay `'pending'`; the rig stays `'running'` (or whatever the rollup yields, given the in-flight peers).
3. **Exhausted or non-retryable.** Either the retry budget is exhausted (`attemptCount >= maxAttempts`) or the failure is definitional (graft validation, unknown design or block type, non-JSON-serializable yields, BlockType `check()` returning `'failed'`). The handler renders the cascade as:
   - The failing engine moves to `'failed'`; the in-flight `attempts[]` row is finalised with `status: 'failed'` and the captured `error`.
   - Every other engine in the rig with `status === 'pending'` is cascade-cancelled to `'cancelled'`. Engines already in `'running'`, `'completed'`, `'failed'`, or `'skipped'` are left untouched; cancelled engines do not receive an `error` (cancellation is a consequence, not a failure).
   - The rig's status is recomputed via `deriveRigStatus(rig)`, which yields `'failed'` (a failed engine plus no engine still running).
   - The CDC handler on the rigs book picks up the `rig→failed` transition and transitions the writ directly to `phase = 'failed'`. The writ does not pass through any intermediate `'stuck'` state.

The draft is **not** abandoned by the handler in any branch — it is preserved for patron inspection regardless of which branch fires.

A quick engine "failure" is the Animator session reaching `status: 'failed'`. A session reaching `status: 'completed'` succeeds even if the anima's work is incomplete — that's the review engine's job to catch, not the Spider's.

### Engine retry policy

Retry is opt-in per engine design via the design's `retry?: EngineRetryConfig` field, validated by `validateEngineRetryConfig` at registration time (negative or non-finite values throw at startup):

```typescript
interface EngineRetryConfig {
  maxAttempts: number              // total retry budget; 0 = fail fast on first error (default)
  backoff?: Partial<{
    initialMs: number              // first attempt's hold window (default 30_000)
    maxMs: number                  // cap on the hold window (default 600_000 — 10 minutes)
    factor: number                 // multiplicative growth factor, must be > 1 (default 2)
  }>
}
```

When `retry` is absent or `maxAttempts === 0` the handler treats every transient failure as terminal. `maxAttempts: 1` allows one retry (two attempts total), `maxAttempts: 2` allows two retries (three attempts total), and so on — matching the "attempts consumed from budget" semantics. The back-off schedule is `min(initialMs * factor^attemptCount, maxMs)`, applied via `holdUntil` on each retry-back-off transition.

Whichever engine designs opt in to retry are visible at runtime via `nsg engine-designs`; this spec deliberately does not enumerate them, since the set is governed by the kits a guild loads.

> **Note (legacy tolerance).** Operators recovering rigs persisted as `'stuck'` before this reshape — including writs whose pre-reshape `status.spider.stuckCause` recorded `'engine-failure'` — can sweep them via `nsg writ-rescue-stuck`.

---

## Dependency Map

```
Spider
  ├── Fabricator  (resolve engine designs by designId)
  ├── Clerk       (query open writs, transition writ state via CDC, writ→rig cascade via CDC)
  ├── Stacks      (persist rigs book, read sessions/writs books, CDC handlers on rigs and writs books)
  │
  Engines (via guild() singleton, not Spider dependencies)
  ├── Scriptorium (draft, seal engines — open drafts, seal)
  ├── Animator    (implement, review, revise engines — summon animas)
  └── Loom        (via Animator's summon — context composition)
```

---

## Future Evolution

These are known directions the Spider and its data model will grow. None are in scope for the static rig MVP.

- **Engine needs declarations.** Engine designs will declare a `needs` specification that controls which upstream yields are included and how they're mapped — making the data flow between engines explicit and type-safe.
- **Typed engine contracts.** The `Record<string, unknown>` givens map with type assertions is scaffolding. The needs/planning system will introduce typed contracts between engines — defining what each engine requires and provides. This scaffolding gets replaced, not extended.
- **Dynamic rig extension.** Capability resolution (via the Fabricator) and rig growth at runtime. Engines can declare needs that the Fabricator resolves to additional engine chains, grafted onto the rig mid-execution.
- **Engine timeouts.** Liveness of an engine's underlying session is owned by the Animator's heartbeat reconciler — a session that stops reporting `lastActivityAt` within the staleness window is transitioned to `failed`, and the Spider then picks up the terminal session via `collect` on the next crawl. The Spider itself does not probe process liveness. A future extension may add a hard runtime ceiling that terminates still-heartbeating engines exceeding a configured maximum wall-clock duration.
- **Unified capability catalog.** The Fabricator may absorb tool designs from the Instrumentarium, becoming the single answer to "what can this guild do?" regardless of whether the answer is an engine or a tool.

---

## What This Spec Does NOT Cover

- **Origination.** Commission → rig mapping is hardcoded (static graph).
- **The Executor as a separate apparatus.** The Spider runs engines directly — clockwork engines inline, quick engines via the Animator. The Executor earns its independence when substrate switching (Docker, remote VM) is needed. Key design constraint: the Spider currently `await`s `design.run()`, meaning a slow or misbehaving engine blocks the entire crawl loop. The Executor must not have this property — engine execution should be fully non-blocking, with yields persisted to a book so the orchestrator can poll for completion. This is essential for remote and Docker runners where the process that ran the engine is not the process polling for results.
- **Concurrent rigs.** The priority system supports multiple rigs in principle, but the polling loop + single-guild model means we process one commission at a time in practice. Concurrency comes naturally when the Spider processes multiple ready engines across rigs.
- **Reviewer role curriculum/temperament.** The `reviewer` role exists with a blank identity. The review engine assembles the prompt. Loom content for the reviewer is a separate concern.

---

## Configuration

```json
{
  "spider": {
    "pollIntervalMs": 5000,
    "variables": {
      "role": "artificer",
      "buildCommand": "pnpm -w build",
      "testCommand": "pnpm -w test"
    }
  }
}
```

All fields optional. `pollIntervalMs` defaults to `5000`. `buildCommand` and `testCommand` are referenced from `variables` by the plugin-default rig template's `review` engine; omitted means those mechanical checks are skipped (reviewer anima still does spec-vs-diff assessment).

The `variables` dict contains user-defined values available in rig template givens via `${vars.<path>}`. For example, `"${vars.role}"` in a template givens entry resolves to `variables.role` at rig spawn time.

### Plugin-default template and mapping

The Spider's apparatus contributes a plugin-level rig template and mapping via its own supportKit:

- `rigTemplates: { default: <draft → implement → review → revise → seal> }`
- `rigTemplateMappings: { mandate: 'default' }`

Guilds do **not** need to declare these in `guild.json` — they are always present. `spider.rigTemplates` and `spider.rigTemplateMappings` in config are overlays: a config-level template of the same name wins over the plugin default, and a config-level mapping for the same writ type wins over the kit mapping. Kit mapping lookup resolves an unqualified templateName against the bare name first (so config overrides work) and falls back to the contributing kit's qualified `${pluginId}.${templateName}` when no config entry claims the bare name.

**Kit-vs-kit collisions are a hard error.** Two kits contributing a `rigTemplateMappings` entry for the same writ type — including Spider's own plugin-default `mandate → default` — refuse to start the guild; the startup error names both contributing plugins and the conflicting writ type. Operators resolve by removing one kit mapping or by declaring a config-level override in `spider.rigTemplateMappings` (which always wins, silently). The winner is never selected by kit load order. The same fail-loud rule applies to Clerk `writTypes`, Spider `blockTypes`, and Fabricator engine designs — the policy is framework-wide, not Spider-specific.

### Givens Template Expressions

Rig template givens support `${...}` template expressions that are resolved at rig spawn time or engine start time:

| Expression | Resolved to | When |
|---|---|---|
| `${writ}` | The full `WritDoc` for the spawned rig | Rig spawn time |
| `${writ.<path>}` | A field of the `WritDoc` (dot-path traversal) | Rig spawn time |
| `${vars.<path>}` | Value at `<path>` from `spiderConfig.variables` (dot-path traversal) | Rig spawn time |
| `${yields.<engineId>.<path>}` | Value at `<path>` from the named engine's yields | Engine start time (just before `run()`) |

The `${yields.*}` expressions resolve at **engine start time**, not rig spawn time — the upstream engine must have completed and produced yields before the reference can be resolved. The Spider resolves these references when assembling givens for a ready engine, reading from `context.upstream[engineId]`. If the referenced engine has not completed or the path does not exist in its yields, the givens key is omitted (same behavior as an undefined `${vars.*}` reference).

`<path>` supports dot-separated property access for nested objects (e.g., `${yields.draft.nested.prop}` resolves to `upstream['draft'].nested.prop`). Both `${vars.*}` and `${yields.*}` support arbitrary dot-path depth.

The escape sequence `\${` produces a literal `${` in the output — the expression is not interpolated.

### Full-value vs. inline resolution

When a givens value is **entirely** a single `${...}` expression (`"${writ}"`, `"${yields.reader.conversationId}"`), it resolves to the **typed value** — object, array, number, whatever the source provides. This is full-value resolution.

When a string **contains** `${...}` expressions but also has surrounding text, the Spider performs **inline interpolation** — each `${...}` expression within the string is replaced with the stringified value of the reference, leaving the rest of the string intact. This enables prompt composition with embedded dynamic content:

```json
{
  "givens": {
    "writ": "${writ}",
    "conversationId": "${yields.reader.conversationId}",
    "prompt": "Write the spec.\n\nDecisions:\n${yields.decision-review.decisionSummary}"
  }
}
```

In this example:
- `writ` resolves to the full `WritDoc` object (full-value — the entire string is a single expression)
- `conversationId` resolves to a string (full-value — preserves the original type from yields)
- `prompt` resolves to a string with the `decisionSummary` interpolated inline (inline — the `${...}` is embedded in a larger string)

**Resolution rules:**
- A string that is *exactly* one `${<expr>}` expression with no other characters → **full-value** resolution. The givens key receives the resolved value with its original type.
- A string that *contains* one or more `${...}` expressions among other text → **inline interpolation**. Each expression is replaced with `String(resolvedValue)`. The givens key receives a string. References that resolve to `undefined` are replaced with the empty string; numbers and booleans are coerced with `String()`; objects and arrays are stringified with `JSON.stringify()`.
- A string with no `${...}` expressions → **literal passthrough** (unchanged, regardless of `$` prefix).

All three expression families (`${writ}`, `${vars.*}`, `${yields.*}`) are supported in both full-value and inline modes. Spawn-time expressions (`${writ}`, `${writ.*}`, `${vars.*}`) are resolved at spawn time; `${yields.*}` expressions are resolved at engine start time. In inline mode, a string containing both spawn-time and yield expressions is partially resolved at spawn time (spawn-time expressions replaced, yield expressions left as literal `${yields.*}` text) and fully resolved at engine start time.

### Example: conversation chaining with prompt composition

```json
{
  "engines": [
    { "id": "reader", "designId": "anima-session",
      "givens": { "role": "${vars.plannerRole}", "prompt": "Inventory the codebase." } },
    { "id": "analyst", "designId": "anima-session", "upstream": ["reader"],
      "givens": {
        "role": "${vars.plannerRole}",
        "conversationId": "${yields.reader.conversationId}",
        "prompt": "Analyze the inventory and produce scope and decisions."
      }
    }
  ]
}
```
