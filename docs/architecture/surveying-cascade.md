# The Surveying Cascade — Patron-Vision Authoring through Mandate Dispatch

Status: **Draft**

> **⚠️ Cross-apparatus design.** This document defines the
> end-to-end cascade by which patron-authored product visions become
> commissionable mandate work, spanning three apparatuses: the
> Cartograph (data layer, shipped), the Surveyor (substrate +
> extension + default, shipped), and the Reckoner (petition
> scheduler, shipped). It is a settled architectural reference; the
> open questions section names the design problems that remain.

---

## Scope

The cascade covers:

- **Vision authoring on disk** — patrons author visions as `vision.md`
  files in a guild directory tree; `nsg vision apply` snapshots them
  into the cartograph.
- **Recursive surveying** — typed survey writs at every cartograph
  layer (vision/charge/piece) gate the work of decomposing one node
  into its children, using the Reckoner for scheduling.
- **Mandate emission** — surveying piece-layer (or charge-layer)
  rigs ultimately produce mandates, which dispatch through the
  existing implementer pipeline unchanged.

Out of scope: the patron walkthrough surface (the patron-contract
validation step at the charge layer) is acknowledged as a
substantial design problem but designed elsewhere.

---

## 1. Vocabulary

| Concept | Definition |
|---|---|
| **Vision** | Long-lived patron intent. Authored on disk; snapshotted into a writ (with stage and codex carried in `writ.ext['cartograph']`) by the cartograph. |
| **Charge** | First decomposition under a vision. Patron-contract boundary; the unit of patron walkthrough. Does NOT self-nest. |
| **Piece** | Recursive internal organization under a charge. Self-nests. No patron contract. |
| **Mandate** | Existing leaf writ; dispatched by Spider via the existing implementer pipeline. |
| **Survey writ** (`survey-vision`/`survey-charge`/`survey-piece`) | Typed writ that captures one act of surveying one cartograph node. `writ.body` holds the rig's notes (set on rig completion). One survey writ per surveying event. Envelope metadata lives on `writ.ext['surveyor']` (registration-time provenance) and `writ.status['surveyor']` (post-hoc observations) — see §3.4. |
| **`ext['cartograph']`** | Plugin-keyed `writ.ext` slot owned by the cartograph-apparatus. Carries `{ stage, codex }` for vision/charge/piece writs. Replaces the earlier per-type companion books (`cartograph/visions`, `cartograph/charges`, `cartograph/pieces`). |
| **Surveyor** | The role / agent / apparatus that performs surveying. The substrate provides the cascade machinery; concrete surveyor implementations register their rig templates as kit contributions. |
| **`ext['surveyor']`** | Plugin-keyed `writ.ext` slot owned by the surveyor-apparatus. On cartograph nodes, carries priority hints (severity, deadline, decay, complexity) — set by the patron via apply CLI for visions, set by the upstream surveyor rig for charges and pieces. On survey writs, carries registration-time provenance (`rigVersion`, `surveyorId`). The substrate translates the priority hints into Reckoner dimensions when emitting the survey petition. |
| **`status['surveyor']`** | Plugin-keyed `writ.status` slot owned by the surveyor-apparatus. Stamped on survey-writ completion via `ClerkApi.setWritStatus`. Carries the survey outcome and per-completion observations. |

> **Naming note.** "The Surveyor" was previously reserved in the
> framework architecture for a codex-awareness apparatus. That use is
> superseded by the cartograph-decomposition meaning defined here. The
> alias registry in the sanctum carries the substitution.

---

## 2. End-to-end flow

```
PATRON
  │ writes vision.md + sidecar in <GUILD>/vision/<slug>/
  │
  │ runs `nsg vision apply <slug> [--severity ...] [--deadline ...]`
  ▼
CARTOGRAPH (data layer)
  │ creates or updates the vision writ; stamps writ.ext['cartograph']
  │ ({ stage, codex }) inside one stacks.transaction with the post/transition
  │ writes ext['surveyor'] priority hints from CLI flags + sidecar
  │ emits Stacks CDC on book.clerk.writs (filtered by writ.type = 'vision')
  ▼
SURVEYOR-APPARATUS (substrate)
  │ CDC observer fires
  │ reads ext['surveyor'] hints from the cartograph node
  │ creates a survey-vision writ in `new` phase, parentId = the vision
  │ stamps ext['reckoner'] (priority dimensions derived from hints + defaults)
  ▼
RECKONER
  │ holds petition, evaluates per tick
  │ dependency-aware gating; scheduler decides accept/decline/defer
  │ on accept: clerk.transition → survey-vision writ moves to `open`
  ▼
SPIDER (extended to dispatch survey-* writ types)
  │ resolves rig template via the surveyor registry
  │ dispatches to the registered surveyor's rig
  ▼
SURVEYOR RIG (provided by the registered surveyor implementation)
  │ reads parent (vision) via writ.parentId
  │ reads existing children if any (re-survey case)
  │ reasons about decomposition
  │ creates child charges via cartograph API + sets ext['surveyor'] hints
  │ writes its notes into survey-vision writ.body
  │ completes the survey-vision writ
  ▼
[CASCADE]
  │ each new charge fires CDC → substrate creates survey-charge writ
  │ → recursion descends one layer
  ▼
LEAF (mandate)
  │ pieces eventually elaborate to mandates
  │ mandates dispatch through the existing implementer pipeline
```

---

## 3. Architecture

### 3.1 Vision authoring on disk

The patron's authoring surface is a directory tree:

```
<GUILD>/vision/
  <slug>/
    vision.md             ← prose, patron-edited
    vision-metadata.yml   ← sidecar; carries `visionId` after first apply
```

- The slug is a directory affordance, not a durable identity. After
  first apply, the sidecar's `visionId` field binds the file tree to
  its cartograph writ — written by the system, never edited by hand.
- `nsg vision apply <slug>` is a single code path for both first
  import and Nth re-import: locate sidecar, resolve bound writ via
  `visionId` (or create new), copy prose into `writ.body`, sync
  stage/codex via `transitionVision`, write priority hints into
  `ext['surveyor']`, and on first run write the new id back into the
  sidecar.
- Data flow is **one-way: file → writ**. The writ is a snapshot of
  patron intent; the file is the editable source.
- Stale-binding (file deleted, writ remains): warn at scan, error on
  next apply attempt; the patron transitions the writ to
  sunset/cancelled explicitly.

### 3.2 Symmetric typed-writ-driven cascade

Surveying happens through dedicated survey writs at every cartograph
layer. The cascade has a uniform shape:

1. A cartograph node lands (vision via apply; charge or piece via an
   upstream survey rig).
2. CDC fires on the cartograph book — `created` or `updated`.
3. The surveyor-apparatus's observer reads `ext['surveyor']` from the
   node and creates the appropriate survey writ in `new` phase with
   `parentId` set to the cartograph node. Priority hints translate
   into Reckoner dimensions.
4. The observer stamps `ext['reckoner']` to enter the petition queue.
5. Reckoner gates per its existing rules.
6. On accept, Spider dispatches the registered surveyor's rig.
7. Rig reads the parent (and existing children, on re-survey),
   reasons about decomposition, creates children via the surveyor
   tool surface (which atomically creates the cartograph node and
   stamps its `ext['surveyor']`), writes its notes into the survey
   writ's `body`, completes.
8. Each child cartograph node fires fresh CDC → loop to step 2 one
   layer down.

Why symmetric (separate survey writs at every layer) over asymmetric
(rigs bound directly to charge/piece writs): notes have a clean home
(`writ.body` of a dedicated writ per surveying event); charge/piece
writ lifecycle stays clean (their phase is about contract lifecycle,
not about whether decomposition has happened); future re-survey of an
existing charge is structurally trivial; substrate code is uniform
across layers. The cost — one extra writ per cartograph node and three
new writ types — is bounded; survey writs reach terminal phase quickly.

### 3.3 Survey writs carry the rig's notes in `writ.body`

| Pattern | `writ.body` is... | Set when |
|---|---|---|
| Mandate | the brief (instructions to the rig) | creation |
| Vision/charge/piece | the canonical content (prose, the thing itself) | creation/apply |
| Survey writ | the rig's notes (canonical content of the act of surveying) | rig completion |

The survey writ IS the act of surveying. Its content IS the
surveyor's notes — the reasoning trace, the considered alternatives,
the rationale for the structural decisions made. Body is empty
pre-completion; the rig fills it on completion.

### 3.4 Survey-writ envelope lives on plugin-keyed slots

The survey writ carries the substrate's published metadata through two
sanctioned plugin-keyed slots on the writ row, both written
exclusively through the Clerk's `setWritExt` / `setWritStatus` APIs so
sibling sub-slots are preserved under concurrent writers:

- **`writ.status['surveyor']`** — observation slot. The substrate
  stamps this slot when the survey terminates: it carries the survey
  outcome, the writ-completion observations the surveyor recorded, and
  any per-rig observation summary. Outcomes are surveyor-private; the
  consumer reads them post-hoc.
- **`writ.ext['surveyor']`** — metadata slot. On survey writs, carries
  registration-time provenance the substrate needs the writ to *bear*
  rather than have *observed about it*: `rigVersion` (the rig's semver
  pin at the moment the survey was queued) and `surveyorId` (the
  substrate-instance id for traceability across multi-substrate
  deployments). On cartograph writs, the same slot carries patron- /
  rig-supplied priority hints (severity, deadline, decay, complexity)
  per §3.10.

Three earlier-spec fields are dropped because they duplicate fields
the Clerk already carries:

- `targetNodeId` — replaced by `writ.parentId`. The survey writ's
  parent edge already names the writ being surveyed; a parallel
  metadata field is a coordination liability.
- `rigName` — replaced by `writ.type`. The substrate registers one
  writ type per rig, so the type *is* the rig name; carrying both lets
  them drift.
- `completedAt` — replaced by `writ.resolvedAt`. The Clerk stamps
  `resolvedAt` automatically on every terminal phase transition, and
  the surveyor's terminal transition is the only path that produces a
  completed survey.

The substrate is the only writer to either sub-slot. Other plugins
that need to read survey provenance or outcome traverse the slot
contract documented on `ClerkApi.setWritStatus` /
`ClerkApi.setWritExt` respectively.

### 3.5 Immutability and supersedes

Charges and pieces are rig-produced and never edited in place. When a
vision change cascades down such that an existing charge needs to
change, the rig creates a new charge with a `supersedes:
<oldChargeId>` link. The old charge stays in the books with its
content intact, marked superseded.

| Substrate codifies | Surveyor implementation decides |
|---|---|
| `supersedes` link kind exists and is queryable | Whether to supersede vs keep |
| `cartograph.createCharge({ ..., supersedes })` API supports the link atomically | What threshold of vision-change triggers supersede |
| Re-survey rigs receive existing children as input context | How aggressive to be (rewrite vs conserve) |
| Superseded charges remain queryable; their dispatched work continues | Whether superseding cascades to children — substrate default: no auto-cascade |
| The survey writ records the rig's decision in its notes | Stop conditions, reasoning approach |

Pieces follow the same mechanism. Mandates stay where they are.

### 3.6 Substrate watches the writs book — single-event-per-apply guarantee

The substrate maintains a single CDC subscription against the
Clerk-owned writs book and filters in the handler by writ type:

```ts
stacks.watch<WritDoc>('clerk', 'writs', (event) => {
  if (!isSurveyableType(event.entry.type)) return;
  // ...substrate handler...
}, { failOnError: false });
```

Where `isSurveyableType` returns true for `vision`, `charge`, `piece`
(every cartograph-owned writ type) plus any other rig-registered type
the substrate is configured to survey. The handler runs at Phase 2
(post-commit, after `coalesceEvents`) so the CDC stream the substrate
observes carries one event per logical change rather than one event
per intermediate write.

This replaces the three per-book subscriptions an earlier draft
specified — `book.cartograph.visions.{created,updated}`,
`book.cartograph.charges.{created,updated}`, and
`book.cartograph.pieces.{created,updated}` — none of which exist
post-cleanup because the cartograph contributes no books. The single
writs-book subscription is functionally equivalent and trivially
extensible to additional writ types as more rigs come online.

On a matching event the handler reads `ext['surveyor']` hints from
the affected node, creates the appropriate survey writ with
`parentId` pointing to the node, derives `ext['reckoner']` priority
dimensions from the hints + substrate defaults, and stamps to enter
the petition queue.

**Single-event-per-apply guarantee.** The cartograph's `createX` /
`transitionX` primitives are already transactional. `createX` opens
one `stacks.transaction(...)` that wraps the writ-row put and the
`setWritExt('cartograph')` stamp, so the substrate sees one coalesced
`create` event with the final state. `transitionX` wraps
`clerk.transition` + `setWritExt('cartograph')` and yields one
coalesced `update` event. Patron-driven flows (e.g. `vision-apply`)
that compose multiple typed-API calls under one outer
`stacks.transaction` produce one coalesced event per apply for the
same reason.

Without this discipline, a single `nsg vision apply` would produce
two CDC fires (create + transition-to-active) and the substrate
would create two identical survey writs — wasted Reckoner cycles and
duplicate rig dispatches. The cartograph's transactional primitives
are the load-bearing mechanism that prevents this.

### 3.7 Substrate + extension + default plugin shape

Three plugins, mirroring the Reckoner pattern:

1. **`@shardworks/cartograph-apparatus`** *(shipped)* — pure data layer.
   Vision/charge/piece writ types + `ext['cartograph']` slot
   (`{ stage, codex }`) + ladder-invariant API. Contributes no books;
   per-writ stage and codex live on the writ row via the Clerk's
   `setWritExt`. Does not own surveying.

2. **`@shardworks/surveyor-apparatus`** *(substrate)*
   - Owns survey writ types (`survey-vision`/`survey-charge`/
     `survey-piece`) and the surveyor scheduler / tick loop / per-rig
     surveyor registry.
   - Owns the `status['surveyor']` slot on every survey writ. Stamped
     on completion via `ClerkApi.setWritStatus(writId, 'surveyor', ...)`;
     carries the survey outcome and per-completion observations.
   - Owns the `ext['surveyor']` slot. On survey writs, stamped at
     registration via `ClerkApi.setWritExt(writId, 'surveyor', ...)`
     and carries the registration-time provenance fields described in
     §3.4. On cartograph writs, the same slot carries patron- /
     rig-supplied priority hints per §3.10.
   - Owns the CDC observer (single subscription on `('clerk', 'writs')`
     filtered by writ type — see §3.6).
   - Owns the rig-name convention (`survey-vision`/`survey-charge`/
     `survey-piece`).
   - Routes accepted survey petitions to the registered surveyor's
     rig templates.
   - Stamps `status['surveyor']` on completion (rig fills `writ.body`;
     substrate wraps the writ via `setWritStatus`).
   - Provides the surveyor anima tool surface (see §3.9).
   - Owns the substrate-internal records book if any (e.g. surveyor
     backoff, per-rig health metrics) — implementation detail, not
     part of the cross-plugin contract.
   - Does NOT contribute a `books.surveys` book — survey metadata that
     would otherwise live on a `SurveyDoc` row lives on the two
     ext/status sub-slots described above, both of which are carried
     by the writ row itself.
   - Does NOT ship a concrete surveyor.

3. **`@shardworks/scaffold-surveyor`** *(default)*
   - Registers a surveyor with the substrate via kit contribution
   - Provides minimal LLM-driven rig templates for each cartograph
     layer
   - Useful immediately; designed to be replaced as approaches are
     iterated

### 3.8 Spider's dispatchable type set extends

Spider's dispatchable type set grows to include survey writ types in
addition to mandates. Existing dispatch mechanics compose unchanged —
Spider already knows how to read writ type and resolve a rig
template; the extension is the registry the substrate provides for
discovering the registered surveyor's templates dynamically.

### 3.9 Tool surface for surveyor anima — atomic create-with-hints

Anima rigs need atomic operations that bundle the cartograph create
call, the `ext['surveyor']` stamping, and any `supersedes` link in
one tool call wrapped in a Stacks transaction. The surveyor-apparatus
contributes these tools.

#### Tools (callableBy: `['surveyor']`)

```
surveyor.create_charge / create_charges       # for survey-vision rigs
surveyor.create_piece  / create_pieces        # for survey-charge / -piece rigs
surveyor.create_mandate / create_mandates     # for survey-charge / -piece rigs
```

Each rig template's tool catalogue includes only the layer-relevant
subset.

**Single-create shape (charge example):**

```typescript
interface CreateChargeArgs {
  parentId: string;              // vision id
  title: string;
  body: string;
  codex?: string;
  hints?: SurveyorExt;           // { severity, deadline, decay, complexity }
  supersedes?: string;           // optional — if replacing an existing charge
}
```

Internally wraps a single `stacks.transaction`:
1. `cartograph.createCharge` (typed API)
2. `clerk.setWritExt('surveyor', hints)` if hints present
3. `clerk.linkWrits(newId, supersedes, 'supersedes')` if supersedes present

**Batch-create shape:**

```typescript
interface CreateChargesArgs {
  parentId: string;              // common parent — all in one batch share it
  charges: Array<{
    title: string;
    body: string;
    codex?: string;
    hints?: SurveyorExt;
    supersedes?: string;
  }>;
}
```

Common parent enforced per batch: all children in one batch are
siblings under a single parent. Matches how surveys actually
decompose.

**Mandate-create shape — direct ext.reckoner stamping:**

```typescript
interface CreateMandateArgs {
  parentId: string;              // charge or piece
  title: string;
  body: string;                  // the brief content
  codex?: string;
  reckonerHints?: ReckonerExtRequest;  // priority dimensions for Reckoner gating
}
```

Mandates aren't surveyed, so they skip `ext['surveyor']`. The tool
calls `reckoner.petition(writId, ext)` (stamp-only form) directly.

#### Read tools

The cartograph's existing `show`/`list` tools serve surveyor anima
needs; the only change is widening `callableBy` to include
`'surveyor'`.

### 3.10 Priority signals — substrate defaults + patron flags + rig hints

Priority dimensions for survey petitions are layered:

```
substrate defaults  ◄──  rig hints (ext['surveyor'])  ◄──  patron CLI flags
       (vision-apply only; merges into ext['surveyor'])
```

For visions, the patron sets priority via `nsg vision apply` CLI
flags (or sidecar fields). For charges and pieces, the surveyor rig
that creates the new node sets `ext['surveyor']` hints during
creation — the rig has the most context about this particular
charge/piece's importance. The substrate reads `ext['surveyor']` when
emitting each layer's survey petition.

#### Patron CLI surface

```
nsg vision apply <slug>
   [--severity moderate|serious|critical]    # default: moderate
   [--deadline <ISO-date>]                   # default: none
   [--decay]                                  # default: false
```

#### Substrate dimension defaults (when hints absent)

| Dimension | Default | Patron-overridable? | Rig-overridable? |
|---|---|---|---|
| `visionRelation` | `vision-advancer` for fresh; `vision-violator` for re-survey detecting contradiction | No | Yes (rig assesses on re-survey) |
| `severity` | `moderate` | Yes (CLI flag) | Yes (`ext['surveyor'].severity`) |
| `scope` | layer-based: vision=`major-area`, charge=`minor-area`, piece=`minor-area` | No | No (substrate-derived from layer) |
| `time.decay` | `false` | Yes (CLI flag) | Yes (`ext['surveyor'].decay`) |
| `time.deadline` | `null` | Yes (CLI flag) | Yes (`ext['surveyor'].deadline`) |
| `domain` | `[]` | No | No |
| `complexity` | unset (omitted from petition when hints absent) | No | Yes (`ext['surveyor'].complexity`) |

#### `ext['surveyor']` shape

```typescript
interface SurveyorExt {
  severity?: 'moderate' | 'serious' | 'critical';
  deadline?: string;       // ISO date
  decay?: boolean;
  complexity?: 'mechanical' | 'bounded' | 'exploratory' | 'open-ended';
}
```

Substrate-owned plugin-keyed slot on `writ.ext`. The vision-apply
CLI writes this for visions; surveyor rigs write this for charges
and pieces when they create the new cartograph node.

---

## 4. Worked example — cake-bakery vision through to mandates

A concrete walk-through of the cascade.

### Phase 1 — Patron creates the vision

Patron creates the file tree:

```
<GUILD>/vision/cake-bakery/
  vision.md
  vision-metadata.yml
```

`vision.md`:
```markdown
# Cake Bakery

A small online storefront for our bakery. Customers should be able to
browse our cakes, place orders for pickup or delivery, pay via Stripe,
and track their order status. Internal staff need to see the queue of
pending orders.

The launch deadline is 2026-06-15 — we have a partner doing a press
release that day.
```

`vision-metadata.yml`:
```yaml
stage: active
codex: bakery-app
```

Patron runs:
```
nsg vision apply cake-bakery --severity serious --deadline 2026-06-15
```

The CLI:
- Reads sidecar — no `visionId` → first apply
- Calls `cartograph.createVision({ title: 'Cake Bakery', body: <vision.md content>, codex: 'bakery-app', stage: 'active' })` — single transaction lands writ + doc + active stage
- Receives `vis-1`
- Writes `ext['surveyor']` on `vis-1`:
  ```json
  { "severity": "serious", "deadline": "2026-06-15", "decay": false }
  ```
- Writes `visionId: vis-1` back into the sidecar

State after Phase 1:
- `vis-1` writ exists, `phase: open`, `stage: active`
- `vis-1.body` carries the vision prose
- `vis-1.ext.surveyor = { severity: 'serious', deadline: '2026-06-15' }`
- Sidecar has `visionId: vis-1`

### Phase 2 — Surveyor-apparatus emits the initial petition

CDC fires once (per the single-event-per-apply guarantee). The
surveyor-apparatus observer wakes:

- Reads `vis-1`'s current state and `ext['surveyor']`
- Creates `surv-1` (a `survey-vision` writ):
  - `parentId: vis-1`
  - `body: ''` (rig will fill on completion)
  - `phase: new`
- Stamps `ext['reckoner']` derived from hints + defaults:
  ```json
  {
    "source": "scaffold-surveyor.survey-vision",
    "priority": {
      "visionRelation": "vision-advancer",
      "severity": "serious",
      "scope": "major-area",
      "time": { "decay": false, "deadline": "2026-06-15" },
      "domain": []
    }
  }
  ```

### Phase 3 — Reckoner accepts; Spider dispatches; rig surveys vision

Next Reckoner tick:
- Picks up `surv-1`
- Default scheduler: always-approve
- Transitions `surv-1` to `phase: open`

Spider's next pass:
- Sees `surv-1`: type `survey-vision`, phase `open`, no rig yet
- Resolves rig template via the surveyor registry → scaffold-surveyor's
  `survey-vision` template
- Dispatches; Animator launches an anima session

The rig:
- Reads `vis-1.body` (the vision prose)
- Reads `vis-1`'s existing children (none — first survey)
- Reasons about decomposition. Cake-bakery falls along customer-journey
  lines: Browse + order, Payment, Fulfillment, Internal staff queue.
- Calls `surveyor.create_charges` with four charges (single batch, single
  transaction):

  ```
  ch-1  Browse + order placement   hints: { severity: 'serious' }
  ch-2  Payment processing         hints: { severity: 'serious', deadline: '2026-06-15' }
  ch-3  Order status / fulfillment hints: { severity: 'moderate' }
  ch-4  Internal staff queue       hints: { severity: 'moderate' }
  ```

- Writes notes into `surv-1.body`:
  ```markdown
  # Survey of cake-bakery vision (vis-1)

  Decomposed along customer-journey + internal-tooling axes — chose
  this over technical layers (frontend/backend/db) because the vision
  emphasizes observable outcomes per actor, not architecture.

  Charges created:
  - ch-1: Browse + order placement (severity: serious — foundational)
  - ch-2: Payment processing (severity: serious; deadline inherited
          from vision)
  - ch-3: Order status / fulfillment (severity: moderate — depends on
          ch-1 + ch-2 being live before fulfillment can be exercised)
  - ch-4: Internal staff queue view (severity: moderate)

  Considered axes rejected: technical-layer decomposition (would split
  observable outcomes across charges); per-feature (too granular for
  charge layer — those become pieces).
  ```

- Completes `surv-1`

State after Phase 3:
- `surv-1` terminal, body holds reasoning trace
- `ch-1`–`ch-4` exist as cartograph charges
- Each has `ext['surveyor']` priority hints

### Phase 4 — Cascade to charge layer

CDC fires four times (one per new charge). Substrate observer creates
four survey-charge writs (`surv-2`–`surv-5`). Reckoner accepts in
priority order.

For `ch-2` (Payment processing), the rig creates pieces:
```
pc-1  Stripe SDK integration       hints: { severity: 'serious' }
pc-2  Refund handling              hints: { severity: 'moderate' }
pc-3  Receipt + confirmation emails hints: { severity: 'moderate' }
```

For `ch-1` (Browse + order placement), the rig might decide it's
already concrete enough and create mandates directly via
`surveyor.create_mandates`.

### Phase 5 — Cascade to piece layer

For each piece created in Phase 4, CDC fires → substrate creates
survey-piece writ → Reckoner gates → Spider dispatches surveyor rig.

For `pc-1` (Stripe SDK integration), the rig creates mandates:
```
m-1  Install + configure stripe SDK
m-2  Create /api/checkout endpoint
m-3  Create /api/webhooks/stripe endpoint
m-4  Add Stripe key management to env config
```

Each mandate has full brief content written by the rig (the rig is
assembling the brief at this layer; it has the context to do so).
Mandate priorities are stamped via direct `ext['reckoner']` (no
surveying-of-mandates).

### Phase 6 — Mandates execute

Each mandate runs through the existing implementer pipeline unchanged:
Reckoner accepts based on scheduler + capacity → Spider dispatches
implementer rig → rig writes code, commits, seals, pushes.

### Phase 7 — Patron walkthrough at the charge layer

As a charge's children all complete, the patron walks through it. The
charge is the patron-contract boundary — the unit of validation. The
walkthrough surface itself is a separate design problem (see Open
Questions §5.5).

### Phase 8 — Vision completion

When all charges are validated, the patron transitions the vision
to its terminal state. Auto-completion is not provided.

### What got persisted across the whole flow

- 1 vision writ, updated multiple times across stage transitions
- ~5 survey writs, each terminal with notes preserved
- 4 charges + ~7 pieces (estimate) + ~25 mandates (estimate)
- Each survey writ's `body` is a readable record of the rig's
  reasoning at that layer
- Each cartograph node's `ext['surveyor']` records its priority intent
- The full cascade is queryable via `parentId` walks

---

## 5. Open design questions

The architecture above is settled. These remain open and are tracked
as design clicks in the sanctum.

### 5.1 Stage gating on visions

Should drafts trigger surveys? v0 lean: every apply triggers
surveying; draft-without-surveying layers on later if it becomes a
real workflow need.

### 5.2 Dynamic rig template registration

Spider currently resolves rigs via static `rigTemplateMappings` keyed
by writ type. Surveyor implementations need to register rig templates
at plugin load time. Strongest fit: dynamic kit-contribution
registration matching the Reckoner-scheduler pattern. Prerequisite:
audit Spider's current rig-resolution mechanism for discrimination
across writ "kinds" (implementer/spec/reviewer/surveyor).

### 5.3 One survey writ type vs three

**Resolved.** Three types (`survey-vision`, `survey-charge`,
`survey-piece`) — matches cartograph's per-layer types; Spider's
static-config dispatch is direct. Each type is a six-state
mandate-clone registered by `@shardworks/surveyor-apparatus`.

### 5.4 Default scaffold-surveyor design

What does the default surveyor actually do? Open: model selection,
prompt structure, stop conditions (skip pieces and emit mandates
directly?), how the rig decides priority hints, re-survey behavior
(diff against prior surveys?).

### 5.5 Mandate creation by surveyor rigs — priority discipline

Surveyor rigs stamp `ext['reckoner']` directly when creating mandates.
There's no constraint mechanism — rigs could over-claim priority
(everything `serious`). Operational tuning rather than substrate
mechanism for v0; revisit if observed drift.

### 5.6 Substrate scope detail

Where exactly does the substrate / surveyor-implementation boundary
fall for ergonomic concerns (priority defaults, source-id grammar,
role-file convention, etc.)?

### 5.7 Plural surveyors — future

When multiple surveyor implementations are registered, how does the
substrate select? Per-vision config? Per-cartograph-tree?
Round-robin? Default-with-override? Not for v0 — only one surveyor
registered.

### 5.8 Cascading supersedes — children of superseded nodes

**Resolved.** Substrate default: no cascade. Superseded charges'
pieces stay attached to the superseded parent. The
`surveyor.supersedes` link kind is registered by the substrate; the
surveyor anima tools author the link when a `supersedes` argument is
passed. A "soft cancel" CLI surface (`nsg charge cancel ch-3
--cascade`) deferred to v0+1.

### 5.9 Vision completion criteria

When does a vision complete? Some-validated-some-dropped, all
validated, patron-explicit? v0 lean: completion is purely a patron
action via `nsg vision transition`; no auto-completion.

### 5.10 Survey rig failure handling

**Resolved.** Spider's existing retry semantics apply uniformly
across dispatchable types — confirmed during the substrate
commission audit. Survey writs use the same `failOnError: false`
CDC watcher path as mandates; Spider treats `survey-*` writ types
as first-class dispatchable types.

### 5.11 Patron walkthrough CLI surface

The patron-contract validation step at the charge layer is undesigned
in this document. Walkthrough is a substantial design problem — how
delivered work is presented, what the validation interaction looks
like, how feedback feeds back into the vision file. Surfaced as a
known gap, not blocking the cascade.

### 5.12 Per-charge priority nudge

Patron sets `--severity` at vision-apply time. No per-charge nudge
CLI. Future surface: `nsg charge nudge ch-2 --severity serious`.

### 5.13 Sidecar file organization

The sidecar mixes system-managed (`visionId`) and patron-managed
(`stage`, `codex`, priority hints) fields. v0 lean: keep merged;
document `visionId` as system-managed. Cleanup option later: split
into hidden system file + patron metadata file.

### 5.14 Zero-children survey rig behavior

**Resolved.** Zero-children is a valid outcome with no special
substrate handling. The survey writ terminates with notes only;
`status['surveyor']` is stamped with `childCount: 0`. The
cartograph node sits without further decomposition. Dashboard
surfacing deferred.

### 5.15 Re-survey upstream-cascade behavior

If the patron edits the vision in a way that changes the meaning of
existing charges *but doesn't change the charges' content* (the
upstream survey rig didn't supersede them), the children of those
charges don't get re-surveyed — the substrate's observer only fires
on changes to the *node being decomposed*, not upstream of it.

This is structurally correct (immutability) but may surprise patrons.
Real remediation: the patron edits the vision in a way that forces
the upstream rig to supersede the charge.

---

## Related documents

- [Reckoner Contract](petitioner-registration.md) — how
  `ext['reckoner']` works, how the Reckoner gates petitions, the
  scheduler kit-contribution surface.
- [Reckonings Book](reckonings-book.md) — Reckoner's evaluation log.
- [Cartograph plugin README](../../packages/plugins/cartograph/README.md)
  — vision/charge/piece writ types, the `ext['cartograph']` slot, the
  CartographApi.
- [Guild Metaphor](../guild-metaphor.md) — vocabulary including the
  Surveyor's role.
