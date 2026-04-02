# `@shardworks/codexes-apparatus`

The Scriptorium — guild codex management apparatus. Manages the guild's codexes (git repositories), draft bindings (isolated worktrees for concurrent work), and the sealing lifecycle that incorporates drafts into the sealed binding. Depends on `@shardworks/stacks-apparatus` for state tracking.

The Scriptorium is pure git infrastructure. It does not know what a codex contains or what work applies to it — that's the Surveyor's domain. It does not orchestrate which anima works in which draft — that's the caller's concern.

---

## Installation

Add to your guild's dependencies:

```json
{
  "dependencies": {
    "@shardworks/codexes-apparatus": "workspace:*"
  }
}
```

Register in `guild.json`:

```json
{
  "plugins": ["codexes"]
}
```

---

## API

The Scriptorium provides `ScriptoriumApi` — retrieved via `guild().apparatus<ScriptoriumApi>('codexes')`.

### Codex Registry

```typescript
import { guild } from '@shardworks/nexus-core';
import type { ScriptoriumApi } from '@shardworks/codexes-apparatus';

const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');

// Register a codex (blocks until bare clone completes)
const codex = await scriptorium.add('my-app', 'git@github.com:org/my-app.git');

// List all codexes
const codexes = await scriptorium.list();

// Show details including active drafts
const detail = await scriptorium.show('my-app');

// Fetch latest refs from remote
await scriptorium.fetch('my-app');

// Push sealed binding to remote
await scriptorium.push({ codexName: 'my-app' });

// Remove a codex (abandons all drafts, removes bare clone)
await scriptorium.remove('my-app');
```

### Draft Binding Lifecycle

```typescript
// Open a draft (creates an isolated git worktree)
const draft = await scriptorium.openDraft({
  codexName: 'my-app',
  branch: 'writ-42',           // optional — auto-generates if omitted
  associatedWith: 'writ-42',   // optional metadata
});
// draft.path → '.nexus/worktrees/my-app/writ-42'

// List active drafts
const drafts = await scriptorium.listDrafts('my-app');

// Seal a draft into the codex (ff-only; rebase on contention)
const result = await scriptorium.seal({
  codexName: 'my-app',
  sourceBranch: 'writ-42',
});
// result → { success: true, strategy: 'fast-forward', retries: 0, sealedCommit: 'abc123', inscriptionsSealed: 2 }
// inscriptionsSealed: 0 means a no-op seal (draft had no commits ahead of target)

// Abandon a draft (removes worktree + branch)
await scriptorium.abandonDraft({
  codexName: 'my-app',
  branch: 'writ-42',
  force: true,   // required if draft has unsealed inscriptions
});
```

### Session Integration

The Scriptorium and the Animator compose through a simple handoff — `DraftRecord.path` is the `cwd` for session launch:

```typescript
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { ScriptoriumApi } from '@shardworks/codexes-apparatus';

const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');
const animator = guild().apparatus<AnimatorApi>('animator');

// 1. Open a draft
const draft = await scriptorium.openDraft({ codexName: 'nexus' });

// 2. Launch a session in the draft's working directory
const { result } = animator.summon({
  role: 'artificer',
  prompt: 'Build the frobnicator',
  cwd: draft.path,
});
await result;

// 3. Seal the draft
await scriptorium.seal({
  codexName: 'nexus',
  sourceBranch: draft.branch,
});

// 4. Push to remote
await scriptorium.push({ codexName: 'nexus' });
```

---

## Configuration

The `codexes` section in `guild.json`:

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
| `maxMergeRetries` | `number` | `3` | Max rebase-retry attempts during sealing under contention |
| `draftRoot` | `string` | `".nexus/worktrees"` | Directory where draft worktrees are created, relative to guild root |

### Registered Codexes

Each key in `registered` is the codex name. Codexes can be registered via the `codex-add` tool or by hand-editing `guild.json` — the Scriptorium clones any missing bare repos on startup.

| Field | Type | Description |
|-------|------|-------------|
| `remoteUrl` | `string` | Git remote URL of the codex's repository |

---

## Support Kit

The Scriptorium contributes 9 tools via its support kit:

### Codex Tools

| Tool | Permission | Description |
|------|-----------|-------------|
| `codex-add` | `write` | Register a git repository as a guild codex |
| `codex-list` | `read` | List all registered codexes |
| `codex-show` | `read` | Show codex details including active drafts |
| `codex-remove` | `delete` | Remove a codex from the guild |
| `codex-push` | `write` | Push a branch to the codex's remote |

### Draft Tools

| Tool | Permission | Description |
|------|-----------|-------------|
| `draft-open` | `write` | Open a draft binding (creates an isolated worktree) |
| `draft-list` | `read` | List active draft bindings |
| `draft-abandon` | `delete` | Abandon a draft (removes worktree + branch) |
| `draft-seal` | `write` | Seal a draft into the codex (ff-only or rebase) |

---

## Types

### `ScriptoriumApi`

The full `provides` interface — see [API](#api) above for usage.

### Record Types

```typescript
interface CodexRecord {
  name: string
  remoteUrl: string
  cloneStatus: 'ready' | 'cloning' | 'error'
  activeDrafts: number
}

interface CodexDetail extends CodexRecord {
  defaultBranch: string
  lastFetched: string | null
  drafts: DraftRecord[]
}

interface DraftRecord {
  id: string
  codexName: string
  branch: string
  path: string
  createdAt: string
  associatedWith?: string
}
```

### Request / Result Types

```typescript
interface OpenDraftRequest {
  codexName: string
  branch?: string
  startPoint?: string
  associatedWith?: string
}

interface AbandonDraftRequest {
  codexName: string
  branch: string
  force?: boolean
}

interface SealRequest {
  codexName: string
  sourceBranch: string
  targetBranch?: string
  maxRetries?: number
  keepDraft?: boolean
}

interface SealResult {
  success: boolean
  strategy: 'fast-forward' | 'rebase'
  retries: number
  sealedCommit: string
  /** Number of inscriptions (commits) incorporated from the draft. 0 = no-op seal. */
  inscriptionsSealed: number
}

interface PushRequest {
  codexName: string
  branch?: string
}
```

### Configuration Types

```typescript
interface CodexesConfig {
  settings?: CodexesSettings
  registered?: Record<string, CodexConfigEntry>
}

interface CodexesSettings {
  maxMergeRetries?: number
  draftRoot?: string
}

interface CodexConfigEntry {
  remoteUrl: string
}
```
