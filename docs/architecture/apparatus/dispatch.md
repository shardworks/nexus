# The Dispatch — API Contract

Status: **Draft**

Package: `@shardworks/dispatch-apparatus` · Plugin id: `dispatch`

> **⚠️ Temporary rigging.** This apparatus is a stand-in for the full rigging system (Walker, Formulary, Executor). It provides a single dispatch tool that takes the oldest ready writ and runs it through the guild's existing machinery. When the full rigging system exists, this apparatus is retired and its responsibilities absorbed by the Walker and summon relay. Designed to be disposable.

---

## Purpose

The Dispatch is the guild's interim work runner. It bridges the gap between the Clerk (which tracks obligations) and the session machinery (which runs animas) — without the full rigging system.

It does one thing: find a ready writ and execute it. "Execute" means open a draft binding on the target codex, compose context for an anima via the Loom, launch a session via the Animator, and handle the aftermath (seal the draft, transition the writ). This is the minimum viable loop that turns a commission into delivered work.

The Dispatch does **not** decompose writs, manage engine chains, or run multiple steps. One writ, one session. If the session completes, the draft is sealed and the writ is completed. If it fails, the writ is failed. That's the whole lifecycle.

---

## Dependencies

```
requires: ['stacks', 'clerk', 'codexes', 'animator']
recommends: ['loom']
```

- **The Stacks** (required) — reads writs via the Clerk's book.
- **The Clerk** (required) — queries ready writs and transitions their status.
- **The Scriptorium** (required) — opens and seals draft bindings on the target codex.
- **The Animator** (required) — launches anima sessions. Uses `summon()` (high-level, Loom-composed) when the Loom is available, `animate()` (low-level) otherwise.
- **The Loom** (recommended) — composes session context (system prompt, tools, role instructions). Resolved at dispatch time via the Animator's `summon()`. Not a direct dependency of the Dispatch — it's the Animator that calls the Loom.

---

## Kit Interface

The Dispatch does not consume kit contributions. No `consumes` declaration.

---

## Support Kit

```typescript
supportKit: {
  tools: [dispatchNext],
},
```

### `dispatch-next` tool

Find the oldest ready writ and dispatch it. This is the primary entry point — callable from the CLI via `nsg dispatch-next` or programmatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `role` | `string` | no | Role to summon (default: `"artificer"`) |
| `dryRun` | `boolean` | no | If true, find and report the writ but don't dispatch |

Returns a dispatch summary: writ id, session id, outcome.

Permission: `dispatch:write`

Callable by: `cli` (patron-side operation, not an anima tool)

---

## `DispatchApi` Interface (`provides`)

```typescript
interface DispatchApi {
  /**
   * Find the oldest ready writ and execute it.
   *
   * The full dispatch lifecycle:
   *   1. Query the Clerk for the oldest ready writ
   *   2. Transition the writ to active
   *   3. Open a draft binding on the writ's codex (if specified)
   *   4. Summon an anima session with the writ context as prompt
   *   5. Wait for session completion
   *   6. On success: seal the draft, push, transition writ to completed
   *   7. On failure: abandon the draft, transition writ to failed
   *
   * Returns null if no ready writs exist.
   *
   * If the writ has no codex, steps 3/6/7 (draft lifecycle) are
   * skipped — the session runs in the guild home directory with
   * no codex binding.
   */
  next(request?: DispatchRequest): Promise<DispatchResult | null>
}

interface DispatchRequest {
  /** Role to summon. Default: 'artificer'. */
  role?: string
  /** If true, find and report the writ but don't dispatch. */
  dryRun?: boolean
}

interface DispatchResult {
  /** The writ that was dispatched. */
  writId: string
  /** The session id (from the Animator). Absent if dryRun. */
  sessionId?: string
  /** Terminal writ status after dispatch. Absent if dryRun. */
  outcome?: 'completed' | 'failed'
  /** Resolution text set on the writ. Absent if dryRun. */
  resolution?: string
  /** Whether this was a dry run. */
  dryRun: boolean
}
```

---

## Dispatch Lifecycle

```
dispatch.next({ role: 'artificer' })
│
├─ 1. Query Clerk: oldest writ where status = 'ready', ordered by createdAt asc
│     → if none found, return null
│
├─ 2. Clerk: transition writ ready → active
│
├─ 3. [if writ.codex] Scriptorium: openDraft({ codex: writ.codex })
│     → draftRecord (worktree path = session cwd)
│     → if no codex on writ, cwd = guild home
│
├─ 4. Animator: summon({
│       role,
│       prompt: <assembled from writ title + body>,
│       cwd: draftRecord.path (or guild home),
│       metadata: { writId: writ.id, trigger: 'dispatch' }
│     })
│     → { chunks, result }
│
├─ 5. Await result
│
├─ 6a. [success] Session completed normally
│      ├─ [if codex] Scriptorium: seal({ codex, branch: draft.branch })
│      ├─ [if codex] Scriptorium: push({ codex })
│      ├─ Clerk: transition writ active → completed
│      │    resolution = session result summary
│      └─ return DispatchResult { outcome: 'completed' }
│
└─ 6b. [failure] Session failed or errored
       ├─ [if codex] Scriptorium: abandonDraft({ codex, branch: draft.branch, force: true })
       ├─ Clerk: transition writ active → failed
       │    resolution = failure reason from session
       └─ return DispatchResult { outcome: 'failed' }
```

### Prompt Assembly

The dispatch prompt is assembled from the writ's fields. The anima receives enough context to understand its assignment and use the `writ-show` tool for full details:

```
You have been dispatched to fulfill a commission.

## Assignment

**Title:** {writ.title}

**Writ ID:** {writ.id}

{writ.body}
```

The prompt is intentionally minimal — the anima's curriculum and role instructions carry the craft knowledge. The Dispatch just delivers the assignment.

The Dispatch owns the writ transition — the anima does not call `writ-complete` or `writ-fail`. The Dispatch observes the session outcome and transitions the writ accordingly. This keeps writ lifecycle management out of the anima's instructions, which simplifies the prompt and avoids relying on animas to self-report correctly.

### Error Handling

- **No ready writs:** `next()` returns null. Not an error.
- **Draft open fails:** Writ transitions to `failed` with resolution describing the Scriptorium error. No session launched.
- **Session fails:** Draft abandoned, writ failed. The Animator already records the session result to the Stacks.
- **Seal fails (contention):** Writ transitions to `failed`. The draft is NOT abandoned — the inscriptions are preserved for manual recovery or re-dispatch. Resolution describes the seal failure.
- **Push fails:** Same as seal failure — writ failed, draft preserved.

---

## Configuration

No configuration. The Dispatch reads writs from the Clerk and uses default behaviors for all apparatus calls. The role is specified per dispatch via the tool parameter.

---

## Open Questions

- **Should dispatch-next accept a specific writ id?** The current design always picks the oldest ready writ. An `id` parameter would let the patron dispatch a specific commission. Probably useful — but adds complexity (what if the writ isn't ready? what if it doesn't exist?). Could add later.

---

## Future: Retirement

When the full rigging system (Walker, Formulary, Executor) is implemented, the Dispatch apparatus is retired:

- The Walker takes over rig spawning and engine traversal
- The summon relay handles anima dispatch from standing orders
- The Formulary resolves engine chains (draft-open → session → seal is just one possible chain)
- `dispatch-next` is replaced by the Clockworks processing `mandate.ready` events

The Dispatch is designed to be removable with zero impact on the Clerk, Scriptorium, Animator, or Loom. It is a consumer of their APIs, not a provider of anything they depend on.

---

## Implementation Notes

- Small apparatus — types, core dispatch logic, one tool, barrel. ~5 source files.
- The `next()` method is the entire API surface. No books, no state, no CDC. Pure orchestration.
- The Dispatch queries the Clerk's writs book via `clerk.list({ status: 'ready' })` with a limit of 1 and ordered by `createdAt` asc. The `['status', 'createdAt']` compound index on the writs book makes this efficient.
- Session `cwd` is the draft worktree path when a codex is specified, or the guild home directory otherwise.
- The prompt template is hardcoded in the apparatus, not configurable. This is disposable infrastructure — configurability is wasted investment.
