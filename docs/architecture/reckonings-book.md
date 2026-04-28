# The Reckonings Book — Schema & CDC Contract

Status: **Draft**

Owner plugin: `reckoner` · Book name: `reckonings` · Sibling docs:
[apparatus/reckoner.md](apparatus/reckoner.md),
[petitioner-registration.md](petitioner-registration.md),
[clockworks.md](clockworks.md), [apparatus/lattice.md](apparatus/lattice.md),
[apparatus/animator.md](apparatus/animator.md),
[apparatus/sentinel.md](apparatus/sentinel.md).

> **⚠️ Forward-looking design.** This document specifies the
> Reckoner's evaluation-log book before the Reckoner core itself is
> commissioned. The plugin id `reckoner` and the existing
> `@shardworks/sentinel-apparatus` (formerly `@shardworks/reckoner-apparatus`;
> a narrow queue-observer that emits Lattice pulses for `writ-stuck` /
> `writ-failed` / `queue-drained`) have been renamed in a separate
> commission so this id can be reused for the new petition-scheduling
> Reckoner. Nothing in `packages/plugins/sentinel/` is touched by this
> design — see Open Questions for the integration.

---

## Intent

The Reckonings book is the Reckoner's **evaluation journal**: one
append-only row per meaningful consideration, persisted to The Stacks
as `stacks.book('reckoner', 'reckonings')`. The journal is
**event-shaped, not tick-shaped** — the Reckoner writes a row when a
consideration produced a state transition (accept / defer / decline)
or when a re-evaluation was substantive enough to record (e.g. a
wake-up signal fired and the Reckoner re-weighed against current
conditions). Ticks where the Reckoner did not reach a petition, or
re-encountered an unchanged condition and held the same conclusion,
produce no row.

This means **absence-of-row is itself a signal**: a patron, a
downstream petitioner, or a future ethnographer asking "what has the
Reckoner decided about this writ?" gets the answer from the rows that
exist; the lack of any row for a writ since timestamp T means "the
Reckoner has not reached it yet, or no condition has changed that
warranted re-evaluation."

*Which* held writs get weighed on a given tick — and the per-tick
budget that bounds how far down the priority order the Reckoner walks
— is a Reckoner-core scoping-policy decision, not a journal-schema
decision, and lives in the Reckoner-core commission. The schema here
accommodates either a sweep-everything-every-tick policy or a
priority-bounded walk; the journal records what was considered, not
the policy that picked it.

This doc settles the schema, the index set, the retention stance, the
CDC attachment, and the conceptual framing relative to Clerk's writs
book (where held petitions actually live). It is decision-supporting
prose only — downstream Reckoner-core implementers consume this design
as a settled contract; no code, schema declaration, plugin manifest, or
`guild.json` block ships from this commission.

> **Petition-as-writ framing.** Per the
> [Reckoner contract](apparatus/reckoner.md), a "petition" is **a writ
> in `new` phase carrying `ext['reckoner']`**. There is no separate
> petitions book — held petitions live in `clerk/writs`, and approval
> is a phase transition (`new` → `open`), not a record-creation step.
> The Reckonings book is the **only** book this design adds; the
> materialized state-of-the-world lives in `clerk/writs`. Throughout
> this doc, "writ" is the unit of consideration; "petition" survives
> as informal vocabulary for "writ in `new` phase carrying Reckoner
> ext."

---

## Book Identity

`stacks.book('reckoner', 'reckonings')` — `ownerId` is `reckoner`, the
plugin id of the new Reckoner-core; book name is the plural noun
`reckonings`, matching the sibling event-log naming convention
(`events`, `pulses`, `sessions`, `transcripts`).

The auto-wired Stacks → Clockworks event surface for this book is
therefore `book.reckoner.reckonings.created`,
`book.reckoner.reckonings.updated`, and
`book.reckoner.reckonings.deleted`. Of these only the `.created` event
ever fires in practice — see the Immutability section below — and that
single event is the channel petitioners subscribe to (see CDC
Attachment).

---

## Record Schema

### Outcome enum

Every Reckonings record carries a four-state `outcome`:

```
'accepted' | 'deferred' | 'declined' | 'no-op'
```

- **accepted** — the Reckoner transitioned the writ from `new` to
  `open` (or the writ type's equivalent active phase). Spider then
  picks the writ up and dispatches via the standard rig pipeline
  (Distiller → Sage → Artificer), same as any patron-posted
  commission. The writ existed before the Reckoner saw it; acceptance
  is a phase transition, not a record creation.
- **deferred** — the Reckoner left the writ in `new` until a wake-up
  signal fires, with structured reason metadata (see below). No phase
  transition; the writ continues to sit in `new` waiting for the next
  meaningful re-evaluation.
- **declined** — the Reckoner transitioned the writ from `new` to
  `cancelled` on validity grounds. The decline scope is intentionally
  narrow (see Decline Reasons) — "this work isn't worth doing on
  merit" is patron territory and is handled by direct
  `clerk.transition(writId, 'cancelled', …)` from the petitioner, not
  by a Reckoner-issued decline.
- **no-op** — the Reckoner re-weighed the writ this tick against
  changed conditions and chose to keep holding without a phase
  transition. Typical examples: a deferred writ's wake-up signal fired
  and the Reckoner re-evaluated but still held; a sibling resolution
  shifted the priority queue and the Reckoner re-checked this writ's
  position; capacity changed and the Reckoner reconsidered. A `no-op`
  row records that the Reckoner did real work — not the heartbeat of
  the polling loop. See No-op Handling for the absence-of-row
  convention that distinguishes "we weighed and held" from "we haven't
  reached this yet."

A petitioner-initiated withdrawal — `clerk.transition(writId,
'cancelled', …)` (or the `reckoner.withdraw(writId)` helper, which
wraps the same call) — bypasses the Reckoner entirely and produces
**no** Reckonings row. The cancellation is observable through normal
CDC on `book.clerk.writs.updated`; the Reckoner has no decision to
record because the petitioner, not the Reckoner, made the transition.

### Held-writ shape (settled upstream)

The Reckoner reads its inputs from `clerk/writs`. A held writ is a
normal `WritDoc` with one addition: `writ.ext['reckoner']` carries
the petitioner-side metadata that signals "this writ requires Reckoner
consideration." The shape of that ext block is fixed by the
[Reckoner contract](apparatus/reckoner.md) and reproduced here so
this doc is self-contained:

```typescript
interface ReckonerExt {
  source:       string;                  // e.g. 'vision-keeper.snapshot'
  priority:     Priority;                // multi-dimensional; see below
  complexity?:  ComplexityTier;          // 'mechanical' | 'bounded' | 'exploratory' | 'open-ended'
  rationale?:   string;                  // free-form justification for the priority claim
  payload?:     unknown;                 // opaque petitioner-defined data
  labels?:      Record<string, string>;  // additive non-priority metadata
}

type Priority = {
  visionRelation: 'vision-blocker' | 'vision-violator'
                | 'vision-advancer' | 'vision-neutral';
  severity:       'critical' | 'serious' | 'moderate' | 'minor';
  scope:          'whole-product' | 'major-area' | 'minor-area';
  time:           { decay: boolean; deadline: string | null };
  domain:         Array<'security' | 'compliance' | 'cost' | 'feature'
                       | 'quality' | 'infrastructure' | 'documentation'
                       | 'research' | 'ergonomics'>;
};
```

Priority is **multi-dimensional by design** — there is no unified
urgency scalar. The Reckoner does judgment-laden contextual collapse
into scheduling weight; petitioners declare honest dimension values
and the Reckoner combines them. See the contract for the rationale
behind this shape.

The writ's intrinsic fields (`title`, `body`, `codex`, `parentId`,
`type`) carry the work description; `ext['reckoner']` carries the
scheduling-relevant metadata. Specification work happens **after**
acceptance through the existing Distiller → Sage pipeline, the same
path patron-posted commissions take.

### Held-writ lifecycle

The Reckoner is one authority among several that can transition writs
out of `new`. For Reckoner-gated writs (those carrying
`ext['reckoner']`), the relevant transitions are:

```
new → { open | cancelled }
```

- `new → open` — Reckoner-issued **acceptance**. Spider picks up
  from `open` onward.
- `new → cancelled` (Reckoner-issued) — **decline** on validity
  grounds (see Decline Reasons).
- `new → cancelled` (petitioner-issued) — **withdrawal** via direct
  `clerk.transition`. Bypasses the Reckoner; produces no Reckonings
  row.
- Stays in `new` — the Reckoner has either **deferred** the writ
  pending a wake-up signal or has not yet reached it. The journal
  distinguishes these two cases by row presence: a deferred writ
  has at least one Reckonings row; an unreached writ has none.

There is **no separate `deferred` phase**. Deferral is a Reckonings-
book record annotating a writ that remains in Clerk's `new` phase.
The writ's phase is the materialized state-of-the-world; the
Reckonings journal is the decision history.

### Record body

```typescript
// Illustrative — declared in the Reckoner-core commission, not here.
interface ReckoningDoc {
  /** Unique id (`rk-<base36_ts>-<hex>`). Sortable by creation time. */
  id: string;

  /** The Clerk writ this record is about (the held petition). */
  writId: string;

  /** Lean denormalized projection from the writ's ext.reckoner — see
   *  "Lean snapshot" below. */
  source:         string;                                  // ext.reckoner.source
  visionRelation: 'vision-blocker' | 'vision-violator'
                | 'vision-advancer' | 'vision-neutral';   // ext.reckoner.priority.visionRelation
  severity:       'critical' | 'serious' | 'moderate' | 'minor';  // ext.reckoner.priority.severity

  /** Outcome enum — drives the discriminated-union reason fields. */
  outcome: 'accepted' | 'deferred' | 'declined' | 'no-op';

  /**
   * Triggering Clockworks event id, when the consideration was
   * triggered by a scheduling tick. Absent for considerations
   * triggered by a CDC event on `clerk/writs` (e.g. initial post-time
   * consideration of a newly-arrived held writ, before any scheduling
   * tick reaches it). See "Tick identity".
   */
  tickEventId?: string;

  /** ISO timestamp when the Reckoner completed this consideration. */
  consideredAt: string;

  // ── Outcome-keyed reason metadata (flat optionals) ──────────────
  // Consumer types should encode the iff-outcome invariant via a
  // discriminated union; the persisted shape stays flat so indexes
  // can name top-level fields directly.

  /** outcome === 'declined' */
  declineReason?:
    | 'malformed'
    | 'duplicate'
    | 'policy_violation'
    | 'source_banned'
    | 'source_unregistered'
    | 'other';
  remediationHint?: string;

  /** outcome === 'deferred' */
  deferReason?:
    | 'priority'
    | 'queue_depth'
    | 'time_hold'
    | 'patron_policy'
    | 'dependency_pending'
    | 'dependency_failed'
    | 'other';
  deferUntil?: string;            // ISO timestamp, optional
  deferSignal?: string;           // event-pattern reservation, optional
  deferCount?: number;            // running count of times deferred
  firstDeferredAt?: string;       // ISO timestamp
  lastDeferredAt?: string;        // ISO timestamp
  deferNote?: string;             // freeform short note

  // outcome === 'accepted' carries no extra metadata; the fact of
  // acceptance is captured by `outcome: 'accepted'` and `consideredAt`.
  // The phase transition itself is recorded by Clerk on the writ.
}
```

### Identity (`id`)

Record ids use the Stacks `generateId('rk')` convention, producing the
form `rk-<base36_ts>-<hex>`. The two-letter prefix is a deliberate
choice:

- Single-letter prefixes (`p-` for pulses, `w-` for writs, `e-` for
  events, `d-` for dispatches, `c-` for commissions) are taken.
- The next plausible single letter (`r-`) is one keystroke away from
  Spider's `rig-` prefix and would invite confusion in CLI surfaces
  where ids are pasted side-by-side.
- `rk-` keeps the prefix short while being unambiguous against
  `rig-`. The same logic applies to any future `rc-` (Reckoner
  control plane) artifact — every Reckoner-domain id starts with `r`,
  the second letter discriminates.

The base36-timestamp prefix sorts consistently with `createdAt` for
same-millisecond emissions, so list views ordered by `createdAt desc,
id desc` produce stable output across repeated calls — same precedent
the Lattice uses for pulse-id tie-breaking.

### Lean snapshot vs. fat denormalization

The record carries `writId` plus a small, deliberate projection of
three `ext.reckoner` fields — `source`, `priority.visionRelation`,
and `priority.severity` — at the top level. It does **not** embed
the full writ body, does **not** embed the full priority block, and
does **not** carry a foreign-key-only reference to the writ.

The three projected fields are the ones that drive hot filter
queries:

- "show me everything the Reckoner did with writs from
  `vision-keeper.snapshot`" — `source` filter.
- "show me every consideration of a `vision-violator` writ since T" —
  `visionRelation` and `consideredAt` filter.
- "show me every consideration of `critical` or `serious` writs in
  the last hour" — `severity` and `consideredAt` filter.

Embedding only these three avoids a join on every per-writ timeline,
per-source audit, or priority-led dashboard query, while keeping the
record byte-budget close to the lattice/pulses precedent. The full
writ remains the source of truth; the Reckonings record is a snapshot
of the dimensions that drove the decision at the moment of
consideration.

#### Why these three and not the rest of the priority block

The full `Priority` shape has five top-level fields plus a nested
`time` object and an array `domain`. Of those:

- **`visionRelation` and `severity`** are projected — they are
  low-cardinality enums that read naturally as filter columns and
  drive most priority-led dashboards.
- **`scope`** is filterable in-process from any of the other-led
  result sets. It rarely leads a query on its own; not projected.
- **`time`** is a structured sub-object. Projecting it would either
  flatten to two columns (`timeDecay`, `timeDeadline`) or store JSON;
  neither earns its keep against the realistic query shapes. Time-
  bounded queries lead with `consideredAt`, not with the writ's
  declared deadline.
- **`domain`** is an `Array<…>`. The Stacks query language is
  scalar-only — there is no `array_contains` operator and no
  array-field index. Projecting `domain` as JSON would not yield an
  indexable filter; petitioners that want domain-led queries can
  filter `clerk/writs.ext.reckoner.priority.domain` directly. Not
  projected; flagged in Open Questions if Stacks ever grows array-
  index support.
- **`complexity`** is a peer of `priority`, not a priority dimension.
  It answers a different question (cost, not how-much-it-matters);
  not projected on the same rationale as `scope`.

The alternative (a fat record carrying `rationale`, `payload`, the
full `priority` block, etc.) was considered and rejected: those
fields are not filtered against, `rationale` and `payload` grow with
the petitioner's free-form prose, and they would inflate every row of
an append-forever book. The animator's lean-record / heavy-blob split
(sessions + transcripts) is the precedent — but Reckonings stays as a
single book because the record body is already lean enough that a
heavy-blob sibling would be empty.

### Tick identity

The Reckoner has two trigger paths into a consideration:

1. **Scheduled tick** — a Clockworks `schedule:` standing order
   firing on a fixed interval. Every fire writes a synthesized
   `clockworks.timer` event row into `clockworks/events` (see
   [clockworks.md → Scheduled Standing Orders](clockworks.md#scheduled-standing-orders))
   with a unique event id of the form `e-<base36_ts>-<hex>`. The
   Reckoner sweeps held writs and may write Reckonings rows.
2. **CDC-driven** — a Clockworks standing order on
   `book.clerk.writs.{created,updated}`. When a held writ arrives or
   changes, the Reckoner considers it directly. There is no
   scheduling-tick id for these considerations because no scheduled
   timer fired.

Reckonings records stamp the triggering `clockworks.timer` event id
into `tickEventId` on path (1). On path (2), the field is **absent**.
Together with `consideredAt`, this gives the consumer two
complementary handles:

- **`tickEventId`** (when present) — exact-match join to the
  dispatch row, the schedule entry, and every sibling Reckonings row
  produced by the same scheduled tick.
- **`consideredAt`** — time-range filter for since-T sweeps and
  per-writ timeline ordering, available on every row regardless of
  trigger path.

The doc deliberately reuses the framework-emitted `clockworks.timer`
id rather than synthesizing a new "Reckoner tick id" — it earns no
second piece of identity. CDC-triggered considerations have no tick
id because there is no tick to identify; the Stacks `ChangeEvent`
that triggered them is observable through `clockworks/events` for
auditors who need that join.

### Outcome-keyed reason metadata layout

All reason fields live at the top level of the record (flat
optionals), with an iff-outcome invariant the consumer types encode as
a discriminated union:

| Outcome     | Top-level fields populated                                                                                  |
|-------------|-------------------------------------------------------------------------------------------------------------|
| `accepted`  | (none — only the projection and the tick stamp; the phase transition itself is recorded by Clerk on the writ) |
| `deferred`  | `deferReason`, `deferUntil?`, `deferSignal?`, `deferCount?`, `firstDeferredAt?`, `lastDeferredAt?`, `deferNote?`. The dependency-aware-consideration commission ships `dependency_pending` / `dependency_failed` rows that populate `deferReason` + `deferNote` only — the wake-up companions and running counters are absent on those rows pending the staleness-diagnostic commission. |
| `declined`  | `declineReason`, `remediationHint?`                                                                          |
| `no-op`     | (none — only the projection and the tick stamp)                                                              |

The flat layout is required so the index set (see Indexes) can name
top-level fields directly — `declineReason` for the "decline-by-reason
audit" query is the pivotal example. A nested `reason: { … }` blob
would force every query against reason metadata to filter in-process
on JSON-extracted values, defeating the index-driven design.

This matches the lattice/pulses convention of putting filterable
fields at the top level and reserving free-form context for a
purpose-built blob; the Reckonings record has no free-form blob
because every meaningful field is named and filterable.

#### Writer-enforced invariant

The iff-outcome invariant — "a row populates exactly the reason fields
keyed to its `outcome` and no others" — is **writer-enforced by the
Reckoner core**. The Stacks book schema does not validate it: persisted
records can in principle hold inconsistent shapes (e.g. an `accepted`
row carrying a stray `declineReason`). The contract is that the
Reckoner core is the only writer of this book, and it constructs every
row through a single discriminated-union builder before persisting.
Consumer types decode against the same discriminated union, so a
malformed row would surface as a parse error at read time — not as a
silently-tolerated invalid state.

### Decline reasons

The decline-reason enum is intentionally narrow:

```
'malformed'           // ext.reckoner shape is invalid (missing source, malformed priority, etc.)
'duplicate'           // a prior open writ from the same source with the same intent exists
'policy_violation'    // petition violates a guild-declared policy
'source_banned'       // the source is in `reckoner.disabledSources` (operator action)
'source_unregistered' // the source is not in the kit-static petitioner registry, with `enforceRegistration: true`
'other'               // freeform — `remediationHint` carries the detail
```

The narrowness is the point: the Reckoner's decline scope is "petition
validity," not "merit." A well-formed but unwise petition gets a
direct `clerk.transition(writId, 'cancelled', …)` from the petitioner
(or the patron acting on its behalf) — the Reckoner never issues a
merit-based decline.

`source_unregistered` is the registration-check decline, fired when
`reckoner.enforceRegistration: true` (the default) and a writ arrives
carrying an unknown `ext.reckoner.source`. With `enforceRegistration:
false`, unknown-source writs are accepted-with-a-warning and proceed
through normal consideration — no row with this reason is written in
that mode. `source_banned`, by contrast, applies regardless of
`enforceRegistration` and reflects an explicit operator-set
`disabledSources` entry.

### Defer reasons

```
'priority'           // a higher-priority petition is ahead in the queue
'queue_depth'        // the active rig set is full; hold for capacity
'time_hold'          // operator-set hold until a wall-clock time
'patron_policy'      // guild-policy says this category is paused
'dependency_pending' // ≥1 outbound depends-on target is non-terminal
'dependency_failed'  // ≥1 outbound depends-on target is failed-terminal
'other'              // freeform — `deferNote` carries the detail
```

`deferUntil` is populated when the Reckoner can name a wall-clock
time at which to revisit (a `time_hold` or a delayed-priority
re-evaluation). `deferSignal` is populated when the Reckoner reserves
an event pattern as a wake-up trigger (e.g. "re-weigh when
`book.clerk.writs.updated` fires for this writ" or "re-weigh when a
sibling held writ resolves"). At least one of `deferUntil` and
`deferSignal` is populated on a deferred row in normal operation;
both being empty is allowed for the rare `other`-reason hold but
should produce a `deferNote` for the audit trail.

**v0 carve-out for `dependency_pending` / `dependency_failed`.** The
dependency-aware-consideration commission ships these two reasons
without populating `deferUntil` or `deferSignal`. The wake-up
mechanism is the polling tick — deferred dependents are re-evaluated
on every Reckoner tick and release naturally as their dependencies
clear. `deferNote` is populated unconditionally on these rows with a
comma-separated list of the gating or failed dep writ ids (e.g.
`gating: w-abc, w-def` or `failed: w-xyz`); that is the audit trail
the staleness diagnostic indexes against until a future commission
extends the row shape.

The actual wake-up dispatch path for the polling-tick-independent
reasons — how the Reckoner converts a populated `deferSignal` into
a Clockworks standing-order subscription, how `deferUntil` is
converted into a `schedule:` order, and how the re-tick fires against
the deferred petition — is owned by the Reckoner-core commission.
This doc names the schema fields the mechanism stamps; the mechanism
itself is settled there.

`deferCount`, `firstDeferredAt`, and `lastDeferredAt` are running
counters: each new deferral on the same writ increments `deferCount`
and refreshes `lastDeferredAt`, while `firstDeferredAt` is preserved
across deferrals as the writ's first-seen-as-deferred timestamp. The
Reckoner reads the prior Reckonings row for the writ to compute the
running counter; the journal is its own source of truth for the
deferral history. The dependency-aware commission deliberately
leaves the running counters unwired on its rows; wiring them is
owned by the deferred-petition staleness diagnostic. Until that
commission ships, the count of dependency-defer rows is derivable
from `count(*) WHERE writId = X AND outcome = 'deferred' AND
deferReason IN ('dependency_pending', 'dependency_failed')`.

**The counter advances only on `outcome: 'deferred'` rows.** A
`no-op` row produced when the Reckoner re-weighed a held writ and
chose to keep holding does **not** increment `deferCount`. The
counter records distinct deferrals, not re-evaluations of an existing
hold; "how many times has the Reckoner deferred this writ?" is
answered by `count(*) WHERE writId = X AND outcome = 'deferred'`, and
the running counter on the most recent deferred row matches that
count. The dependency-aware-consideration commission's no-op-row
suppression rule preserves this invariant: the Reckoner only emits
a fresh deferred row on dependency-state-shape changes, so the row
count and the (eventual) running counter stay aligned.

### Acceptance metadata

A row with `outcome: 'accepted'` carries **no extra metadata** beyond
the projection and the tick stamp. The fact of acceptance is captured
by `outcome: 'accepted'` and `consideredAt`; the phase transition
itself (`new` → `open`) is recorded by Clerk on the writ and is
observable through `clerk/writs` CDC. There is no separate
"acceptedAt" timestamp because there is no separate acceptance event
— the consideration *is* the transition, and the consideration's
timestamp is `consideredAt`.

This is a deliberate divergence from earlier draft framings in which
the Reckoner *created* a writ on acceptance. Under the held-writ
contract, the writ exists from petitioner-emit time; acceptance is a
phase transition, not a creation, and no second identifier or
timestamp is earned.

---

## No-op Handling

A `no-op` row records that **the Reckoner did real evaluative work
that did not produce a state transition**. It is not the heartbeat of
the polling loop — ticks where the Reckoner did not reach a petition,
or re-encountered an unchanged condition and held the same conclusion,
produce no row at all.

### When a no-op row is written

The Reckoner writes a `no-op` row when a consideration was
*substantive* but the conclusion was still "hold." The canonical
cases:

- A deferred writ's `deferSignal` fired (its wake-up event
  pattern matched). The Reckoner re-weighed against current state
  and chose to keep holding rather than transition. The wake-up was
  meaningful even though the outcome did not change.
- A deferred writ's `deferUntil` deadline passed and the Reckoner's
  scheduled re-tick re-evaluated it. Same logic — the re-evaluation
  was real work, recorded, even if the conclusion did not transition.
- A held writ was re-weighed because a sibling resolved (acceptance
  or withdrawal shifted the priority queue) or capacity changed, and
  the Reckoner re-checked this writ's standing. The re-evaluation was
  triggered by a change in conditions, not by the tick itself.

### When a row is **not** written

- The Reckoner did not reach the writ this tick (priority-bounded
  walk stopped before it). No row.
- The Reckoner ticked, encountered the writ, but no condition had
  changed since the last consideration — same priority order, same
  capacity, same wake-up state. No row. The prior conclusion stands
  by inheritance.

### Absence-of-row is the signal

The "did anyone look at me?" question is answered by **any** row
existing for the writ. A writ with no rows has not yet been reached
or has had no condition change warrant re-evaluation; that is itself
meaningful information. A writ with a recent terminal row
(`accepted` / `declined`) has its outcome on file. A writ with a
deferred row and several no-op rows has been actively re-weighed
multiple times since the last transition.

This convention shifts a small amount of reasoning onto callers ("no
row" means a specific thing) in exchange for an event-shaped journal
that scales with decision events rather than with tick frequency. The
storage-growth math (next section) reflects this design.

### No-op records carry the same projection as state-transition records

When a `no-op` row *is* written, it carries `source`, `visionRelation`,
and `severity` exactly like every other outcome — same lean snapshot,
same tick stamp, same `consideredAt`. The modest byte savings of a
stripped no-op shape don't justify branching the read path for every
consumer query: filters like "since T, all considerations of
`vision-violator` writs" must work uniformly across all four
outcomes, and the indexes that support those filters need every row
to be the same shape.

This uniformity also keeps the discriminated-union consumer type
clean: no fork between "full record" and "stub record"; the
discriminant is `outcome`, and the optional reason fields default to
absent.

---

## Retention

**Append-only forever.** The Reckonings book has no rolling-window
default, no built-in archival relay, no prune job. Every row the
Reckoner ever writes persists until an explicit operator action
removes it.

This matches the sibling event-log books — `clockworks/events`,
`clockworks/event_dispatches`, `lattice/pulses`,
`animator/sessions`, `animator/transcripts` all default to unbounded
growth. The lattice-apparatus and animator-apparatus docs both name
retention as a future commission with no current trigger; the
Reckonings book inherits the same stance.

A rolling-window default would silently lose audit history. The
journal's load-bearing job is "show me everything that ever happened
to this writ" — a 90-day window quietly drops the row a post-mortem
six months later needs.

### Storage-growth math

The journal is event-shaped, so volume scales with decision events
rather than with tick frequency. A representative steady-state model
based on the v0 cadence (1 tick / minute) and a moderately active
guild:

```
state-transition rows (accepts + defers + declines)
  ≈ 2–10 / hour during active operation
  ≈ 0–2 / hour during idle stretches

substantive no-op rows (wake-up re-evaluations, sibling resolutions
                        prompting re-weighs, capacity changes)
  ≈ 5–30 / hour during active operation
  ≈ 0–5 / hour during idle stretches

steady-state composite
  ≈ 1–3 rows / minute averaged across active and idle periods
  ≈ 525,000 – 1,575,000 rows / year
  ≈ 250 MB – 800 MB / year   at  ~500 bytes / row (lean projection)
```

This is roughly an order of magnitude below what a sweep-everything-
every-tick policy would produce (the earlier draft of this doc
projected ~5.3M rows / year on that assumption). The order-of-
magnitude difference is the load-bearing payoff of the event-shaped
design: the journal records decisions, not heartbeats.

SQLite handles tables at this scale comfortably with the indexes
declared below — primary-key lookups stay sub-millisecond, the
indexed range scans on `consideredAt` and the per-writ timeline use
the compound indexes directly, and table size at this magnitude is
well within the Animator's transcripts-book scale (~30–300 MB / day)
that the same substrate is already exercised at.

Trip-wires that warrant revisiting:

- An order-of-magnitude increase in tick cadence (e.g. 10×
  faster) **combined with** a Reckoner-core scoping policy that
  produces no-ops more eagerly than the substantive-only convention
  above.
- A sustained 6-month measurement that exceeds 2M rows / year
  (more than 25% above the projection's upper bound).
- An operator-visible query latency regression on the per-writ
  timeline or since-T sweeps.

The trip-wires belong in Open Questions, not in the v0 retention
design.

### Future archival pattern (named, not built)

When an operator does need to bound the book, the natural shape — to
be designed by a future commission, not this one — is a separate
archival relay subscribed to a wall-clock schedule that:

1. Selects rows older than a configured threshold via a compound
   index (`['consideredAt']`).
2. Writes them to a sibling `reckonings_archive` book, an external
   sink (the Sentinel apparatus, the Laboratory's CDC ingestion), or
   both.
3. Deletes the live rows in the same transaction the archive write
   commits in.

The doc names this only as an opt-in; building it before the
trip-wires fire would be premature.

---

## Query Patterns and Indexes

The index set is filter-shape-driven: every entry traces back to a
named query the Reckoner or its consumers run. Speculative indexes
are not added.

### Named queries

| Query | Filter shape | Index used |
|-------|--------------|------------|
| **Per-writ timeline** — show every consideration of writ W, oldest first | `writId = W` ORDER BY `consideredAt asc` | `['writId', 'consideredAt']` |
| **Since-T sweep** — every Reckonings row produced since timestamp T | `consideredAt >= T` | `consideredAt` |
| **Decline-by-reason audit** — every writ declined for reason R | `outcome = 'declined' AND declineReason = R` | `declineReason` (with the `outcome` filter narrowing the candidate set further) |
| **Per-source filtering** — every consideration of writs emitted by source S | `source = S` (optionally + `consideredAt`) | `source` |
| **Recent-by-outcome** — most recent N rows for outcome O | `outcome = O` ORDER BY `consideredAt desc` | `['outcome', 'consideredAt']` |
| **Vision-relation timeline** — recent considerations of `vision-blocker` or `vision-violator` writs | `visionRelation = V` ORDER BY `consideredAt desc` | `['visionRelation', 'consideredAt']` |
| **Severity timeline** — recent considerations of `critical` or `serious` writs | `severity = S` ORDER BY `consideredAt desc` | `['severity', 'consideredAt']` |
| **Outcome-only filter** — count or list rows by outcome | `outcome = O` | `outcome` |

### Declared index set

> **Illustrative — declared in the Reckoner-core commission, not here.**
> The list below is the contract this design hands forward; the actual
> `indexes:` block ships from the Reckoner-core book registration.

```typescript
indexes: [
  'writId',
  'consideredAt',
  'outcome',
  'source',
  'visionRelation',
  'severity',
  'declineReason',
  ['outcome', 'consideredAt'],
  ['visionRelation', 'consideredAt'],
  ['severity', 'consideredAt'],
  ['writId', 'consideredAt'],
]
```

Tracing each entry back to the queries it supports:

- **`writId`** — bare-key existence checks ("does any row exist for
  this writ?") and the foreign-key-style join from `clerk/writs`;
  superseded for ordered timelines by `['writId', 'consideredAt']`.
- **`consideredAt`** — the unconditional since-T sweep, used by
  recent-history surfaces (Oculus pages, the future Sentinel
  apparatus's archival selector, vision-keeper's "what changed since
  my last poll" check).
- **`outcome`** — outcome-only filters and counts; standalone for
  uses that don't need a time bound.
- **`source`** — per-source audit (every consideration of writs from
  a single petitioner). The petitioner-registration contract surfaces
  this as part of an operator's per-petitioner page.
- **`visionRelation`** — vision-led queries: "every `vision-blocker`
  the Reckoner has ever weighed," "show me what the Reckoner has done
  with vision-violator writs in the last hour." Vision-relation is
  one of the two dimensions Coco identified as primary dashboard
  axes, so it earns a top-level index.
- **`severity`** — severity-led queries: "every `critical` writ the
  Reckoner has weighed," "show me the serious-or-worse backlog the
  Reckoner has touched today." The other primary dashboard axis.
- **`declineReason`** — the decline-by-reason audit. The flat
  schema layout is what makes this an indexable top-level field; a
  nested `reason: { … }` would not.
- **`['outcome', 'consideredAt']`** — recent-by-outcome compound,
  serving the most common dashboard query: "what did the Reckoner
  decide in the last hour, grouped by outcome." The leading
  `outcome` column is low-cardinality (4 values), so this index
  doubles as a fast histogram input.
- **`['visionRelation', 'consideredAt']`** — vision-led timeline
  without a re-sort. Pairs with the standalone `visionRelation`
  index for vision-leading dashboard widgets.
- **`['severity', 'consideredAt']`** — severity-led timeline without
  a re-sort. Pairs with the standalone `severity` index for the
  most common operator query shape ("what serious-or-worse work has
  the Reckoner been weighing recently?").
- **`['writId', 'consideredAt']`** — per-writ timeline ordering
  without a re-sort. Critical for the petitioner-side "show me my
  writ's full history" view, and for the `deferCount` lookup the
  Reckoner runs against the prior deferred row when re-deferring.

`scope`, `time.decay`, `time.deadline`, `domain`, and `complexity`
are **not** projected and therefore not indexed. They are filterable
in-process from any of the dimension-led result sets, or directly
against `clerk/writs.ext.reckoner` for queries that lead with them.
`domain` in particular cannot be indexed under the current Stacks
query language (scalar-only `WhereCondition`); see Open Questions
for the trip-wire that would warrant adding array-index support.

`tickEventId` is not indexed. The expected access pattern is "look
up the Reckonings row by id, then walk to the tick" — not "find every
row produced by tick T," which is rare and tolerates the full scan or
a join through `consideredAt`. Adding the index later costs one
schema migration and earns its keep only if the access pattern
changes.

---

## Immutability

Reckonings records are **strictly immutable.** They carry `consideredAt`
and no `updatedAt`; once written, the row is never patched.

### Why no `updatedAt`

The Lattice's `pulses` book carries `updatedAt` because pulses have a
mutable field — `deliveryState` (`pending → delivered/failed`) — that
the Lattice itself rewrites as dispatches progress. The Reckonings
book has no analogous mutable field. There is no producer that would
mutate a record in place:

- The outcome is final at consideration time.
- The reason metadata is derived from the writ's `ext.reckoner`
  state at the moment of consideration; a later re-evaluation
  produces a new row, not a patch on the old one.
- The projected dimensions (`source`, `visionRelation`, `severity`)
  are stamped at consideration time. If the writ's `ext.reckoner` is
  later updated (via `clerk.setWritExt`), subsequent considerations
  will project the new values onto new rows; the old rows preserve
  the dimensions as they stood when the Reckoner weighed them.
- Defer-counter updates (`deferCount`, `lastDeferredAt`) accumulate
  by writing a new deferred row, not by mutating the prior one — the
  per-deferral history is the journal's load-bearing output.

Adding `updatedAt` with no producer would be structure with no
consumer.

### Future mutation needs

If a future commission needs to attach mutable annotations to a
Reckonings row — operator notes, post-hoc tags, classifications from
a Sentinel-style auditor — those belong in a sibling overlay book
keyed by Reckonings id, not in-place mutation of the journal. The
journal is the durable record; overlays are layered on top.

---

## CDC Attachment

### Channel name

Petitioner subscribers wire to the auto-wired Stacks → Clockworks
event:

```
book.reckoner.reckonings.created
```

The change-event payload is the Stacks `ChangeEvent<ReckoningDoc>`
passed through verbatim by the `clockworks-stacks-signals` bridge
plugin (see
[clockworks-stacks-signals.md](apparatus/clockworks-stacks-signals.md)
and [event-catalog.md → CDC Events](../reference/event-catalog.md#cdc-events)).
Subscribers that want to filter to a specific outcome do so in their
relay handler, against `event.entry.outcome`:

```typescript
// Illustrative — vision-keeper's accepted-only relay sketch.
relay({
  name: 'vision-keeper-on-accept',
  handler: async (event) => {
    const change = event.payload as ChangeEvent<ReckoningDoc>;
    if (change.type !== 'create') return;
    if (change.entry.outcome !== 'accepted') return;
    // … react to the accepted petition.
  },
});
```

The in-relay payload filter is one line. Adding a named-events surface
(`reckoning.accepted`, `reckoning.deferred`, `reckoning.declined`,
`reckoning.no-op`) would double the write path with no second consumer
auto-wiring cannot serve. Named events are an explicitly considered
and rejected alternative; see Open Questions for the conditions under
which they would earn their keep.

### No carve-out from auto-wiring

The `clockworks-stacks-signals` bridge plugin carves
`clockworks/events` itself out of CDC auto-wiring because a watcher
on the events book would observe its own emit and re-emit forever —
see
[clockworks-stacks-signals.md → Carve-out](apparatus/clockworks-stacks-signals.md#carve-out-clockworksevents).
Reckonings has **no** such recursion: the Reckoner does not write a
Reckonings row in response to a Reckonings change event, and no
downstream petitioner loops back into the Reckoner's tick path
through the Reckonings stream.

The Reckonings book therefore takes **no carve-out**. The auto-wired
`book.reckoner.reckonings.created` event fires normally and is the
single CDC channel petitioners subscribe to.

If the doc adopted named events instead, the carve-out question would
be moot — but then we would be writing every change twice (once via
auto-wire, once via the named emit). Keeping the Reckonings book in
the auto-wired path is what makes the single-write design work.

### Validator namespace observation

The `reckoner.` and `reckoning.` prefixes are **not** currently
reserved in the Clockworks signal validator
(`packages/plugins/clockworks/src/signal-validator.ts` —
`RESERVED_EVENT_NAMESPACES` covers `anima.`, `commission.`, `tool.`,
`migration.`, `guild.`, `standing-order.`, `session.`, `schedule.`).
This is **not load-bearing in v0**: the auto-wired
`book.reckoner.reckonings.created` channel is the only event the
Reckonings book produces, and the `book.` prefix is also unreserved
(see [event-catalog.md: reserved-namespace gap](../reference/event-catalog.md#reserved-namespaces))
so adding `reckoner.` to the reserved list would not close the
existing gap on CDC events anyway.

If a future commission earns the named-events surface (the
alternative rejected here), it must extend the validator's
`RESERVED_EVENT_NAMESPACES` list at the same time so animas cannot
forge `reckoning.accepted` / `reckoning.deferred` / etc. via the
`signal` tool. That coupling is owned by whichever future commission
introduces named emission — it is **not** done by this design.

---

## Journal vs. Writs Book

The Reckoner does not own a materialized state-of-the-world book.
The materialized view of "which petitions are held, accepted,
declined, or withdrawn" lives in **Clerk's writs book**, which
already has phase-based state, ext-keyed metadata, and CDC. Two
books with deliberately different grains coexist:

| Book                                | Role               | Grain                                         |
|-------------------------------------|--------------------|-----------------------------------------------|
| `clerk/writs` (Clerk-owned)         | Materialized view  | One row per writ; `phase` + `ext.reckoner` is current state |
| `reckoner/reckonings` (this doc)    | Event journal      | One row per substantive consideration, full history |

**The two CDC channels are not duplicative.** They differ in grain:

- `book.clerk.writs.{created,updated,deleted}` fires on writ
  transitions and writ writes. A subscriber wiring to
  `book.clerk.writs.updated` and filtering on
  `event.entry.phase === 'open' && event.entry.ext?.reckoner`
  sees the **state-of-the-world** change at the moment of
  acceptance, but does not see the Reckoner's repeated weighings
  of that same writ while it was held in `new`.
- `book.reckoner.reckonings.created` fires on every substantive
  consideration — state-changing or not. A subscriber wiring here
  sees the **decision history** of every writ the Reckoner has
  weighed, including the no-op re-evaluations that didn't transition.

Asking the writs book to double as a journal would force an O(n)
scan of every writ row to reconstruct deferral history, and would
fail entirely for no-op considerations that produced no phase
transition to scan. The writ's phase is the latest state; it is
**not** the history of how the Reckoner reached that state.

Asking the journal to double as a materialized view would force every
"what is the current phase of writ X?" query to walk the journal
backward looking for the most recent terminal row, **and** to fall
back on `clerk/writs` for the phase truth anyway because the journal
doesn't observe petitioner-initiated withdrawals (those bypass the
Reckoner). The writs book is the unambiguous source of truth for
phase; the journal is the unambiguous source of truth for *what the
Reckoner did*.

The two books exist together. Petitioners that want "act on every
phase transition of my writs" subscribe to `book.clerk.writs.updated`
filtered on `ext.reckoner.source`. Petitioners (or operators, or
ethnographers) that want "audit every consideration" subscribe to
`book.reckoner.reckonings.created`. Most petitioners only need the
first; the journal is the second.

---

## Precedent Comparison

The Reckonings book is the fifth book in the guild's family of
event-log substrates. It inherits the established shape from its
predecessors and diverges where the load-bearing constraints differ.
The four citations:

- `clockworks/events` — `EventDoc` in
  [packages/plugins/clockworks/src/types.ts](../../packages/plugins/clockworks/src/types.ts)
  (`{ id, name, payload, emitter, firedAt, processed }`), index set
  `['name', 'processed', 'firedAt', ['processed', 'firedAt']]`.
- `clockworks/event_dispatches` — `EventDispatchDoc` in the same
  file (`{ id, eventId, handlerType, handlerName, targetRole,
  noticeType, startedAt, endedAt, status, error }`), index set
  `['eventId', 'status', ['eventId', 'status']]`.
- `lattice/pulses` — `PulseDoc` in
  [packages/plugins/lattice/src/types.ts](../../packages/plugins/lattice/src/types.ts)
  (`{ id, source, triggerType, writId, title, summary, linkUrl,
  context, deliveryState, deliveryError?, createdAt, updatedAt }`),
  index set `['triggerType', 'source', 'createdAt', 'deliveryState',
  'writId', ['deliveryState', 'createdAt'], ['triggerType',
  'createdAt']]`.
- `animator/sessions` and `animator/transcripts` — `SessionDoc` and
  `TranscriptDoc` in `packages/plugins/animator/src/types.ts`, index
  sets `['startedAt', 'status', 'conversationId', 'provider']` and
  `['sessionId']`.

### What Reckonings inherits

| From | Lesson |
|------|--------|
| `clockworks/events` | The `id`-format convention (`<prefix>-<base36_ts>-<hex>` via `generateId`); the append-only stance; the framework-emitter trust convention (the writer stamps `source` / `emitter`, no validation). |
| `clockworks/event_dispatches` | The filter-shape-driven index set — only fields that name a real query get an index; compound indexes are added when the query is `WHERE a = … ORDER BY b` shaped. |
| `lattice/pulses` | The top-level-fields-plus-typed-context shape (the projection lives at the top so it is filterable, the free-form payload lives in a nested blob); Phase 2 CDC for downstream dispatch (the `book.<owner>.<book>.created` channel petitioners subscribe to is the same shape Lattice consumers use); the lean record body. |
| `animator/sessions` | The lean-record / heavy-blob distinction at the apparatus level — even though Reckonings keeps a single book, the framing of "every field is filterable; nothing here is a free-form blob" is what makes the single-book choice work. |

### Where Reckonings diverges

| From | Divergence | Why |
|------|------------|-----|
| `clockworks/events` | **No carve-out from CDC auto-wiring.** Events carves itself out because a watcher on the events book observes its own emit. Reckonings has no such recursion. | See CDC Attachment. |
| `lattice/pulses` | **No `updatedAt`.** Pulses mutate `deliveryState`; Reckonings has no mutable field. | See Immutability. |
| `lattice/pulses` | **No free-form `context: Record<string, unknown>`.** Every Reckonings field is named and indexed-or-filtered-against. | The pulses-style context blob exists because pulse consumers want trigger-keyed structured payloads (e.g. `WritStuckContext`); Reckonings reason metadata is already discriminated by `outcome`, so a separate context blob would be empty. |
| `animator/sessions` + `animator/transcripts` | **One book, not two.** Sessions is lean, transcripts is heavy; Reckonings keeps the lean half and has no heavy-blob sibling. | The writ's `body`, `ext.reckoner.rationale`, and `ext.reckoner.payload` live on the writ in `clerk/writs`, not on the journal. The journal stays at the lean-record scale. |
| `clockworks/event_dispatches` | **No per-handler dispatch log.** event_dispatches is a sibling to events recording one row per handler invocation; Reckonings has no per-handler concept. | Petitioner subscribers run as ordinary Clockworks standing orders against the auto-wired CDC event, so the dispatch log they produce already lives in `clockworks/event_dispatches`. A second per-handler log on the Reckonings side would duplicate that. |

The dual-table pattern (events + event_dispatches) was considered as a
shape for the Reckoner — one table for considerations weighed, a
second for "what each downstream subscriber did about it." It was
rejected on the same grounds: subscriber reactions are Clockworks
standing orders, and the existing `event_dispatches` book already
records one row per invocation. Adding a Reckoner-owned dispatch log
would re-implement a sibling apparatus's load-bearing data.

---

## Open Questions

The five items this design intentionally leaves for follow-on
resolution.

- **Cross-reference to petitioner-registration.** The
  [petitioner-registration contract](petitioner-registration.md) (and
  its successor framing in the [Reckoner contract](apparatus/reckoner.md))
  define how a petitioner declares itself, the kit-static registry,
  the source-id grammar, and the `enforceRegistration` /
  `disabledSources` config. This Reckonings doc names the auto-wired
  event surface registration plugs into
  (`book.reckoner.reckonings.created`, with the registered petitioner's
  standing order filtering on `outcome` and `source`) but does
  **not** restate the registration shape. If the registration
  contract gains additional projection fields the journal should
  reflect (e.g. a per-source `tier`), that lands as a follow-up here.

- **Retention trip-wires.** v0 ships append-only forever with the
  storage-growth math above. The trip-wires that warrant a future
  retention-design commission are concrete:
  1. A Sentinel or Laboratory archival sink lands and an operator
     wants to point an archival relay at it.
  2. An operator complains about Reckonings book size or about
     Stacks query latency on the per-writ timeline query.
  3. Six months of production-growth measurement materially diverges
     from the 525K–1.5M rows / year projection — either above 2M
     rows / year (overrun) or below 250K / year (under-utilization
     suggesting the scoping policy is too aggressive).
  Until one of those fires, retention is "do nothing." Designing the
  archive shape before it has a pull is premature; the future
  archival pattern in the Retention section is the placeholder, not
  the design.

- **Queue-observer fold-back.** The existing
  `@shardworks/sentinel-apparatus` is a narrow CDC observer that
  emits `reckoner.writ-stuck` / `reckoner.writ-failed` /
  `reckoner.queue-drained` Lattice pulses (see
  [apparatus/sentinel.md](apparatus/sentinel.md)). It was renamed
  out of the `reckoner` plugin id so that id can be reused for the
  new petition-scheduling Reckoner. An open question is whether the
  queue-observer's responsibilities (writ-lifecycle observation
  feeding Lattice pulses) fold back into the new Reckoner core, or
  stay in the renamed sibling. The Reckonings book is unaffected
  either way — the queue-observer's pulses go to the Lattice, not
  to the Reckonings book — but the conceptual seam between
  "petition evaluation" and "writ-lifecycle observation" wants to
  be settled before the new Reckoner core ships.

- **`domain` array indexing.** `ext.reckoner.priority.domain` is
  multi-valued (`Array<…>`) and is not projected on the Reckonings
  record because the Stacks query language is scalar-only — there
  is no `array_contains` operator and no array-field index.
  Domain-led queries today filter `clerk/writs.ext.reckoner.priority.domain`
  in-process (full-scan or via a Stacks-side JSON predicate, neither
  efficient). If Stacks grows array-index support — or if a
  domain-led dashboard becomes a primary surface — the natural
  follow-up is to project `domain` onto the Reckonings record (as
  JSON-array column) and add the corresponding index.

- **When named events earn their keep.** This doc rejects a
  named-events emission surface (`reckoning.accepted`,
  `reckoning.deferred`, etc.) on the grounds that auto-wiring + a
  one-line in-relay outcome filter serves every consumer auto-wiring
  can serve. The conditions under which named events earn their
  keep:
  1. A non-Clockworks consumer of the Reckonings stream appears —
     e.g. an external webhook bus, a Discord channel, an HTTP
     subscriber — that cannot conveniently consume the framework's
     `ChangeEvent<T>` shape and would benefit from a named event
     with a flat payload.
  2. A measurable performance penalty appears in the in-relay filter
     path. Today the filter is one branch on a tagged union; if a
     future profiling pass shows the change-event payload is large
     enough that all-relays-receive-all-events-and-filter is
     measurably worse than per-outcome dispatch, the surface
     justifies its own emit path.
  3. The validator's reserved-namespace policy gains teeth on
     `book.*` events and the same pass extends teeth to `reckoning.*`.
  Until at least one of those fires, the auto-wired single channel
  remains sufficient.

---

## See Also

- [docs/architecture/apparatus/reckoner.md](apparatus/reckoner.md)
  — the petition-scheduling Reckoner whose contract surface this
  book layers on top of. Defines the held-writ shape
  (`writ.ext['reckoner']`), the priority dimensions, the petitioner
  registry, and the `enforceRegistration` / `disabledSources` config.
- [docs/architecture/petitioner-registration.md](petitioner-registration.md)
  — the petitioner-registration contract: source-id grammar, the
  kit-static registry, kit-vs-kit collision policy, the trust
  model.
- [docs/architecture/clockworks.md](clockworks.md) — the CDC
  auto-wiring contract and the reserved-namespace policy.
- [docs/architecture/apparatus/lattice.md](apparatus/lattice.md) —
  the closest schema precedent for a Reckonings record.
- [docs/architecture/apparatus/animator.md](apparatus/animator.md)
  — the lean-record / heavy-blob book split (the alternative
  considered and rejected here).
- [docs/architecture/apparatus/sentinel.md](apparatus/sentinel.md)
  — the renamed queue-observer apparatus that previously held the
  `reckoner` plugin id and continues to emit
  `reckoner.writ-stuck` / `reckoner.writ-failed` /
  `reckoner.queue-drained` Lattice pulses.
- [docs/reference/event-catalog.md](../reference/event-catalog.md)
  — CDC event names, reserved namespaces, validator policy.
- [docs/architecture/apparatus/_template.md](apparatus/_template.md)
  — apparatus-doc template; this book-focused doc draws its
  register from it.
