# `@shardworks/dispatch-apparatus`

> **⚠️ Temporary rigging.** The Dispatch is a stand-in for the full rigging system (Walker, Formulary, Executor). When that system exists, this apparatus is retired.

The Dispatch is the guild's interim work runner. It bridges the gap between the Clerk (which tracks obligations) and the session machinery (which runs animas). It does one thing: find the oldest ready writ and execute it.

The Dispatch sits downstream of the Clerk and Animator:
`stacks ← clerk ← dispatch → animator → (codexes)`

---

## Installation

Add to your package's dependencies:

```json
{
  "@shardworks/dispatch-apparatus": "workspace:*"
}
```

The Dispatch requires the Stacks, Clerk, Scriptorium (codexes), and Animator to be installed in the guild. The Loom is recommended (used indirectly via `Animator.summon()`).

---

## API

The Dispatch exposes a `DispatchApi` via its `provides` interface, retrieved at runtime:

```typescript
import type { DispatchApi } from '@shardworks/dispatch-apparatus';

const dispatch = guild().apparatus<DispatchApi>('dispatch');
```

### `next(request?): Promise<DispatchResult | null>`

Find the oldest ready writ and execute it.

```typescript
// Dispatch with defaults (role: 'artificer')
const result = await dispatch.next();

// Dispatch with a specific role
const result = await dispatch.next({ role: 'scribe' });

// Dry run — preview without dispatching
const result = await dispatch.next({ dryRun: true });

if (!result) {
  console.log('No ready writs.');
} else {
  console.log(result.outcome); // 'completed' | 'failed' | undefined (dryRun)
}
```

| Parameter | Type | Description |
|---|---|---|
| `role` | `string` | Role to summon (default: `"artificer"`) |
| `dryRun` | `boolean` | If true, find and report the writ but don't dispatch |

Returns `null` if no ready writs exist.

---

## Dispatch Lifecycle

```
next({ role: 'artificer' })
│
├─ 1. Query writs book: oldest where status='ready', ordered by postedAt asc
│     → if none found, return null
│
├─ 2. Clerk: transition writ ready → active
│
├─ 3. [if writ.codex] Scriptorium: openDraft({ codexName: writ.codex })
│     → draftRecord (worktree path = session cwd)
│     → if no codex on writ, cwd = guild home
│
├─ 4. Animator: summon({ role, prompt, cwd, metadata: { writId, trigger: 'dispatch' } })
│     → { chunks, result }
│
├─ 5. Await result
│
├─ 6a. [success] Session completed normally
│      ├─ [if codex] Scriptorium: seal({ codexName, sourceBranch: draft.branch })
│      ├─ [if codex] Scriptorium: push({ codexName })
│      ├─ Clerk: transition writ active → completed
│      └─ return DispatchResult { outcome: 'completed' }
│
└─ 6b. [failure] Session failed or timed out
       ├─ [if codex] Scriptorium: abandonDraft({ codexName, branch, force: true })
       ├─ Clerk: transition writ active → failed
       └─ return DispatchResult { outcome: 'failed' }
```

### Error Handling

| Failure | Writ transition | Draft |
|---|---|---|
| No ready writs | none | n/a |
| Draft open fails | → `failed` | n/a (never opened) |
| Session fails | → `failed` | abandoned (force) |
| Seal fails | → `failed` | **preserved** (for recovery) |
| Push fails | → `failed` | **preserved** (for recovery) |

The Dispatch owns writ transitions — the anima does **not** call `writ-complete` or `writ-fail`. This keeps writ lifecycle management out of anima instructions.

---

## Support Kit

The Dispatch contributes one tool:

### Tools

| Tool | Permission | Callable by | Description |
|---|---|---|---|
| `dispatch-next` | `dispatch:write` | `cli` | Find and dispatch the oldest ready writ |

---

## Key Types

```typescript
interface DispatchApi {
  next(request?: DispatchRequest): Promise<DispatchResult | null>;
}

interface DispatchRequest {
  role?: string;    // default: 'artificer'
  dryRun?: boolean;
}

interface DispatchResult {
  writId: string;
  sessionId?: string;                    // absent if dryRun
  outcome?: 'completed' | 'failed';     // absent if dryRun
  resolution?: string;                  // absent if dryRun
  dryRun: boolean;
}
```

See `src/types.ts` for the complete type definitions.

---

## Configuration

No configuration. The Dispatch reads writs from the Clerk and uses default behaviors for all apparatus calls. The role is specified per dispatch via the tool parameter.

---

## Exports

The package exports all public types and the `createDispatch()` factory:

```typescript
import dispatchPlugin, { createDispatch, type DispatchApi } from '@shardworks/dispatch-apparatus';
```

The default export is a pre-built plugin instance, ready for guild installation.
