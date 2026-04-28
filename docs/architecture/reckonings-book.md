# The Reckonings Book — Schema & CDC Contract

Status: **Draft**

Owner plugin: `reckoner` · Book name: `reckonings` · Sibling docs:
[clockworks.md](clockworks.md), [apparatus/lattice.md](apparatus/lattice.md),
[apparatus/animator.md](apparatus/animator.md),
[apparatus/reckoner.md](apparatus/reckoner.md),
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
append-only row per petition consideration, persisted to The Stacks as
`stacks.book('reckoner', 'reckonings')`. Every tick of the Reckoner's
fixed-interval polling pass produces a row for each petition it weighed
— accepted, deferred, declined, or held without a state change — so a
patron, a downstream petitioner, or a future ethnographer can ask "did
the Reckoner ever look at this petition, and what did it decide?" with
a single book query.

This doc settles the schema, the index set, the retention stance, the
CDC attachment, and the conceptual framing relative to the
petition-state book that lives next door. It is decision-supporting
prose only — downstream Reckoner-core implementers consume this design
as a settled contract; no code, schema declaration, plugin manifest, or
`guild.json` block ships from this commission.

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

- **accepted** — the Reckoner created a writ for the petition and
  flipped the petition state to `accepted`. The resulting writ flows
  into the standard rig pipeline (Distiller → Sage → Artificer), same
  as a patron-posted commission.
- **deferred** — the Reckoner held the petition until a wake-up signal
  fires, with structured reason metadata (see below).
- **declined** — the Reckoner rejected the petition on validity
  grounds. The decline scope is intentionally narrow (see Decline
  Reasons) — "this work isn't worth doing on merit" is patron
  territory and produces a `withdrawn` transition by the patron, not
  a Reckoner-issued decline.
- **no-op** — the Reckoner weighed the petition this tick but produced
  no state transition. Deferred petitions whose wake-up signal has not
  yet fired are the typical case; so are pending petitions blocked
  behind a higher-priority sibling. No-ops are first-class — see No-op
  Handling.

`withdrawn` is a petitioner-initiated transition and is **not** a
Reckoner-consideration outcome, so it does not produce a Reckonings
row.

### Petition shape (settled upstream)

The Reckoner reads petitions from the petition-state book; the schema
of that book is settled by an adjacent commission and reproduced here
so this doc is self-contained. Each petition carries:

- `source` — petitioner identity (vision-keeper, future tech-debt
  watchers, the laboratory introspection writer, ad-hoc patron
  petitions, …).
- `intent` — short imperative sentence describing the work the
  petitioner wants done.
- `rationale` — long-form prose justifying the petition.
- `priority_signals` — a structured block: `urgency` (an enum,
  `immediate | urgent | normal | low`) plus an optional
  `strategic_ref` pointing into a vision-document or roadmap entry.
- `context_anchors` — file paths, writ ids, transcript ids, and
  similar handles a downstream specifier can use as starting points.

There is no pre-built brief or spec on a petition. Specification work
happens **after** acceptance through the existing Distiller → Sage
pipeline, the same path patron-posted commissions take.

### Petition lifecycle (settled upstream)

```
new → pending → { accepted | deferred | declined | withdrawn }
```

- `accepted`, `declined`, and `withdrawn` are terminal.
- `deferred → pending` re-awakens on a wake-up signal.
- `withdrawn` is petitioner-initiated and produces **no** Reckonings
  row — the Reckoner never weighed it as part of its own
  consideration loop.

### Record body

```typescript
// Illustrative — declared in the Reckoner-core commission, not here.
interface ReckoningDoc {
  /** Unique id (`rk-<base36_ts>-<hex>`). Sortable by creation time. */
  id: string;

  /** The petition this record is about. */
  petitionId: string;

  /** Lean denormalized projection — see "Lean snapshot" below. */
  source: string;
  urgency: 'immediate' | 'urgent' | 'normal' | 'low';

  /** Outcome enum — drives the discriminated-union reason fields. */
  outcome: 'accepted' | 'deferred' | 'declined' | 'no-op';

  /**
   * Triggering Clockworks event id — the `clockworks.timer` row that
   * produced this tick. Optional only on the patron fast path.
   * See "Tick identity".
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
    | 'other';
  remediationHint?: string;

  /** outcome === 'deferred' */
  deferReason?:
    | 'priority'
    | 'queue_depth'
    | 'time_hold'
    | 'patron_policy'
    | 'other';
  deferUntil?: string;            // ISO timestamp, optional
  deferSignal?: string;           // event-pattern reservation, optional
  deferCount?: number;            // running count of times deferred
  firstDeferredAt?: string;       // ISO timestamp
  lastDeferredAt?: string;        // ISO timestamp
  deferNote?: string;             // freeform short note

  /** outcome === 'accepted' */
  writId?: string;                // the writ created on acceptance
  acceptedAt?: string;            // ISO timestamp
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

The record carries `petitionId` plus a small, deliberate projection of
two petition fields — `source` and `priority_signals.urgency` — at the
top level. It does **not** embed the full petition body and does
**not** carry a foreign-key-only reference to the petition row.

The two projected fields are the ones that drive hot filter queries:

- "show me everything the Reckoner did with petitions from
  `vision-keeper`" — `source` filter.
- "show me every consideration of an `urgent` petition since T" —
  `urgency` and `consideredAt` filter.

Embedding only these two avoids a join on every per-petition timeline
or per-source audit query, while keeping the record byte-budget close
to the lattice/pulses precedent. The full petition row remains the
source of truth; the Reckonings record is a snapshot at the moment of
consideration.

The alternative (a fat record carrying `intent`, `rationale`,
`context_anchors`, etc.) was considered and rejected: those fields are
not filtered against, they grow with the petition's free-form prose,
and they would inflate every row of an append-forever book. The
animator's lean-record / heavy-blob split (sessions + transcripts) is
the precedent — but Reckonings stays as a single book because the
record body is already lean enough that a heavy-blob sibling would be
empty.

### Tick identity

The Reckoner's v0 trigger is a fixed-interval polling tick implemented
as a Clockworks `schedule:` standing order. Every fire writes a
synthesized `clockworks.timer` event row into `clockworks/events` (see
[clockworks.md → Scheduled Standing Orders](clockworks.md#scheduled-standing-orders))
with a unique event id of the form `e-<base36_ts>-<hex>`.

Each Reckonings record stamps the triggering `clockworks.timer` event id
into a `tickEventId` field. Together with `consideredAt`, this gives
the consumer two complementary handles:

- **`tickEventId`** — exact-match join to the dispatch row, the
  schedule entry, and every sibling Reckonings row produced by the
  same tick.
- **`consideredAt`** — time-range filter for since-T sweeps and
  per-petition timeline ordering without going through the events
  book.

The doc deliberately reuses the framework-emitted `clockworks.timer` id
rather than synthesizing a new "Reckoner tick id" — it earns no second
piece of identity. There is one exception:

#### Patron fast-path: `tickEventId` is optional

The settled patron fast-path bypasses the Reckoner tick entirely. A
patron-posted petition with `urgency: 'immediate'` is auto-accepted at
post time, with the writ created synchronously and no waiting for the
next tick. The Reckonings row for an `immediate` acceptance is still
written so the audit trail is uniform — but because the row is written
**outside** any tick, there is no `clockworks.timer` event id to stamp.
`tickEventId` is therefore optional, not required: present on every
non-fast-path row, absent on patron-fast-path acceptances.

### Outcome-keyed reason metadata layout

All reason fields live at the top level of the record (flat
optionals), with an iff-outcome invariant the consumer types encode as
a discriminated union:

| Outcome     | Top-level fields populated                                                                                  |
|-------------|-------------------------------------------------------------------------------------------------------------|
| `accepted`  | `writId`, `acceptedAt`                                                                                       |
| `deferred`  | `deferReason`, `deferUntil?`, `deferSignal?`, `deferCount`, `firstDeferredAt`, `lastDeferredAt`, `deferNote?` |
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

### Decline reasons (settled upstream)

The decline-reason enum is intentionally narrow:

```
'malformed'        // petition shape is invalid (missing source, etc.)
'duplicate'        // a prior petition with the same intent is open
'policy_violation' // petition violates a guild-declared policy
'source_banned'    // the source has been blacklisted
'other'            // freeform — `remediationHint` carries the detail
```

The narrowness is the point: the Reckoner's decline scope is "petition
validity," not "merit." A petition that is well-formed but unwise
gets a `withdrawn` transition from the patron — the Reckoner never
issues a merit-based decline.

### Defer reasons (settled upstream)

```
'priority'       // a higher-priority petition is ahead in the queue
'queue_depth'    // the active rig set is full; hold for capacity
'time_hold'      // operator-set hold until a wall-clock time
'patron_policy'  // guild-policy says this category is paused
'other'          // freeform — `deferNote` carries the detail
```

`deferUntil` is populated when the Reckoner can name a wall-clock
time at which to revisit (a `time_hold` or a delayed-priority
re-evaluation). `deferSignal` is populated when the Reckoner reserves
an event pattern as a wake-up trigger (e.g. "re-weigh when
`book.reckoner.petitions.updated` fires for this petition"). At least
one of `deferUntil` and `deferSignal` is populated on a deferred row
in normal operation; both being empty is allowed for the rare
`other`-reason hold but should produce a `deferNote` for the audit
trail.

`deferCount`, `firstDeferredAt`, and `lastDeferredAt` are running
counters: each new deferral on the same petition increments
`deferCount` and refreshes `lastDeferredAt`, while
`firstDeferredAt` is preserved across deferrals as the petition's
first-seen-as-deferred timestamp. The Reckoner reads the prior
Reckonings row for the petition to compute the running counter; the
journal is its own source of truth for the deferral history.

### Acceptance metadata

A row with `outcome: 'accepted'` carries:

- `writId` — the Clerk writ id the Reckoner created on acceptance.
  This is a forward link into the rig pipeline; the writ flows
  through Distiller → Sage → Artificer the same as any patron-posted
  commission.
- `acceptedAt` — ISO timestamp of the acceptance, distinct from
  `consideredAt` only in the patron-fast-path case where the
  acceptance happens outside a tick. In the normal case the two are
  identical.

---

## No-op Handling

**Every consideration produces a row, including no-ops.** The
Reckoner does not silently drop a tick where it weighed a petition
without producing a transition.

The single-audit-trail-truth argument is the rationale: a petitioner
asking "did the Reckoner ever look at me?" should get the answer from
one query against the Reckonings book, not from a join across the
petition-state book and the events book and a heuristic. Splitting
the journal into "considered with state change" and "considered
without state change" — keeping the second set in some sibling
overlay or reconstructing it from the clockworks.timer stream — would
duplicate the journaling work, complicate every consumer query, and
push reasoning about completeness onto callers.

The journal is the audit trail; the petition-state book is not asked
to double as event journal.

### No-op records carry the same projection as state-transition records

A no-op row carries `source` and `urgency` exactly like every other
outcome — same lean snapshot, same tick stamp, same `consideredAt`.
The modest byte savings of a stripped no-op shape don't justify
branching the read path for every consumer query: filters like "since
T, all considerations of urgent petitions" must work uniformly across
all four outcomes, and the index that supports that filter
(`urgency`-keyed, paired with `consideredAt` in the compound
`['outcome', 'consideredAt']`) needs every row to be the same shape.

This uniformity also keeps the discriminated-union consumer type
clean: no fork between "full record" and "stub record"; the
discriminant is `outcome`, and the optional reason fields default to
absent.

---

## Retention

**Append-only forever.** The Reckonings book has no rolling-window
default, no built-in archival relay, no prune job. Every consideration
the Reckoner ever weighs persists until an explicit operator action
removes it.

This matches the sibling event-log books — `clockworks/events`,
`clockworks/event_dispatches`, `lattice/pulses`,
`animator/sessions`, `animator/transcripts` all default to unbounded
growth. The lattice-apparatus and animator-apparatus docs both name
retention as a future commission with no current trigger; the
Reckonings book inherits the same stance.

A rolling-window default would silently lose audit history. The
journal's load-bearing job is "show me everything that ever happened
to this petition" — a 90-day window quietly drops the row a
post-mortem six months later needs.

### Storage-growth math

The worst-case ceiling, based on the settled v0 cadence and a
representative pending-set size:

```
1 tick / minute  ×  10 petitions weighed per tick  ×  365 days
  = 5,256,000 rows / year
  ≈ 2.5 GB / year   at  ~500 bytes / row (lean projection)
  ≈ 10.5 GB / year  at  ~2 KB  / row (with full deferral metadata)
```

SQLite handles 5M-row tables cleanly with the indexes declared below
— primary-key lookups stay sub-millisecond, the indexed range scans
on `consideredAt` and the per-petition timeline use the compound
indexes directly, and table size at this magnitude is well within the
Animator's transcripts-book scale (~30–300 MB / day) that the same
substrate is already exercised at.

The math shows we are not in trouble. It also identifies the
trip-wires that warrant revisiting: a 10× cadence, a 10× pending-set
size, or a sustained 6-month measurement that diverges materially
from this projection. The trip-wires belong in Open Questions, not
in the v0 retention design.

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
| **Per-petition timeline** — show every consideration of petition X, oldest first | `petitionId = X` ORDER BY `consideredAt asc` | `['petitionId', 'consideredAt']` |
| **Since-T sweep** — every Reckonings row produced since timestamp T | `consideredAt >= T` | `consideredAt` |
| **Decline-by-reason audit** — every petition declined for reason R | `outcome = 'declined' AND declineReason = R` | `declineReason` (with the `outcome` filter narrowing the candidate set further) |
| **Per-source filtering** — every consideration of petitions emitted by source S | `source = S` (optionally + `consideredAt`) | `source` |
| **Recent-by-outcome** — most recent N rows for outcome O | `outcome = O` ORDER BY `consideredAt desc` | `['outcome', 'consideredAt']` |
| **Urgency-filtered timeline** — recent considerations of urgent petitions | `outcome = O AND consideredAt >= T` (with in-process urgency narrow), or via the same compound | `['outcome', 'consideredAt']` |
| **Outcome-only filter** — count or list rows by outcome | `outcome = O` | `outcome` |

### Declared index set

```typescript
indexes: [
  'petitionId',
  'consideredAt',
  'outcome',
  'source',
  'declineReason',
  ['outcome', 'consideredAt'],
  ['petitionId', 'consideredAt'],
]
```

Tracing each entry back to the queries it supports:

- **`petitionId`** — bare-key existence checks ("does any row exist
  for this petition?") and the foreign-key style join from the
  petition-state book; superseded for ordered timelines by
  `['petitionId', 'consideredAt']`.
- **`consideredAt`** — the unconditional since-T sweep, used by
  recent-history surfaces (Oculus pages, the future Sentinel
  apparatus's archival selector, vision-keeper's "what changed since
  my last poll" check).
- **`outcome`** — outcome-only filters and counts; standalone for
  uses that don't need a time bound.
- **`source`** — per-source audit (every consideration of petitions
  from a single petitioner). The petitioners-registration commission
  will likely want to surface this as part of an operator's
  per-petitioner page.
- **`declineReason`** — the decline-by-reason audit. The flat
  schema layout (D10) is what makes this an indexable top-level
  field; a nested `reason: { … }` would not.
- **`['outcome', 'consideredAt']`** — recent-by-outcome compound,
  serving the most common dashboard query: "what did the Reckoner
  decide in the last hour, grouped by outcome." The leading
  `outcome` column is low-cardinality (4 values), so this index
  doubles as a fast histogram input.
- **`['petitionId', 'consideredAt']`** — per-petition timeline
  ordering without a re-sort. Critical for the petitioner-side "show
  me my petition's full history" view.

`urgency` is not indexed in v0. It is filterable in-process from any
of the time-or-outcome-led results, and the dashboards currently
described do not lead with urgency. If a future query shape leads
with `urgency` (e.g. an Oculus widget that sweeps "every immediate
petition the Reckoner has ever weighed"), adding `urgency` or the
compound `['urgency', 'consideredAt']` is the natural follow-up.

`tickEventId` is similarly not indexed. The expected access pattern
is "look up the Reckonings row by id, then walk to the tick" — not
"find every row produced by tick T," which is rare and tolerates the
full scan or a join through `consideredAt`. Adding the index later
costs one schema migration and earns its keep only if the access
pattern changes.

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
- The reason metadata is derived from the petition state at the
  moment of consideration; a later re-evaluation produces a new row,
  not a patch on the old one.
- The `writId` for an accepted petition does not change.
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
passed through verbatim by the Clockworks CDC bridge (see
[clockworks.md → Book change events](clockworks.md#book-change-events-stacks-auto-wiring)
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

The Clockworks apparatus carves `clockworks/events` itself out of CDC
auto-wiring because a watcher on the events book would observe its
own emit and re-emit forever — see
[clockworks.ts: auto-wiring carve-out](../../packages/plugins/clockworks/src/clockworks.ts).
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

## Journal vs. Materialized View

The Reckoner ecosystem uses two books with deliberately different
grains:

| Book                          | Role                | Grain                                        |
|-------------------------------|---------------------|----------------------------------------------|
| `reckoner/petitions` (separate commission) | Materialized view   | One row per petition, current state, fast lookup |
| `reckoner/reckonings` (this doc) | Event journal       | One row per consideration, full history       |

**The two CDC channels are not duplicative.** They differ in grain:

- `book.reckoner.petitions.{created,updated,deleted}` fires on
  state-transitions of a petition. A subscriber wiring to
  `book.reckoner.petitions.updated` and filtering on
  `event.entry.state === 'accepted'` sees the **state-of-the-world**
  change at the moment of acceptance, but does not see the
  Reckoner's repeated weighings of that same petition while it was
  pending or deferred.
- `book.reckoner.reckonings.created` fires on every consideration —
  state-changing or not. A subscriber wiring here sees the
  **decision history** of every petition the Reckoner has weighed.

Asking the petition-state book to double as a journal would force an
O(n) scan of every petition row to reconstruct deferral history, and
would fail entirely for no-op considerations that produced no
state-transition row to scan.

Asking the journal to double as a materialized view would force every
"what is the current state of petition X?" query to walk the journal
backward looking for the most recent terminal row. The petition row
has its own state machine and its own metadata (deferral counters,
strategic-ref, withdraw-trigger handles); it is **not** merely
derived from the journal.

The two books exist together. Petitioners that want "act on every
state transition" subscribe to the petitions CDC channel.
Petitioners that want "audit every consideration" subscribe to the
reckonings CDC channel. Most petitioners only need the first. The
journal is the second.

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
| `animator/sessions` + `animator/transcripts` | **One book, not two.** Sessions is lean, transcripts is heavy; Reckonings keeps the lean half and has no heavy-blob sibling. | The petition's `intent`, `rationale`, and `context_anchors` live on the petition row, not on the journal. The journal stays at the lean-record scale. |
| `clockworks/event_dispatches` | **No per-handler dispatch log.** event_dispatches is a sibling to events recording one row per handler invocation; Reckonings has no per-handler concept. | Petitioner subscribers run as ordinary Clockworks standing orders against the auto-wired CDC event, so the dispatch log they produce already lives in `clockworks/event_dispatches`. A second per-handler log on the Reckonings side would duplicate that. |

The dual-table pattern (events + event_dispatches) was considered as a
shape for the Reckoner — one table for petitions weighed, a second
for "what each petitioner did about it." It was rejected on the same
grounds: petitioner reactions are Clockworks standing orders, and the
existing `event_dispatches` book already records one row per
invocation. Adding a Reckoner-owned dispatch log would re-implement a
sibling apparatus's load-bearing data.

---

## Open Questions

The four items this design intentionally leaves for follow-on
resolution.

- **Petitioner registration.** A parallel commission
  (`docs/architecture/petitioner-registration.md`) is in flight and
  will define how a petitioner declares itself to the Reckoner — the
  registration contract, the per-source policy block, the source-id
  validator. This Reckonings doc names the auto-wired event surface
  registration will plug into (`book.reckoner.reckonings.created`,
  with the registered petitioner's standing order filtering on
  `outcome` and `source`), but does **not** specify the registration
  shape. When the registration commission lands, the per-source
  filtering convention should be cross-referenced from here.

- **Retention trip-wires.** v0 ships append-only forever with the
  storage-growth math above. The trip-wires that warrant a future
  retention-design commission are concrete:
  1. A Sentinel or Laboratory archival sink lands and an operator
     wants to point an archival relay at it.
  2. An operator complains about Reckonings book size or about
     Stacks query latency on the per-petition timeline query.
  3. Six months of production-growth measurement validates the
     5.26M rows / year projection (or, more interestingly, refutes
     it by 2× or more in either direction).
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
  stay in the renamed sibling. The Reckonings book is unaffected either way —
  the queue-observer's pulses go to the Lattice, not to the
  Reckonings book — but the conceptual seam between "petition
  evaluation" and "writ-lifecycle observation" wants to be settled
  before the new Reckoner core ships.

- **When named events earn their keep.** D8 rejects a named-events
  emission surface (`reckoning.accepted`, `reckoning.deferred`, etc.)
  on the grounds that auto-wiring + a one-line in-relay outcome
  filter serves every consumer auto-wiring can serve. The conditions
  under which named events earn their keep:
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

- [docs/architecture/clockworks.md](clockworks.md) — the CDC
  auto-wiring contract and the reserved-namespace policy.
- [docs/architecture/apparatus/lattice.md](apparatus/lattice.md) —
  the closest schema precedent for a Reckonings record.
- [docs/architecture/apparatus/animator.md](apparatus/animator.md)
  — the lean-record / heavy-blob book split (the alternative
  considered and rejected here).
- [docs/architecture/apparatus/reckoner.md](apparatus/reckoner.md)
  — the new petition-scheduling Reckoner whose contract surface
  this book layers on top of.
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
