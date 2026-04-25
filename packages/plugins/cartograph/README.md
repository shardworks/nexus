# `@shardworks/cartograph-apparatus`

The Cartograph stands up the **decomposition-ladder** substrate: a typed
data layer for tracking long-lived patron intent across four levels —
**vision** (top, patron-owned, long-lived) → **charge** (first
decomposition, the unit of patron walkthrough) → **piece** (recursive,
internal organization, self-nesting) → **mandate** (the existing leaf
where rigs attach).

This commission lands the **data-and-typed-API substrate only**. There is
no agent runtime, no CLI surface, and no downstream consumer in this
package — those land in follow-on commissions. What ships here:

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

## What is *not* in this commission

- No vision-keeper agent runtime. `vision-keeper.md` is a placeholder
  stub; the agent runtime ships in a separate commission.
- No CLI commands (`nsg vision`, `nsg charge`, `nsg piece`).
- No pages — the Oculus writs page auto-renders the new types via its
  type-vocabulary helper.
- No tools, no `tools-apparatus` dependency.
- No link kinds — parent edges flow through `writ.parentId`. Typed link
  kinds are deferred.
- No `childrenBehavior` cascade — patron-walkthrough semantics will be
  coordinated by the typed API and downstream consumers.
