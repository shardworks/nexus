# The Scriptorium — API Contract

Status: **Draft**

Package: `@shardworks/codexes-apparatus` · Plugin id: `codexes`

> **⚠️ MVP scope.** This spec covers codex registration, draft binding lifecycle, and sealing/push operations. Clockworks integration (events, standing orders) is future work — the Scriptorium will emit events when the Clockworks apparatus exists. The Surveyor's codex-awareness integration is also out of scope for now.

---

## Purpose

The Scriptorium manages the guild's codexes — the git repositories where the guild's inscriptions accumulate. It owns the registry of known codexes, maintains local bare clones for efficient access, opens and closes draft bindings (worktrees) for concurrent work, and handles the sealing lifecycle that incorporates drafts into the sealed binding.

The Scriptorium does **not** know what a codex contains or what work applies to it (that's the Surveyor's domain). It does **not** orchestrate which anima works in which draft (that's the caller's concern — rig engines, dispatch scripts, or direct human invocation). It is pure git infrastructure — repository lifecycle, draft isolation, and branch management.

### Vocabulary Mapping

The Scriptorium's tools use the [guild metaphor's binding vocabulary](../../guild-metaphor.md#binding-canonical). The mapping to git concepts:

| Metaphor | Git | Scriptorium API |
|----------|-----|-----------------|
| **Codex** | Repository | `add`, `list`, `show`, `remove`, `fetch` |
| **Draft binding** (draft) | Worktree + branch | `openDraft`, `listDrafts`, `abandonDraft` |
| **Sealed binding** | Default branch (e.g. `main`) | Target of `seal` |
| **Sealing** | Fast-forward merge (or rebase + ff) | `seal` |
| **Abandoning** | Remove worktree + branch | `abandonDraft` |
| **Inscription** | Commit | *(not managed by the Scriptorium — animas inscribe directly via git)* |

Use plain git terms (branch, commit, merge) in error messages and logs where precision matters; the binding vocabulary is for the tool-facing API and documentation.

---

## Dependencies

```
requires: ['stacks']
consumes: []
```

- **The Stacks** — persists the codex registry and draft tracking records. Configuration in `guild.json` is the source of truth for registered codexes; the Stacks tracks runtime state (active drafts, clone status).

---

## Kit Interface

The Scriptorium does not consume kit contributions. No `consumes` declaration.

---

## Support Kit

```typescript
supportKit: {
  tools: [
    codexAddTool,
    codexListTool,
    codexShowTool,
    codexRemoveTool,
    codexPushTool,
    draftOpenTool,
    draftListTool,
    draftAbandonTool,
    draftSealTool,
  ],
},
```

---

## `ScriptoriumApi` Interface (`provides`)

```typescript
interface ScriptoriumApi {
  // ── Codex Registry ──────────────────────────────────────────

  /**
   * Register an existing repository as a codex.
   * Clones a bare copy to `.nexus/codexes/<name>.git` and adds the
   * entry to the `codexes` config section in `guild.json`.
   * Blocks until the clone completes.
   */
  add(name: string, remoteUrl: string): Promise<CodexRecord>

  /**
   * List all registered codexes with their status.
   */
  list(): Promise<CodexRecord[]>

  /**
   * Show details for a single codex, including active drafts.
   */
  show(name: string): Promise<CodexDetail>

  /**
   * Remove a codex from the guild. Abandons all active drafts,
   * removes the bare clone from `.nexus/codexes/`, and removes the
   * entry from `guild.json`. Does NOT delete the remote repository.
   */
  remove(name: string): Promise<void>

  /**
   * Fetch latest refs from the remote for a codex's bare clone.
   * Called automatically before draft creation and sealing; can
   * also be invoked manually.
   */
  fetch(name: string): Promise<void>

  /**
   * Push a branch to the codex's remote.
   * Pushes the specified branch (default: codex's default branch)
   * to the bare clone's configured remote. Does not force-push.
   */
  push(request: PushRequest): Promise<void>

  // ── Draft Binding Lifecycle ─────────────────────────────────

  /**
   * Open a draft binding on a codex.
   *
   * Creates a new git branch from `startPoint` (default: the codex's
   * sealed binding) and checks it out as an isolated worktree under
   * `.nexus/worktrees/<codex>/<branch>`. Fetches from the remote
   * before branching to ensure freshness.
   *
   * If `branch` is omitted, generates one automatically as `draft-<ulid>`.
   * Rejects with a clear error if a draft with the same branch name
   * already exists for this codex.
   */
  openDraft(request: OpenDraftRequest): Promise<DraftRecord>

  /**
   * List active drafts, optionally filtered by codex.
   */
  listDrafts(codexName?: string): Promise<DraftRecord[]>

  /**
   * Abandon a draft — remove the draft's worktree and git branch.
   * Fails if the draft has unsealed inscriptions unless `force: true`.
   * The inscriptions persist in the git reflog but the draft is no
   * longer active.
   */
  abandonDraft(request: AbandonDraftRequest): Promise<void>

  /**
   * Seal a draft — incorporate its inscriptions into the sealed binding.
   *
   * Git strategy: fast-forward merge only. If ff is not possible,
   * rebases the draft branch onto the target and retries. Retries up
   * to `maxRetries` times (default: from settings.maxMergeRetries)
   * to handle contention from concurrent sealing. Fails hard if the
   * rebase produces conflicts — no auto-resolution, no merge commits.
   *
   * On success, abandons the draft (unless `keepDraft: true`).
   */
  seal(request: SealRequest): Promise<SealResult>
}
```

### Supporting Types

```typescript
interface CodexRecord {
  /** Codex name — unique within the guild. */
  name: string
  /** Remote repository URL. */
  remoteUrl: string
  /** Whether the bare clone exists and is healthy. */
  cloneStatus: 'ready' | 'cloning' | 'error'
  /** Number of active drafts for this codex. */
  activeDrafts: number
}

interface CodexDetail extends CodexRecord {
  /** Default branch name on the remote (e.g. 'main'). */
  defaultBranch: string
  /** Timestamp of last fetch. */
  lastFetched: string | null
  /** Active drafts for this codex. */
  drafts: DraftRecord[]
}

interface DraftRecord {
  /** Unique draft id (ULID). */
  id: string
  /** Codex this draft belongs to. */
  codexName: string
  /** Git branch name for this draft. */
  branch: string
  /** Absolute filesystem path to the draft's working directory (git worktree). */
  path: string
  /** When the draft was opened. */
  createdAt: string
  /** Optional association — e.g. a writ id. */
  associatedWith?: string
}

interface OpenDraftRequest {
  /** Codex to open the draft for. */
  codexName: string
  /** Branch name for the draft. If omitted, generates `draft-<ulid>`. */
  branch?: string
  /**
   * Starting point — branch, tag, or commit to branch from.
   * Default: remote HEAD (the codex's default branch).
   */
  startPoint?: string
  /** Optional association metadata (e.g. writ id). */
  associatedWith?: string
}

interface AbandonDraftRequest {
  /** Codex name. */
  codexName: string
  /** Git branch name of the draft to abandon. */
  branch: string
  /** Force abandonment even if the draft has unsealed inscriptions. */
  force?: boolean
}

interface SealRequest {
  /** Codex name. */
  codexName: string
  /** Git branch to seal (the draft's branch). */
  sourceBranch: string
  /** Target branch (the sealed binding). Default: codex's default branch. */
  targetBranch?: string
  /** Max rebase retry attempts under contention. Default: from settings.maxMergeRetries (3). */
  maxRetries?: number
  /** Keep the draft after successful sealing. Default: false. */
  keepDraft?: boolean
}

interface SealResult {
  /** Whether sealing succeeded. */
  success: boolean
  /** Strategy used: 'fast-forward' or 'rebase'. */
  strategy: 'fast-forward' | 'rebase'
  /** Number of retry attempts needed (0 = first try). */
  retries: number
  /** The commit SHA at head of target after sealing. */
  sealedCommit: string
}

interface PushRequest {
  /** Codex name. */
  codexName: string
  /**
   * Branch to push. Default: codex's default branch.
   */
  branch?: string
}
```

---

## Configuration

The `codexes` key in `guild.json` has two sections: `settings` (apparatus-level configuration) and `registered` (the codex registry). Both can be edited by hand or through tools.

```json
{
  "codexes": {
    "settings": {
      "maxMergeRetries": 3,
      "draftRoot": ".nexus/worktrees"
    },
    "registered": {
      "nexus": {
        "remoteUrl": "git@github.com:shardworks/nexus.git"
      },
      "my-app": {
        "remoteUrl": "git@github.com:patron/my-app.git"
      }
    }
  }
}
```

### Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxMergeRetries` | `number` | `3` | Max rebase-retry attempts during sealing under contention. |
| `draftRoot` | `string` | `".nexus/worktrees"` | Directory where draft worktrees are created, relative to guild root. |

### Registered Codexes

Each key in `registered` is the codex name (unique within the guild). The value:

| Field | Type | Description |
|-------|------|-------------|
| `remoteUrl` | `string` | The remote URL of the codex's git repository. Used for cloning and fetching. |

The config is intentionally minimal — a human can add a codex by hand-editing `guild.json` and the Scriptorium will pick it up on next startup (cloning the bare repo if needed).

---

## Tool Definitions

### `codex-add`

Register an existing repository as a codex.

```typescript
tool({
  name: 'codex-add',
  description: 'Register an existing git repository as a guild codex',
  permission: 'write',
  params: {
    name: z.string().describe('Name for the codex (unique within the guild)'),
    remoteUrl: z.string().describe('Git remote URL of the repository'),
  },
  handler: async ({ name, remoteUrl }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.add(name, remoteUrl)
  },
})
```

### `codex-list`

List all registered codexes.

```typescript
tool({
  name: 'codex-list',
  description: 'List all codexes registered with the guild',
  permission: 'read',
  params: {},
  handler: async () => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.list()
  },
})
```

### `codex-show`

Show details of a specific codex including active drafts.

```typescript
tool({
  name: 'codex-show',
  description: 'Show details of a registered codex including active draft bindings',
  permission: 'read',
  params: {
    name: z.string().describe('Codex name'),
  },
  handler: async ({ name }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.show(name)
  },
})
```

### `codex-remove`

Remove a codex from the guild (does not delete the remote).

```typescript
tool({
  name: 'codex-remove',
  description: 'Remove a codex from the guild (does not affect the remote repository)',
  permission: 'delete',
  params: {
    name: z.string().describe('Codex name to remove'),
  },
  handler: async ({ name }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.remove(name)
  },
})
```

### `codex-push`

Push a branch to the codex's remote.

```typescript
tool({
  name: 'codex-push',
  description: 'Push a branch to the codex remote',
  permission: 'write',
  params: {
    codexName: z.string().describe('Codex name'),
    branch: z.string().optional().describe('Branch to push (default: codex default branch)'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.push(params)
  },
})
```

### `draft-open`

Open a draft binding — create an isolated worktree for a codex.

```typescript
tool({
  name: 'draft-open',
  description: 'Open a draft binding on a codex (creates an isolated git worktree)',
  permission: 'write',
  params: {
    codexName: z.string().describe('Codex to open the draft for'),
    branch: z.string().optional().describe('Branch name for the draft (default: auto-generated draft-<ulid>)'),
    startPoint: z.string().optional().describe('Branch/tag/commit to start from (default: remote HEAD)'),
    associatedWith: z.string().optional().describe('Optional association (e.g. writ id)'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.openDraft(params)
  },
})
```

### `draft-list`

List active draft bindings.

```typescript
tool({
  name: 'draft-list',
  description: 'List active draft bindings, optionally filtered by codex',
  permission: 'read',
  params: {
    codexName: z.string().optional().describe('Filter by codex name'),
  },
  handler: async ({ codexName }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.listDrafts(codexName)
  },
})
```

### `draft-abandon`

Abandon a draft binding.

```typescript
tool({
  name: 'draft-abandon',
  description: 'Abandon a draft binding (removes the git worktree and branch)',
  permission: 'delete',
  params: {
    codexName: z.string().describe('Codex name'),
    branch: z.string().describe('Branch of the draft to abandon'),
    force: z.boolean().optional().describe('Force abandonment even with unmerged changes'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.abandonDraft(params)
  },
})
```

### `draft-seal`

Seal a draft — merge its branch into the sealed binding.

```typescript
tool({
  name: 'draft-seal',
  description: 'Seal a draft binding into the codex (ff-only merge or rebase; no merge commits)',
  permission: 'write',
  params: {
    codexName: z.string().describe('Codex name'),
    sourceBranch: z.string().describe('Draft branch to seal'),
    targetBranch: z.string().optional().describe('Target branch (default: codex default branch)'),
    maxRetries: z.number().optional().describe('Max rebase retries under contention (default: 3)'),
    keepDraft: z.boolean().optional().describe('Keep draft after sealing (default: false)'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes')
    return api.seal(params)
  },
})
```

---

## Session Integration

The Scriptorium and the Animator are **intentionally decoupled**. The Scriptorium manages git infrastructure; the Animator manages sessions. Neither knows about the other. They compose through a simple handoff: the `DraftRecord.path` returned by `openDraft()` is the `cwd` passed to the Animator's `summon()` or `animate()`.

### Composition pattern

The binding between a session and a draft is the caller's responsibility. The typical flow:

```
  Orchestrator (dispatch script, rig engine, standing order)
    │
    ├─ 1. scriptorium.openDraft({ codexName, branch })
    │     → DraftRecord { path: '.nexus/worktrees/nexus/writ-42' }
    │
    ├─ 2. animator.summon({ role, prompt, cwd: draft.path })
    │     → session runs, anima inscribes in the draft
    │     → session exits
    │
    ├─ 3. scriptorium.seal({ codexName, sourceBranch })
    │     → draft sealed into codex
    │
    └─ 4. scriptorium.push({ codexName })
          → sealed binding pushed to remote
```

The anima never touches draft lifecycle — it is launched *inside* the draft's working directory and inscribes there naturally. Infrastructure steps (open, seal, push) happen outside the session, ensuring they execute even if the session crashes or times out.

### The `DraftRecord` as handoff object

The `DraftRecord` carries everything the Animator needs:

- **`path`** — the session's `cwd`
- **`codexName`** — for session metadata (which codex this session worked on)
- **`branch`** — for session metadata (which draft)
- **`associatedWith`** — the writ id, if any (passed through to session metadata)

The Animator stores these as opaque metadata on the session record. The Scriptorium doesn't read session records; the Animator doesn't read draft records. They share data through the orchestrator that calls both.

### Why not tighter integration?

Animas cannot reliably manage their own draft lifecycle. A session's working directory is set at launch — the anima cannot relocate itself to a draft it opens mid-session. Even if it could (via absolute paths and `cd`), the failure modes are poor: crashed sessions leave orphaned drafts, forgotten seal steps leave inscriptions stranded, and every anima reimplements the same boilerplate. External orchestration is simpler and more reliable.

---

## Interim Dispatch Pattern

Before rig engines and the Clockworks exist, a shell script orchestrates the open → session → seal → push lifecycle. This is the recommended interim pattern:

```bash
#!/usr/bin/env bash
# dispatch-commission.sh — open a draft, run a session, seal and push
set -euo pipefail

CODEX="${1:?codex name required}"
ROLE="${2:?role required}"
PROMPT="${3:?prompt required}"

# 1. Open a draft binding (branch auto-generated)
DRAFT=$(nsg codex draft-open --codexName "$CODEX")

DRAFT_PATH=$(echo "$DRAFT" | jq -r '.path')
DRAFT_BRANCH=$(echo "$DRAFT" | jq -r '.branch')

# 2. Run the session in the draft
nsg summon \
  --role "$ROLE" \
  --cwd "$DRAFT_PATH" \
  --prompt "$PROMPT" \
  --metadata "{\"codex\": \"$CODEX\", \"branch\": \"$DRAFT_BRANCH\"}"

# 3. Seal the draft into the codex
nsg codex draft-seal \
  --codexName "$CODEX" \
  --sourceBranch "$DRAFT_BRANCH"

# 4. Push the sealed binding to the remote
nsg codex codex-push \
  --codexName "$CODEX"

echo "Commission sealed and pushed for $CODEX ($DRAFT_BRANCH)"
```

This script is intentionally simple — no error recovery, no retry logic beyond what `draft-seal` provides internally. A failed seal leaves the draft in place for manual inspection. A failed push leaves the sealed binding local — re-running `codex-push` is safe. The auto-generated branch name flows through the `DraftRecord` — the orchestrator never needs to invent one.

---

## Bare Clone Architecture

The Scriptorium maintains **bare clones** of each codex under `.nexus/codexes/<name>.git`. This is the local git infrastructure that makes draft operations fast and network-efficient.

```
.nexus/
  codexes/
    nexus.git/          ← bare clone of git@github.com:shardworks/nexus.git
    my-app.git/         ← bare clone of git@github.com:patron/my-app.git
  worktrees/
    nexus/
      writ-42/          ← draft: nexus, branch writ-42
      writ-57/          ← draft: nexus, branch writ-57
    my-app/
      writ-63/          ← draft: my-app, branch writ-63
```

### Why bare clones?

- **Single clone, many drafts.** A bare clone has no working tree of its own — it's just the git object database. Multiple draft worktrees can be created from it simultaneously without duplicating the repository data.
- **Network efficiency.** After the initial clone, updates are `git fetch` operations — fast, incremental, no full re-clone.
- **Transparent to animas.** An anima inscribing in a draft sees a normal git checkout. It doesn't know or care that the underlying repo is a bare clone. `git commit`, `git log`, `git diff` all work normally.
- **Clean separation.** The bare clone in `.nexus/codexes/` is infrastructure; the draft worktrees in `.nexus/worktrees/` are workspaces. Neither pollutes the guild's versioned content.

### Lifecycle

```
codex-add
  ├─ 1. Write entry to guild.json config
  ├─ 2. git clone --bare <remoteUrl> .nexus/codexes/<name>.git
  └─ 3. Record clone status in Stacks

draft-open
  ├─ 1. git fetch (in bare clone) — ensure refs are current
  ├─ 2. git worktree add .nexus/worktrees/<codex>/<branch> -b <branch> <startPoint>
  └─ 3. Record draft in Stacks

draft-seal
  ├─ 1. Fetch latest target branch refs
  ├─ 2. Attempt fast-forward merge
  │     └─ If ff not possible: rebase source onto target
  │        └─ If rebase conflicts: FAIL (no auto-resolution)
  │        └─ If rebase succeeds: retry ff (up to maxRetries)
  ├─ 3. Update target branch ref in bare clone
  └─ 4. Abandon draft (unless keepDraft)

codex-push
  ├─ 1. git push origin <branch> (from bare clone)
  └─ 2. Never force-push

codex-remove
  ├─ 1. Abandon all drafts for codex
  ├─ 2. Remove bare clone directory
  ├─ 3. Remove entry from guild.json
  └─ 4. Clean up Stacks records
```

### Sealing Strategy Detail

Sealing enforces **linear history** on the sealed binding — no merge commits, no force pushes. If a draft's inscriptions contradict the sealed binding (i.e. the sealed binding has advanced since the draft was opened), the sealing engine attempts to reconcile via rebase. If reconciliation fails, sealing seizes — the tool fails rather than creating non-linear history or silently resolving conflicts.

Git mechanics:

```
Seal Attempt:
  ├─ Try: git merge --ff-only <draft-branch> into <sealed-branch>
  │   ├─ Success → draft sealed
  │   └─ Fail (sealed binding has advanced) →
  │       ├─ Fetch latest sealed binding from remote
  │       ├─ Try: git rebase <sealed-branch> <draft-branch>
  │       │   ├─ Conflict → FAIL (sealing seizes — manual reconciliation needed)
  │       │   └─ Clean rebase →
  │       │       └─ Retry ff-only merge (loop, up to maxRetries)
  │       └─ All retries exhausted → FAIL
  └─ Never: merge commits, force push, conflict auto-resolution
```

The retry loop handles **contention** — when multiple animas seal to the same codex in quick succession, each fetch-rebase-ff cycle picks up the other's sealed inscriptions. Three retries (configurable via `settings.maxMergeRetries`) is sufficient for typical guild concurrency; the limit prevents infinite loops in pathological cases.

---

## Clone Readiness and Fetch Policy

### Initial clone

The `add()` API **blocks until the bare clone completes**. The caller gets back a `CodexRecord` with `cloneStatus: 'ready'` — registration isn't done until the clone is usable. This keeps the contract simple: if `add()` returns successfully, the codex is operational.

At **startup**, the Scriptorium checks each configured codex for an existing bare clone. Missing clones are initiated in the background — the apparatus starts without waiting. However, any tool invocation that requires the bare clone (everything except `codex-list`) **blocks until that codex's clone is ready**. The tool doesn't fail or return stale data; it waits. If the clone fails, the tool fails with a clear error referencing the clone failure.

### Fetch before branch operations

Every operation that creates or modifies branches **fetches from the remote first**:

- **`openDraft`** — fetches before branching, ensuring the start point reflects the latest remote state.
- **`seal`** — fetches the target branch before attempting ff-only, and again on each retry iteration.
- **`push`** — does **not** fetch first (it's pushing, not pulling).

`fetch` is also exposed as a standalone API for manual use, but callers generally don't need it — the branch operations handle freshness internally.

### Startup reconciliation

On `start()`, the Scriptorium:

1. Reads the `codexes` config from `guild.json`
2. For each configured codex, checks whether a bare clone exists at `.nexus/codexes/<name>.git`
3. Initiates background clones for any missing codexes
4. Reconciles Stacks records with filesystem state (cleans up records for drafts that no longer exist on disk)

This means a patron can hand-edit `guild.json` to add a codex, and the Scriptorium will clone it on next startup.

---

## Draft Branch Collisions

If a caller requests a draft with a branch name that already exists for that codex, `openDraft` **rejects with a clear error**. Branch naming is the caller's responsibility. Auto-suffixing would hide real problems (two writs accidentally opening drafts on the same branch). Git enforces this at the worktree level — a branch can only be checked out in one worktree at a time — and the Scriptorium surfaces the constraint rather than working around it.

---

## Draft Cleanup

The Scriptorium does **not** automatically reap stale drafts. It provides the `abandonDraft` API; when and why to call it is an external concern. A future reaper process, standing order, or manual cleanup can use `draft-list` and `draft-abandon` as needed. This keeps the Scriptorium ignorant of writ lifecycle and other domain concerns.

---

## Future: Clockworks Events

When the Clockworks apparatus exists, the Scriptorium should emit events for downstream consumers (particularly the Surveyor):

| Event | Payload | When |
|-------|---------|------|
| `codex.added` | `{ name, remoteUrl }` | A codex is registered |
| `codex.removed` | `{ name }` | A codex is deregistered |
| `codex.fetched` | `{ name }` | A codex's bare clone is fetched |
| `draft.opened` | `{ codexName, branch, path, associatedWith? }` | A draft is opened |
| `draft.abandoned` | `{ codexName, branch }` | A draft is abandoned |
| `draft.sealed` | `{ codexName, sourceBranch, targetBranch, strategy }` | A draft is sealed |
| `codex.pushed` | `{ codexName, branch }` | A branch is pushed to remote |

Until then, downstream consumers query the Scriptorium API directly.

---

## Implementation Notes

- **`guild().writeConfig()`** — the Scriptorium uses `guild().writeConfig('codexes', ...)` to persist codex registry changes to `guild.json`. This API was added to the `Guild` interface in `@shardworks/nexus-core` and implemented in Arbor. It updates both the in-memory config and the disk file atomically.
- **Git operations.** All git operations use `child_process.execFile` (not shell) via a lightweight `git.ts` helper that handles error parsing and provides typed results (`GitResult`, `GitError`).
- **Concurrency.** Multiple animas may open/seal drafts concurrently. The bare clone's git operations need appropriate locking — git's own ref locking handles most cases, but the fetch-rebase-seal cycle should be serialized per codex to avoid ref races.
- **No downstream coupling.** The Scriptorium has no dependency on the Surveyor, the Walker, or any other consumer of codex state. It is pure infrastructure. Downstream apparatus query or (future) subscribe to the Scriptorium's state independently.

---

## Future State

### Draft Persistence via Stacks

The current implementation tracks active drafts **in memory**, reconstructed from filesystem state at startup. This is sufficient for MVP — draft worktrees are durable on disk and the Scriptorium reconciles on restart. However, this means:

- Draft metadata (`associatedWith`, `createdAt`) is approximate after a restart — the original values are lost.
- There is no queryable history of past drafts (abandoned or sealed).
- Other apparatus cannot subscribe to draft state changes via CDC.

A future iteration should persist `DraftRecord` entries to a Stacks book (`codexes/drafts`), enabling:

- Durable metadata that survives restarts
- Historical draft records (with terminal status: `sealed`, `abandoned`)
- CDC-driven downstream reactions (e.g. the Surveyor updating its codex-awareness when a draft is sealed)

### Per-Codex Sealing Lock

The sealing retry loop (fetch → rebase → ff) is not currently serialized per codex. Under high concurrency (multiple animas sealing to the same codex simultaneously), ref races are possible. Git's own ref locking prevents corruption, but the retry loop may exhaust retries unnecessarily.

A per-codex async mutex around the seal operation would eliminate this. The lock should be held only during the seal attempt, not during the preceding fetch or the subsequent draft cleanup.

### Clockworks Event Emission

Documented in the **Future: Clockworks Events** section above. When the Clockworks apparatus exists, the Scriptorium should emit events for each lifecycle operation. This replaces the current pattern where downstream consumers poll the API directly.
