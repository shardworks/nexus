# `@shardworks/cartograph-apparatus`

The Cartograph stands up the **decomposition-ladder** substrate: a typed
data layer for tracking long-lived patron intent across four levels —
**vision** (top, patron-owned, long-lived) → **charge** (first
decomposition, the unit of patron walkthrough) → **piece** (recursive,
internal organization, self-nesting) → **mandate** (the existing leaf
where rigs attach).

This commission lands the **data-and-typed-API substrate plus a
patron-facing CLI**. There is no agent runtime and no downstream
consumer in this package — those land in follow-on commissions. What
ships here:

- Three new writ types contributed to the Clerk: `vision`, `charge`,
  `piece`. Each uses a six-state mandate-clone lifecycle (no
  `childrenBehavior` cascade — patron-walkthrough semantics will be
  coordinated by the typed API and downstream consumers, not by
  registry-side cascade rules).
- Three companion books (`visions`, `charges`, `pieces`) keyed by the
  writ id, each holding a typed companion document with the per-type
  stage and audit fields.
- A `CartographApi` exposed via `provides` that is the **only** layer
  enforcing the ladder's parent invariants:
  - vision has no parent;
  - `charge.parentId` must be a vision;
  - `piece.parentId` must be a charge or piece.
  Raw `clerk.post({ type: 'vision' })` continues to succeed without
  parent-type checks — the typed API is the validator. The mandate-side
  rules (mandate may attach under any non-terminal node) stay where they
  are.
- A patron-facing CLI surface contributed via `supportKit.tools` —
  three subcommand groups (`nsg vision`, `nsg charge`, `nsg piece`),
  each with five operations (`create`, `show`, `list`, `patch`,
  `transition`) plus the on-disk authoring tool `nsg vision apply`.
  The framework `nsg` auto-builder discovers the tools at startup and
  groups them by hyphen prefix; no edits to the framework CLI package
  are required. Every tool routes through the typed API above, so the
  parent invariants and lifecycle coupling hold for CLI-driven
  authoring.

The Cartograph requires `stacks` and `clerk` and recommends `oculus`. The
Oculus writs page automatically renders the new types via the
type-vocabulary helper; without oculus the data is invisible to the
dashboard.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/cartograph-apparatus": "workspace:*"
  }
}
```

## API

The Cartograph exposes a `CartographApi` via `provides`, accessible at
runtime via `guild().apparatus<CartographApi>('cartograph')`.

```typescript
import type { CartographApi } from '@shardworks/cartograph-apparatus';

const cartograph = guild().apparatus<CartographApi>('cartograph');

// Create a vision (no parent permitted)
const vision = await cartograph.createVision({
  title: 'Land the agentic decomposition ladder',
  body: 'Long-form patron intent ...',
  codex: 'main',
});

// Create a charge under that vision
const charge = await cartograph.createCharge({
  parentId: vision.id,
  title: 'Stand up the data substrate',
  body: 'First decomposition ...',
});

// Create a piece under the charge
const piece = await cartograph.createPiece({
  parentId: charge.id,
  title: 'Pick a companion-doc shape',
  body: 'Internal organization ...',
});

// Pieces can self-nest
const subPiece = await cartograph.createPiece({
  parentId: piece.id,
  title: 'Decide how createX writes both rows atomically',
  body: 'Internal sub-piece ...',
});
```

Each `createX` opens a single `stacks.transaction(...)` and writes the
writ row and the companion doc inside one atomic boundary. Parent
existence, parent-not-terminal, codex inheritance, and id generation
match Clerk's `post()` validation byte-for-byte (the duplication is the
cost of being a typed atomic surface).

### `CartographApi`

```typescript
interface CartographApi {
  // Vision
  createVision(req: CreateVisionRequest): Promise<VisionDoc>;
  showVision(id: string): Promise<VisionDoc>;
  listVisions(filters?: VisionFilters): Promise<VisionDoc[]>;
  patchVision(id: string, fields: Partial<Omit<VisionDoc, 'id'>>): Promise<VisionDoc>;
  transitionVision(id: string, to: { phase: WritPhase; stage: VisionStage; resolution?: string }): Promise<VisionDoc>;

  // Charge
  createCharge(req: CreateChargeRequest): Promise<ChargeDoc>;
  showCharge(id: string): Promise<ChargeDoc>;
  listCharges(filters?: ChargeFilters): Promise<ChargeDoc[]>;
  patchCharge(id: string, fields: Partial<Omit<ChargeDoc, 'id'>>): Promise<ChargeDoc>;
  transitionCharge(id: string, to: { phase: WritPhase; stage: ChargeStage; resolution?: string }): Promise<ChargeDoc>;

  // Piece
  createPiece(req: CreatePieceRequest): Promise<PieceDoc>;
  showPiece(id: string): Promise<PieceDoc>;
  listPieces(filters?: PieceFilters): Promise<PieceDoc[]>;
  patchPiece(id: string, fields: Partial<Omit<PieceDoc, 'id'>>): Promise<PieceDoc>;
  transitionPiece(id: string, to: { phase: WritPhase; stage: PieceStage; resolution?: string }): Promise<PieceDoc>;
}
```

The lifecycle-coupled `transitionX` methods update both `writ.phase` and
the companion doc's `stage` field atomically, inside a single Stacks
transaction. The caller specifies both the target phase and the target
stage explicitly because a single phase may map to multiple stages
depending on context (e.g. a charge moving to `failed` could mean
stage `dropped` or stage `validated` depending on outcome).

### Companion documents

```typescript
interface VisionDoc { id: string; stage: VisionStage; codex?: string; createdAt: string; updatedAt: string; }
interface ChargeDoc { id: string; stage: ChargeStage; codex?: string; createdAt: string; updatedAt: string; }
interface PieceDoc  { id: string; stage: PieceStage;  codex?: string; createdAt: string; updatedAt: string; }

type VisionStage = 'draft' | 'active' | 'sunset' | 'cancelled';
type ChargeStage = 'draft' | 'active' | 'validated' | 'dropped';
type PieceStage  = 'draft' | 'active' | 'done' | 'dropped';
```

The minimal field set is deliberate — the patch surface plus the
`[key: string]: unknown` index signature lets consumers grow the field
set non-breakingly later. Vision text lives on `writ.body`; the
companion doc carries typed metadata only.

### Filters

`VisionFilters`, `ChargeFilters`, and `PieceFilters` mirror the
`PlanFilters` shape from astrolabe — `{ stage?, codex?, limit?, offset? }`.
Lists are ordered by `createdAt desc` (newest first).

## Support Kit

### Books

| Book | Owner | Indexes |
|---|---|---|
| `visions` | `cartograph` | `stage`, `codex`, `createdAt` |
| `charges` | `cartograph` | `stage`, `codex`, `createdAt` |
| `pieces`  | `cartograph` | `stage`, `codex`, `createdAt` |

### Writ Types (contributed to Clerk)

| Name | Description |
|---|---|
| `vision` | Top-level patron intent. No parent. Long-lived. |
| `charge` | First decomposition under a vision; the unit of patron walkthrough. Parent must be a vision. |
| `piece`  | Recursive internal organization. Self-nests. Parent must be a charge or piece. |

Each writ type uses a six-state mandate-clone lifecycle:
`new` (initial) → `open` (active) → `stuck`/`completed`/`failed`/`cancelled`;
no `childrenBehavior` cascade.

## CLI

Cartograph contributes three subcommand groups to `nsg` — one per writ
type — with the same five operations under each:

| Command | Description |
|---|---|
| `nsg vision create --title <t> --body <b> [--codex <c>]` | Create a top-level vision (writ at `phase: new`, doc at `stage: draft`). |
| `nsg charge create --parent-id <vision> --title <t> --body <b> [--codex <c>]` | Create a charge under a vision. |
| `nsg piece create --parent-id <charge\|piece> --title <t> --body <b> [--codex <c>]` | Create a piece under a charge or piece (self-nests). |
| `nsg <type> show <id> [--format text\|json]` | Show the companion doc joined with the writ row. Text mode mirrors `nsg writ show`'s lifecycle-aware block; JSON returns `{ ...doc, writ: { ... } }`. |
| `nsg <type> list [--stage <s>] [--codex <c>] [--limit <n>] [--offset <n>] [--format text\|json]` | Tabular list (STAGE \| ID \| CODEX \| TITLE \| CREATED) ordered by `createdAt desc`. |
| `nsg <type> patch <id> --codex <c>` | Patch the companion doc's `codex`. Title and body live on the writ row — edit them via `nsg writ edit`. |
| `nsg <type> transition <id> --phase <writ-phase> --stage <doc-stage> [--resolution <r>]` | Atomically advance both `writ.phase` and the companion doc's `stage` inside one Stacks transaction. Both `--phase` and `--stage` are required because a single phase may map to multiple stages depending on context. |
| `nsg vision apply <slug> [--severity <s>] [--deadline <d>] [--decay <d>]` | Snapshot the on-disk vision at `<GUILD>/vision/<slug>/` into a vision writ + VisionDoc. Idempotent: first apply creates and binds; later applies sync the file's contents into the bound writ. CLI flags override sidecar values for the surveyor priority-hint payload. |

The CLI tools are read or write according to operation: `show`/`list`
declare `permission: 'read'`; `create`/`patch`/`transition`/`apply`
declare `permission: 'write'`. Every tool declares
`callableBy: ['patron']` — they are not exposed to anima or library
callers in this commission. Only `show` and `list` accept the
`--format text|json` flag; write tools return their result directly
and the framework auto-stringifies.

Short-prefix id resolution (via `clerk.resolveId`) works on every
id-bearing flag: `nsg vision show w-mo123` and
`nsg charge create --parent-id w-mo123` both succeed when the prefix
matches a single writ.

## On-disk vision authoring

Visions are prose-heavy and long-lived; the patron-facing path is to
author them in a normal editor on disk and snapshot the directory into
the cartograph with `nsg vision apply <slug>`. The same code path
handles first-time creation and Nth re-import — the binding is durable
across applies, so the file tree is the source of truth for vision
content while the cartograph remains the source of truth for lifecycle
state and ext metadata.

### File layout

```
<GUILD>/
└── vision/
    └── <slug>/
        ├── vision.md              # long-form vision text → writ.body
        └── vision-metadata.yml    # required sidecar
```

The slug must be a single directory name (lowercase letters, digits,
hyphens, or underscores; no path separators, no leading dots, no
`..`). It is fixed at creation time; rename is not supported.

### Sidecar shape

```yaml
# vision-metadata.yml
title: Land the agentic decomposition ladder    # required
stage: draft                                    # required: draft | active

codex: main                                     # optional
severity: high                                  # optional priority hint
deadline: 2026-06-30                            # optional priority hint
decay: slow                                     # optional priority hint
complexity: medium                              # optional priority hint (sidecar-only)
resolution: patron retired the vision           # optional, used on terminal transitions

# Managed by `nsg vision apply` — do not edit by hand.
visionId: w-...                                 # written after first apply
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Short human-readable title for the vision writ. |
| `stage` | yes | Lifecycle stage. Allowed initial values are `draft` (writ phase `new`) and `active` (writ phase `open`). `sunset` and `cancelled` are rejected on first apply — a vision cannot be born retired; transition to a terminal stage on a later apply. |
| `codex` | no | Target codex name for the vision. |
| `visionId` | no, system-managed | Written by `apply` after first creation. **Do not edit by hand.** Clear the field only to deliberately re-create the vision (the old writ stays in place and becomes orphaned from this directory). |
| `severity` | no | Priority hint surfaced in `writ.ext['surveyor']`. |
| `deadline` | no | Priority hint surfaced in `writ.ext['surveyor']`. |
| `decay` | no | Priority hint surfaced in `writ.ext['surveyor']`. |
| `complexity` | no | Priority hint surfaced in `writ.ext['surveyor']`. Sidecar-only — there is no CLI flag for this field. |
| `resolution` | no | Passed through to `transitionVision` on terminal moves. |

Unknown keys are logged as a warning and ignored (preserves
forward-compatibility while still surfacing typos).

### `visionId` binding

After the first successful `nsg vision apply <slug>`, the tool writes
the new writ's id back into the sidecar as `visionId`. The yaml is
round-tripped via `parseDocument`, so comments and key order survive
the rewrite, and the file is replaced atomically (write-temp,
rename-over) so a process crash cannot lose the binding.

On every subsequent apply the tool resolves the writ via `visionId`,
updates `writ.body` from `vision.md`, and syncs stage/codex changes
through the typed cartograph API. Edits to the writ are **not**
propagated back to the file — the data flow is one-way (file → writ).

### Stale-binding recovery

If the bound writ has been deleted, cancelled, completed, or failed,
the next apply errors cleanly with no partial writes. To recover,
either restore the writ to a non-terminal state, or clear the
`visionId` field in the sidecar to let the next apply re-create the
vision (the orphaned writ stays in place; `nsg writ cancel` it
manually if needed).

### Priority-hint semantics (`ext['surveyor']`)

Each apply writes a payload into `writ.ext['surveyor']` carrying the
fields enumerated above (`severity`, `deadline`, `decay`,
`complexity`). CLI flags override sidecar values for the merged
result:

```sh
# sidecar severity=low; CLI override wins
nsg vision apply my-vision --severity high
```

Fields that neither source provides are omitted from the payload. The
slot is **always** written — even when the merged payload is `{}` — so
its presence on the writ marks it as having been processed by the
apply tool.

The slot's owner — a future surveyor-apparatus plugin that consumes
these hints — does not yet ship. Until it does, the slot is inert; the
key (`surveyor`) and the payload shape are load-bearing precedent for
that future commission.

## What is *not* in this commission

- No vision-keeper agent runtime. `vision-keeper.md` is a placeholder
  stub; the agent runtime ships in a separate commission.
- No per-type tree command. `nsg writ tree --type vision` already
  renders the writ-level shape; the cartograph-aware tree renderer
  (with stage badges per row) is a future commission.
- No pages — the Oculus writs page auto-renders the new types via its
  type-vocabulary helper.
- No link kinds — parent edges flow through `writ.parentId`. Typed link
  kinds are deferred.
- No `childrenBehavior` cascade — patron-walkthrough semantics are
  coordinated by the typed API and downstream consumers.
