# Reckoner Contract — Held Writs and Dimension-Driven Scheduling

Status: **Draft**

> **⚠️ v0 scope.** This document fixes the contract between the
> (forthcoming) petition-scheduler Reckoner and the rest of the
> framework. v0 covers: the petition data shape (priority
> dimensions, complexity, payload, labels), the kit-static
> petitioner registry, the convention for opting a writ into
> Reckoner gating (`writ.ext['reckoner']`), the Reckoner's
> behavioral contract, the optional `reckoner.petition()` helper,
> the `enforceRegistration` and `disabledSources` config keys, the
> Reckonings evaluation log, and the trust model. The Reckoner's
> combination function (how dimensions become scheduling weight),
> the Reckonings book schema beyond the evaluation-log shape, the
> patron-emit surface (CLI / MCP), and any non-`vision-keeper`
> petitioner are explicitly out of scope.

> **Design framing.** A petition is not a separate entity from a
> writ — it is a writ in `new` phase carrying `ext['reckoner']`.
> The Reckoner is one authority among several that can transition
> writs from `new` to an active phase. This composes existing
> framework primitives (the `new` holding phase, plugin-keyed
> extension slots, CDC + standing orders) rather than introducing
> a parallel record type.

---

## Dependencies

```
contract spans: ['clerk', 'spider', 'stacks', 'clockworks']
```

- **The [Clerk](apparatus/clerk.md)** — the writ tracker. Held
  writs in `new` phase are normal Clerk writs; the Reckoner uses
  Clerk's transition API to approve or decline them. Clerk knows
  nothing about the Reckoner; the dependency is one-way.
- **The [Spider](apparatus/spider.md)** — the dispatcher. Spider
  doesn't dispatch writs in `new` phase. Once the Reckoner
  transitions a writ to `open` (or the type-equivalent active
  state), Spider picks it up and dispatches via the writ type's
  rig template.
- **[Stacks](apparatus/stacks.md)** — the storage substrate. The
  Reckoner watches CDC events on the writs book to find writs
  needing consideration.
- **[Clockworks](clockworks.md)** — the event substrate. The auto-
  wired `book.clerk.writs.{created,updated}` events feed the
  Reckoner's CDC handler.

---

## 1. The mechanism

### Posting a Reckoner-gated writ (Workflow 1 — direct)

A petitioner posts a writ in the standard way, with one addition:
the writ carries `writ.ext['reckoner']` with at minimum `source`
and `priority`. That ext is the signal to the Reckoner that this
writ requires its consideration.

```typescript
await clerk.post({
  type:     'mandate',
  title:    'Address vision drift detected at 04:00 UTC',
  body:     '...',
  codex:    'nexus',
  parentId: 'w-...',
  ext: {
    reckoner: {
      source:    'vision-keeper.snapshot',
      priority: {
        visionRelation: 'vision-violator',
        severity:       'serious',
        scope:          'major-area',
        time:           { decay: true, deadline: null },
        domain:         ['quality'],
      },
      complexity: 'bounded',
      payload:    { /* opaque petitioner-defined data */ },
    },
  },
});
```

The writ exists in `new` phase (Clerk's default for new writs).
Spider doesn't dispatch from `new`. The Reckoner observes CDC,
sees `writ.ext['reckoner']`, validates the source against its
registry (see §5), and adopts responsibility for transitioning
the writ.

This workflow is always available — any apparatus that can call
`clerk.post()` (which is to say, any loaded apparatus) can post a
Reckoner-gated writ this way. No runtime dependency on the
Reckoner API.

### `reckoner.petition()` helper (Workflow 2 — canonical)

For petitioner ergonomics, the Reckoner exposes a thin wrapper
that constructs the writ in the correct shape:

```typescript
interface ReckonerApi {
  /**
   * Post a writ in `new` phase with Reckoner ext set correctly.
   * Validates dimension values against the schema, applies
   * defaults for omitted dimensions, validates source against
   * the registry, and calls clerk.post() under the hood.
   *
   * Equivalent in effect to calling clerk.post() with manual ext
   * construction (Workflow 1); this helper exists for type
   * checking, default handling, and discoverability.
   */
  petition(request: PetitionRequest): Promise<WritDoc>;

  /**
   * Withdraw a held writ by transitioning it to cancelled.
   * Convenience wrapper around clerk.transition(); identical
   * effect to calling Clerk directly.
   */
  withdraw(writId: string, reason?: string): Promise<WritDoc>;
}

interface PetitionRequest {
  // writ fields (passed through to clerk.post)
  type:      string;
  title:     string;
  body:      string;
  codex:     string;
  parentId?: string;

  // ext.reckoner fields
  source:      string;                          // required, registered
  priority:    Priority;                        // see §3
  complexity?: ComplexityTier;                  // see §4
  payload?:    unknown;                         // opaque
  labels?:     Record<string, string>;          // additive metadata
}
```

The helper is the **canonical** path for ergonomic petitioner
code: a single call, type-checked dimensions, defaults applied,
registry validated at API-call time. Petitioners that prefer
direct posting (Workflow 1) get identical Reckoner behavior; the
helper is a convenience layer, not a gate.

A **stamp-only form** of `petition()` (`reckoner.petition(writId,
extRequest)`) supports the *draft-then-publish* idiom: the
petitioner posts the writ in its initial phase first, wires
`clerk.link(...)` dependencies (or any other writ-graph prep), and
then stamps `ext['reckoner']` to publish. The stamp-only form runs
the same source-registry check, priority validation, and partial-
priority default-fill as the create+stamp form (a single canonical
validation path), and adds writ-state guards: the writ must exist,
must be in its writ-type's initial phase, and must not already
carry `ext['reckoner']`. Each guard fails loud with no writ
mutation. When wrapped in `stacks.transaction(...)`, the inner
`setWritExt` joins the outer transaction via Stacks AsyncLocalStorage
composition, so the writ becomes Reckoner-visible only after the
outer commit. See [apparatus/reckoner.md](apparatus/reckoner.md)
for the full helper signature and the guard order.

### Reckoner behavior

The Reckoner subscribes to the auto-wired `book.clerk.writs`
events. For each writ event, it inspects the writ:

1. If the writ is **not** in `new` phase, ignore.
2. If the writ does **not** have `ext['reckoner']`, ignore — this
   is not a Reckoner-gated writ; some other authority owns the
   transition.
3. **Source check.** If the writ's `ext['reckoner'].source` is
   **not** registered (see §5):
   - When `enforceRegistration` is true: decline the writ,
     transitioning `new` → `cancelled` with a reason naming the
     unknown source.
   - When `enforceRegistration` is false (default): log a warning
     and proceed.
4. **Per-source ops controls.** If the source is in
   `disabledSources` (§6), the Reckoner **skips** the writ —
   leaves it in `new` phase, takes no action, does not write a
   reckoning entry. The writ remains eligible for consideration
   again if the source is later removed from `disabledSources`.
5. Otherwise the writ is a held petition. The Reckoner evaluates
   its priority dimensions and complexity against current state
   and decides:
   - **Approve** → transition `new` → `open` (or the type's
     equivalent active state). Spider then picks up.
   - **Defer (dependency-aware)** → leave in `new`. Append a
     `deferred` Reckonings row carrying `deferReason:
     'dependency_pending'` (one or more outbound `depends-on`
     targets are still non-terminal) or `deferReason:
     'dependency_failed'` (failed-precedence: at least one target
     reached a non-cleared terminal state). The dep gate runs
     ahead of the scheduler and re-evaluates on every Reckoner
     tick — a deferred dependent releases naturally as its
     dependencies clear, with no-op-row suppression keeping the
     journal lean. The classifier reads the target's writ-type
     config attrs (cleared = terminal + success-or-cancelled);
     cancelled deps are success-equivalent in v0.
   - **Defer (scheduler-emitted)** → leave in `new`, no row. The
     scheduler-emitted defer outcome is row-less in v0; richer
     scheduling-policy deferrals are reserved for future
     commissions.
   - **Decline** → transition `new` → `cancelled`. The decline
     reason is stamped on the writ via the resolution field.

The Reckoner is one authority among several that can transition
writs out of `new`. Patron manual transitions, planner-driven
automatic transitions, and any other authorities continue to
operate on writs without Reckoner ext.

### Withdrawal

The petitioner withdraws a held writ by transitioning it to
`cancelled` via Clerk's standard transition API:

```typescript
await clerk.transition(writId, 'cancelled', {
  reason: 'Snapshot superseded by drift detected before this ran.',
});
```

The Reckoner's `withdraw(writId, reason?)` helper is a thin
wrapper around the same call.

If withdrawal lands while the writ is still in `new` (the common
case), the Reckoner's CDC handler stops considering it. If
withdrawal lands after approval (writ already in `open` or
further), it follows the normal lifecycle for cancelling
in-flight work — same as any other writ being cancelled mid-
execution. No special Reckoner logic required.

### After approval

Once approved, the writ is a normal active writ. Spider
dispatches; the appropriate rig runs; engines do the work;
lifecycle proceeds normally. The Reckoner's involvement ends at
approval.

The data the petitioner attached in `writ.ext['reckoner'].payload`
is available to the running engine via standard writ access — the
engine reads it if it cares. Most rigs won't.

For animas working the writ, no special tools are needed —
everything they need is on the writ. If structured payload
inspection becomes common, the Reckoner can ship a small read-
tool that pretty-prints `writ.ext['reckoner']`, but it's not
required for correctness.

---

## 2. The petition shape

The full `writ.ext['reckoner']` shape:

```typescript
interface ReckonerExt {
  /**
   * Required. Identifies the petitioner. Must match a registered
   * petitioner descriptor (see §5) when enforceRegistration is on.
   */
  source: string;

  /**
   * Required. Multi-dimensional priority. See §3.
   */
  priority: Priority;

  /**
   * Optional petitioner-side coarse cost estimate. Refined by the
   * Astrolabe at plan time. See §4.
   */
  complexity?: ComplexityTier;

  /**
   * Opaque petitioner-defined structured data. The Reckoner
   * stores it but does not introspect; the rig's implementation
   * engine reads it if needed.
   */
  payload?: unknown;

  /**
   * Additive non-priority metadata. Multi-instance discrimination
   * (e.g. `'vision-keeper.io/vision-id': 'nexus'`),
   * observability hints, diagnostic tags.
   */
  labels?: Record<string, string>;
}
```

The split between `priority` (how much does this matter?) and
`complexity` (what does it cost?) is intentional — these are
conceptually distinct axes that the Reckoner consumes for
different purposes.

---

## 3. Priority dimensions

The `priority` field is a structured object across five
dimensions. Designed to be **inspectable and defensible** rather
than mechanically objective — petitioners declare honest inputs,
the Reckoner does judgment-laden contextual collapse. The shared
vocabulary makes disagreements visible and resolvable in review.

```typescript
type Priority = {
  visionRelation:
    | 'vision-blocker'
    | 'vision-violator'
    | 'vision-advancer'
    | 'vision-neutral';
  severity:
    | 'critical' | 'serious' | 'moderate' | 'minor';
  scope:
    | 'whole-product' | 'major-area' | 'minor-area';
  time: {
    decay:    boolean;
    deadline: string | null;        // ISO date
  };
  domain: Array<
    | 'security' | 'compliance' | 'cost' | 'feature' | 'quality'
    | 'infrastructure' | 'documentation' | 'research' | 'ergonomics'
  >;
};
```

(Note: `complexity` is a peer field on `ext.reckoner`, not part
of the `Priority` type, because it answers a different question
— cost rather than priority. See §4.)

### `visionRelation`

How does this petition relate to the product vision? Names a
**relationship type**, not a magnitude.

- `vision-blocker` — the vision is unreachable without this;
  future-blocking.
- `vision-violator` — the current product state actively diverges
  from the vision; present-tense degradation.
- `vision-advancer` — pushes toward an aspirational, not-yet-
  realized aspect of the vision.
- `vision-neutral` — doesn't touch the product vision;
  operational, hygiene, internal tooling, research instrumentation.

### `severity`

If this petition is not acted on, how bad is the situation? Pure
magnitude axis, independent of `visionRelation`.

- `critical` — production breakage, security incident,
  irreversible damage accruing, agents fully blocked.
- `serious` — significant ongoing degradation; daily workarounds.
- `moderate` — noticeable but tolerable.
- `minor` — easy to live with; cosmetic, convenience, polish.

For `vision-advancer` petitions, severity reads as the value /
eagerness of the advancement rather than damage from inaction.
Same scale orders correctly; interpretation shifts to fit the
relationship type.

### `scope`

What fraction of the system is affected?

- `whole-product` — every user / every commission / every guild.
- `major-area` — a major feature or subsystem.
- `minor-area` — a small slice, one workflow, one command.

### `time`

Two genuinely independent axes:

- `decay: true` — drift sentinels, security exposure,
  accumulating technical debt.
- `deadline: <iso-date>` — pledged demos, external commitments.
- both — common (e.g. "promised May 15, AND every day broken
  costs us users").
- neither — defer-friendly work.

### `domain`

Multi-valued tag set for orthogonal classification. **Not** a
priority axis — describes what *kind* of work this is.

Used by the Reckoner for filtering, patron-tunable weighting (e.g.
weight `security` higher than `cost`), and reporting.

### Defaults when omitted

```typescript
{
  visionRelation: 'vision-neutral',
  severity:       'minor',
  scope:          'minor-area',
  time:           { decay: false, deadline: null },
  domain:         [],
}
```

The `reckoner.petition()` helper applies these defaults; direct
`clerk.post()` callers (Workflow 1) are responsible for supplying
priority values, though omitted dimension fields fall back to
defaults at consideration time.

### Combination semantics

The Reckoner does **judgment-laden** collapse — these dimensions
are inputs to a contextual scheduling decision, not coordinates
in a priority space with a fixed lexicographic order. The
combination-function shape (rules / weighted sum / LLM scorer)
belongs to the Reckoner-core or Reckonings-book commission, not
to this contract.

For deterministic fallback ordering when the Reckoner isn't
running (manual triage, dry-run inspection), suggested
precedence:

1. `severity: 'critical'` ahead of everything.
2. `visionRelation: 'vision-blocker'` next.
3. Then anything with `time.decay: true` or imminent
   `time.deadline`.
4. Then by severity within remaining.
5. Ties broken by scope (broader first), then by `complexity`
   (smaller first — quick wins flush before slogs).

Suggestion only; the Reckoner is free to weigh differently and
patrons can tune.

### Deliberate omissions

- **Reversibility** — better captured at plan-review time than at
  petition-emit time.
- **Dependency / unblock-count** — graph property the Reckoner
  can compute from the writ tree, not something the petitioner
  self-claims.
- **A unified urgency scalar** — deliberately not added; the
  whole point is to avoid the lossy collapse of the original
  4-tier enum.

### No allow-list concept

There is no per-source priority allow-list. Petitioners declare
honest dimension values; mis-claiming is code-review-detectable,
parallel to the source-trust model in §7. Authority for the
patron-bridge or future security-emergency apparatuses emerges
from honestly-claimed dimensions, not from a privileged source
name or per-source priority allowance. The petitioner registry
(§5) controls *who can petition*, not *what priorities they can
claim*.

---

## 4. Complexity

Petitioner-side coarse estimate of expected agent token cost.
Refined by the Astrolabe at plan time; this exists only for
early-stage trade-offs before plans exist.

```typescript
type ComplexityTier =
  | 'mechanical'
  | 'bounded'
  | 'exploratory'
  | 'open-ended';
```

- `mechanical` — clear path, minimal exploration. Rename a field,
  add a known-shape method, regenerate from a template. Roughly
  ~50K–200K tokens.
- `bounded` — clear scope, some exploration. Add a feature whose
  shape is understood, fix a bug whose location is known,
  refactor within one subsystem. Roughly ~200K–1M tokens.
- `exploratory` — design judgment required; multiple viable
  paths; cross-cutting investigation. Roughly ~1M–5M tokens.
- `open-ended` — research, prototyping, or scope likely to grow
  under contact with reality. Multi-session work expected.
  ~5M+ tokens.
- omitted — petitioner has no basis to claim.

Token ranges are calibration hints, **not contractual**. They
will drift as agent capability changes; periodic re-tuning
against actual commission-log data is expected. Petitioners are
encouraged to omit rather than guess — omission is honest; a
wild guess is misleading.

The calibration feedback loop is tracked at `c-mohd0luw`.

### Why complexity is separate from priority

Priority (§3) answers "how much does this matter?" Complexity
answers "what does it cost?" Both feed scheduling, but they're
conceptually distinct — a critical-severity petition with
mechanical complexity is the kind of thing that should flush
quickly; a critical-severity petition with open-ended complexity
warrants more careful scheduling. Bundling them obscures the
distinction.

---

## 5. The petitioner registry

The Reckoner maintains a kit-static registry of petitioner
sources. Petitioners declare themselves via a `petitioners` kit
contribution:

```typescript
// In a plugin's kit (or apparatus's supportKit)
export default {
  kit: {
    requires: ['reckoner'],
    petitioners: [
      {
        source:      'vision-keeper.snapshot',
        description: 'Periodic vision-vs-reality snapshots ' +
                     'emitted when the keeper observes drift ' +
                     'worth surfacing.',
      },
    ],
  },
};

interface PetitionerDescriptor {
  source:      string;
  description: string;
}
```

Registration is **kit-static**: the Reckoner consumes the
`petitioners` contribution type at boot, builds the registry, and
seals it at `phase:started`. Per-plugin-load-cycle framing
applies (today equivalent to global seal; positions correctly for
future dynamic plugin loading).

### Registry purpose

The registry is **descriptive infrastructure**, not authority
gating:

- **Source validation.** Petitions whose `ext.reckoner.source` is
  unknown are caught (per §1's source check), with behavior
  governed by `enforceRegistration` config (§6).
- **Discoverability.** Operators / Oculus can enumerate all
  registered petitioner sources without aggregating from
  observed petitions.
- **Per-source ops controls.** Operators can disable specific
  sources via configuration (§6).
- **Per-source metrics.** The Reckoner can attribute petition
  rates, decline rates, and approval rates to named sources.
- **Per-source documentation.** The `description` field gives
  operators a one-liner about each source.

### Kit-vs-kit collision policy

Two `petitioners` entries with the same `source` string are a
**hard error**. The Reckoner refuses to start with a diagnostic
naming both contributing plugin ids and the conflicting source —
the winner is never selected by load order. Mirrors the
framework-wide collision rule applied to Clerk writ-types,
Spider rig-template-mappings, and the Fabricator's engines.

### Source-id grammar

A source id has the form **`{pluginId}.{kebab-suffix}`** — the
contributing plugin's derived id, a literal `.`, then a kebab-
case suffix (lowercase letters, digits, single-hyphen separators;
no leading or trailing hyphen). Matches Lattice trigger-types and
Clerk link-kinds. Examples:

- `vision-keeper.snapshot`
- `patron-bridge.commission`
- `tech-debt.detected`

Malformed source ids hard-fail at startup, never at first emit.

### Trust model applies independently

The registry does **not** strengthen the trust model. Sources are
still emitter-stamped (the petitioner names its own source on
each petition); the Reckoner trusts the stamp. The registry adds
a layer of "this stamp is recognized" but doesn't prevent
mis-stamping. See §7.

---

## 6. Configuration

The Reckoner reads its configuration from `guild.json` under the
`reckoner` key:

```json
{
  "reckoner": {
    "enforceRegistration": false,
    "disabledSources": []
  }
}
```

### `enforceRegistration` (boolean, default `false`)

Controls how the Reckoner handles petitions whose
`ext.reckoner.source` is not in the registry:

- `false` (default) — log a warning and proceed with normal
  consideration. Permissive: emergent petitioners that haven't
  been registered yet still get scheduled.
- `true` — decline the petition, transitioning the writ to
  `cancelled` with a reason naming the unknown source. Strict:
  guards against typos and abandoned sources at the cost of
  rejecting any petition that drifted from its declaration.

Default is permissive. The strict mode exists for production
guilds that want hard guarantees about which sources are
considered.

### `disabledSources` (string array, default `[]`)

Per-source disable list. Petitions from any source in this array
are **skipped** by the Reckoner — left in `new` phase
indefinitely. The Reckoner takes no action on them: no
transition, no reckoning entry. When the source is later removed
from `disabledSources`, the Reckoner picks up any pending writs
and resumes normal consideration.

Skipping (rather than declining) preserves work across temporary
disablings — the petitioner doesn't need to re-emit when the
source is re-enabled. Useful for operational scenarios:

- "Pause tech-debt petitions while we focus on a release."
- "This petitioner is misbehaving; disable until investigated."
- "We're over budget; disable all non-critical petitioners."

A future enhancement could expand this to per-source throttling
(rate limits) or conditional disabling (disable when X
condition); v0 is a simple skip list.

### Future config surface

This contract reserves the `reckoner` key in `guild.json` for
future configuration as the Reckoner-core scheduling logic lands
(combination-function tuning, capacity limits, etc.). v0
specifies only the two fields above.

---

## 7. Trust model

Petitioners post writs with their dimensions claimed honestly.
The Reckoner trusts the claims; mis-claiming is code-review-
detectable, parallel to the source-trust model in
[Lattice](apparatus/lattice.md).

The petitioner registry (§5) is a **descriptive layer**, not an
authority gate. A registered source that systematically over-
claims its priority dimensions can still get its petitions
approved at higher rates than it should — the registry doesn't
prevent that. Operators detect mis-claiming via the Reckonings
evaluation log (§8) and address it through code review or the
`disabledSources` config.

Authority for the patron-bridge or future security-emergency
apparatuses emerges from honestly-claimed dimensions (e.g.
`severity: 'critical', visionRelation: 'vision-violator',
domain: ['security']`), not from a privileged source name or
registry tier.

Mitigations against mis-claiming:

- **Code review** by humans and reviewing agents.
- **The evaluation log** makes mis-claiming visible
  retrospectively — weight applied vs outcome can be analyzed.
- **Future apparatuses** (audit, observability) can scan the log
  for systematic over-claiming and surface alerts.
- **Operational disabling** via `disabledSources` config when
  mis-claiming is identified.

### Why not handle-based or framework-mediated identity

Two alternatives were considered and rejected:

- **Handle-based authority** (closures stamp source). Rejected
  because the multi-dimensional priority schema eliminated per-
  source authority gates entirely — the handle's structural
  proof was over-engineering for a failure mode the contract no
  longer surfaces.
- **Framework-mediated identity** (caller pluginId stamped via
  AsyncLocalStorage proxy). Rejected because plugin authors
  routinely use raw timer / signal / HTTP / IO callbacks that
  drop ALS context (4+ current plugins). Framework-mediated
  identity would either fail-loud (breaking deferred work) or
  fail-silent (silent authority drift). The identity-proxy work
  continues as an independent track (`c-mofxdlwb`) but is not
  load-bearing for petitioner authority.

---

## 8. The Reckonings book

The Reckoner owns a `reckoner.reckonings` book — the evaluation
log. One record per consideration tick where the Reckoner takes a
non-skip action (approve, defer, decline, withdrawn-handling).
Skipped writs (`disabledSources` membership) do not produce
reckoning entries.

Each reckoning captures:

- writ id
- timestamp
- decision (`approve` | `defer` | `decline` | `unchanged` |
  `withdrawn`)
- reason (free-form string; defer/decline reasons follow
  conventions documented by the Reckonings-book commission)
- weighed priority at the tick (snapshot of dimensions and
  complexity at consideration time, useful when claims change
  between ticks)

The log is durable; current writ state is the materialized view
over accumulated reckonings + the writ's own Clerk lifecycle.

The exact record schema is owned by the parallel Reckonings-book
commission (`c-modeou1t`). This contract relies only on the
existence of an evaluation log; the precise field shapes will
track that commission's decisions.

---

## 9. Feedback receipt

A petitioner observes outcomes via standard CDC on the writs
book. The auto-wired `book.clerk.writs.updated` event delivers
all writ transitions. Three usage patterns:

### Channel 1 — event-driven standing order (the canonical path)

The petitioner declares a standing order keyed on writ-update
events, filtered to writs they posted (typically by source label
on the writ's ext, by the writ's parentId, or by other writ-
intrinsic attributes).

```jsonc
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "book.clerk.writs.updated",
        "run": "vision-keeper-on-decline",
        "with": {
          "filterExtSource": "vision-keeper.snapshot",
          "filterPhase":     "cancelled"
        }
      }
    ]
  }
}
```

The relay handler reads the post-commit event payload and reacts.
The Reckoner does not duplicate Clockworks's standing-order
substrate; the petitioner reuses the vocabulary they already
know.

(The exact filter shape — `filterExtSource`, etc. — depends on
Clockworks's filter capabilities, which are out of scope here.
Flagged in §15.)

### Channel 2 — polling

For periodic reconciliation or "what's outstanding?" snapshots:

```typescript
const stacks = guild().apparatus<StacksApi>('stacks');
const writs  = stacks.book<WritDoc>('clerk', 'writs');
const mine   = await writs.list({
  where: [
    ['phase', '=', 'new'],
    ['ext.reckoner.source', '=', 'vision-keeper.snapshot'],
  ],
});
```

(Exact filter syntax follows Stacks's query API.)

### Channel 3 — fire-and-forget

The petitioner emits and walks away. Re-emission is driven by
the petitioner's own conditions; the Reckoner's lifecycle
handles dedupe / supersede.

### Channel selection

Standing order for live reactions; polling for snapshots;
fire-and-forget for "I noticed *X*; route it" semantics.

---

## 10. Lifecycle hooks

**v0 declares no hooks.** A petitioner's full surface is the
`ext.reckoner` shape (§2) — no `onAccept`, no `canRetry`, no
`onDefer`, no callback that runs in the Reckoner's process before
a transition.

Reasoning: CDC + standing-order observation covers the need
without an invocation-ordering contract; pre-empting hooks would
introduce ordering questions the framework has no precedent to
lean on.

Adding a hook later is additive — the Reckoner's API can grow
without breaking v0 callers.

---

## 11. Built-in example: vision-keeper

The vision-keeper is the canonical worked example. It exercises
every contract surface in this doc:

- **Declares its source** in its kit:
  ```typescript
  petitioners: [{
    source:      'vision-keeper.snapshot',
    description: 'Vision-vs-reality snapshots emitted when the ' +
                 'keeper observes drift worth surfacing.',
  }]
  ```
- **Posts held writs** via `reckoner.petition(...)` (Workflow 2)
  when it observes drift or proposes elaboration.
- **Stamps source** on each petition (`source:
  'vision-keeper.snapshot'`).
- **Declares dimensions** matching the situation:
  `{ visionRelation: 'vision-violator', severity: 'serious',
     scope: 'major-area', time: { decay: true, deadline: null },
     domain: ['quality'] }`
  for drift-detected snapshots.
- **Includes complexity claim** when it has a basis (often
  `'bounded'` for known-shape drift remediations; omitted for
  open-ended elaborations).
- **Attaches payload** in `writ.ext['reckoner'].payload` so the
  rig that processes the resulting writ has the full snapshot
  available without joining to overlay books.
- **Uses labels** to discriminate per-vision instances when
  multiple visions are tracked:
  `labels: { 'vision-keeper.io/vision-id': 'nexus' }`.
- **Withdraws superseded petitions** via `reckoner.withdraw(writId,
  reason?)` (or `clerk.transition(writId, 'cancelled', ...)`).
- **Observes outcomes** through a Channel-1 standing order on
  the writs book filtered to its own source.

There is **no patron special-case** in this contract. The
patron's emit path (CLI surface, MCP tool, `commission-post`
interaction) is owned by a separate **patron-bridge** apparatus
that registers as a normal petitioner under
`patron-bridge.commission` (or whatever the bridge apparatus
chooses) and posts writs like any other petitioner. The patron's
authority emerges from the dimensions its petitions claim —
typically `severity: 'critical'` and concrete domain values that
combine into high scheduling weight — not from a privileged
source name.

---

## 12. Existing precedents

This contract composes existing framework primitives rather than
inventing new ones:

- **The `new` phase** — Clerk's existing pre-dispatch holding
  state. Writs in `new` don't dispatch until some authority
  transitions them. The Reckoner is one such authority.
- **CDC + standing orders** — Clockworks's existing event
  substrate. Reckoner watches writ-events; petitioners watch for
  outcome-events. No new event mechanism.
- **Per-plugin extension slots** — `writ.ext` parallels
  `writ.status` (the existing per-plugin slot). Both are
  `Record<PluginId, unknown>`; same write-mechanism (a per-plugin
  setter API), different semantics:
  - `status` = post-hoc plugin observations (Spider's dispatch
    state, Sentinel's cost notes).
  - `ext` = plugin-keyed metadata-shape data (Reckoner's source,
    priority, complexity, payload, labels; future provenance /
    classification / cross-reference data from other plugins).

The metadata-vs-status split mirrors Kubernetes' `metadata` /
`status` separation but specialized to our case (plugin-keyed
extension rather than K8s's labels + annotations + ownerReferences
amalgam).

- **Kit-static contribution registries** — `petitioners`
  contribution mirrors Clerk's writ-types, Spider's
  `rigTemplateMappings`, and the Fabricator's engine designs
  (kit declaration, duplicate-collision policy, seal at
  `phase:started`). Same shape, same conventions.

---

## 13. Required Clerk-side schema addition

This contract requires one Clerk schema change:

```typescript
// In WritDoc and CRUD APIs
interface WritDoc {
  // ... existing fields ...
  ext?: Record<string, unknown>;   // plugin-keyed metadata extension
}
```

Plus the symmetric API for plugin-scoped writes:

```typescript
interface ClerkApi {
  // ... existing methods ...

  /** Write to a plugin's ext sub-slot (parallel to setWritStatus). */
  setWritExt(writId: string, pluginId: string, value: unknown):
    Promise<WritDoc>;
}
```

The change is small and benefits the framework broadly, not just
this contract — any plugin wanting metadata-shape attachment to
writs (provenance, cross-references, classification tags) finds
a natural home here. Without it, plugins are forced to abuse the
`status` slot for non-status data.

The `ext` slot:
- Is opt-in per writ (absent by default).
- Has identical write-mechanism to `status` (per-plugin sub-slot,
  written via dedicated API).
- Survives terminal phase transitions (same as `status`).
- Is plugin-keyed (no global schema; each plugin owns its
  sub-slot).

---

## 14. Open Questions

### a. Reckonings book schema

- **Question.** What are the specific record fields and CDC
  payload shapes of the Reckonings book?
- **Trade-off.** Owned by the parallel Reckonings-book commission
  (`c-modeou1t`).
- **Re-evaluation trigger.** When that commission lands, this
  contract's §8 needs a follow-up cross-reference pass.

### b. Clerk schema change for `ext`

- **Question.** Detailed shape of `WritDoc.ext` — exact API for
  `setWritExt`, mutability rules, validation, presentation
  projection.
- **Trade-off.** The Clerk-side schema change set owns these
  decisions. This contract commits to "plugin-keyed metadata-
  shape extension slot exists."
- **Re-evaluation trigger.** When the Clerk-side change set
  lands.

### c. Combination-function design

- **Question.** How does the Reckoner combine the five priority
  dimensions plus complexity into a single scheduling weight?
- **Trade-off.** Out of scope per §3. Belongs to the Reckoner-
  core or Reckonings-book commission.
- **Re-evaluation trigger.** Reckoner-core scheduling prototype.

### d. Calibration loop for `complexity` claims

- **Question.** How do petitioner `complexity` claims get
  calibrated against actual token spend? Tracked at
  `c-mohd0luw`.
- **Trade-off.** Operational concern outside this contract.
- **Re-evaluation trigger.** Calibration data accumulating to
  the point where a structural mechanism (calibrated by-
  petitioner bias offsets, etc.) would help.

### e. Lifecycle hook surface

- **Question.** Future `canRetry` / `onDefer` / `onAccept`
  hooks?
- **Trade-off.** v0 declares no hooks. CDC + standing-order
  observation covers the need.
- **Re-evaluation trigger.** A real `canRetry` use case.

### f. Patron-bridge apparatus

- **Question.** What does the patron-bridge apparatus look like?
  CLI surface, MCP tool, commission-post interaction.
- **Trade-off.** Out of contract — separate downstream
  commission. From the Reckoner's perspective, the patron-bridge
  is just another posting authority registered like any other.
- **Re-evaluation trigger.** Patron-bridge commission dispatch.

### g. Standing-order filter capabilities

- **Question.** §9's standing-order recipes assume filter
  capabilities (e.g. `filterExtSource`, `filterPhase`) that may
  or may not exist in Clockworks today.
- **Trade-off.** This contract relies on Clockworks's standing-
  order substrate without committing to specific filter syntax.
- **Re-evaluation trigger.** Implementation pass cross-references
  the actual Clockworks filter API.

### h. Per-source throttling / conditional disabling

- **Question.** Should `disabledSources` grow into a richer per-
  source policy (rate limits, time-windowed disabling,
  conditional-on-X disabling)?
- **Trade-off.** v0 is a simple skip list. Richer policy adds
  configuration surface that's only worth it if real ops needs
  surface.
- **Re-evaluation trigger.** Operator request for finer-grained
  controls.
