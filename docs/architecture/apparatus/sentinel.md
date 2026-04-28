# The Sentinel — API Contract

Status: **Draft**

Package: `@shardworks/sentinel-apparatus` · Plugin id: `sentinel`

> **Note on legacy strings.** Historical artefacts in this
> apparatus's source still carry the literal string `'reckoner'` —
> `RECKONER_PLUGIN_ID`, the trigger ids `reckoner.writ-stuck` /
> `reckoner.writ-failed` / `reckoner.queue-drained`, the
> persisted `pulse.source` values — because those strings are
> baked into Lattice channel configurations and on-disk pulse
> rows. Renaming them ripples into operator `guild.json` files,
> so the rename is deferred to a separate scoped commission. The
> apparatus's plugin id (derived from the npm package name) is
> `sentinel`; the new `reckoner` plugin id is held by the
> petitioner-scheduler apparatus at [reckoner.md](reckoner.md).

> **⚠️ MVP scope.** MVP ships three trigger types (`writ-stuck`,
> `writ-failed`, `queue-drained`) and roots-only scoping. Every other
> Sentinel-style trigger (`needs-review`, anima completion, coinmaster
> alerts, …) is out of scope.

---

## Purpose

The Sentinel is a narrow observer: a Phase 2 CDC watcher on `clerk/writs`
that emits Lattice pulses when a *commission* stalls, fails, or when the
guild's work queue drains. It turns the Clerk's phase-transition events into
the first three observer-emitted pulses on the Lattice substrate.

The Sentinel does **not** decide how pulses are delivered; that is the
Lattice's job. It does not modify writs, does not inspect rig internals, and
does not interact with Spider's dispatch path. It reads two books
(`clerk/writs` and `spider/rigs`) and writes one API (`LatticeApi.emit`).

The Sentinel is install-only configurable: there is no `guild.json` section
for it. Install turns it on, uninstall turns it off. Decisions about *which*
pulses get delivered live on the Lattice's channel-configuration side, not
here.

---

## Dependencies

```
requires:   ['clerk', 'lattice', 'stacks']
recommends: ['spider', 'oculus']
```

- **The Clerk** (required) — source of writ transitions the Sentinel
  watches.
- **The Lattice** (required) — consumer of every pulse the Sentinel emits.
- **The Stacks** (required) — CDC substrate plus the rigs book the
  Sentinel reads for drain counts.
- **Spider** (recommended) — owner of the `rigs` book consulted by the
  drain predicate. When Spider is absent the rig counts resolve to zero,
  so `isQueueDrained` reduces to `open == 0`.
- **Oculus** (recommended) — future patron-facing surface for pulse
  inspection.

---

## Kit Interface

The Sentinel consumes no kit contributions. It exposes a narrow
`ReckonerApi` (`source`, `triggerTypes`) — name retained from the
pre-rename source for now — for surfaces that want to list what
this observer emits, but has no extensibility hooks.

---

## Support Kit

None — the Sentinel contributes no books, no tools, and no pages. Its
effect on the guild is purely the pulses it writes to the Lattice.

---

## `ReckonerApi` Interface (`provides`)

```typescript
interface ReckonerApi {
  /** Emitter plugin id stamped onto `pulse.source`. Always `'reckoner'`. */
  readonly source: string;
  /** The three trigger types this observer produces. */
  readonly triggerTypes: readonly string[];
}
```

### Trigger types

| Trigger | `writId` | Emitted on |
|---------|----------|-----------|
| `reckoner.writ-stuck` | root writ id | root writ enters `stuck`. |
| `reckoner.writ-failed` | root writ id | root writ enters `failed`. When the failure originated in an engine retry-budget exhaustion, the pulse's context carries an additional `engineFailure` block (see "Engine-failure enrichment" below). |
| `reckoner.queue-drained` | `null` | any terminal writ transition that brings the guild to `open = 0 AND active rigs = 0`. |

### Context payloads (D30)

Each trigger emits a typed `context` payload. Channels use these to render
richer notifications without having to re-parse the summary.

```typescript
interface WritStuckContext {
  writShortId: string;   // `w-abc123`
  writPhase: 'stuck';
  writTitle: string;
  writType: string;
  writUpdatedAt: string;      // dedupe identity — see "Idempotency under replay"
  stuckCause?: string;        // from status.spider
}

interface WritFailedContext {
  writShortId: string;
  writTitle: string;
  writType: string;
  writUpdatedAt: string;      // dedupe identity — see "Idempotency under replay"
  resolution?: string;        // the writ's resolution text
  childFailures?: string[];   // chase-chain of cascaded leaf-cause short ids
                              // (outer→inner; populated from status['clerk'])
  engineFailure?: EngineFailureContext; // engine-failure enrichment (see below)
}

interface EngineFailureContext {
  rigId: string;              // the rig whose failed engine produced this enrichment
  engineId: string;           // engine instance id within the rig (e.g. 'implement')
  engineDesignId: string;     // engine design id — the Fabricator design key
  attemptCount?: number;      // retry budget consumed by the failed engine
  lastError?: string;         // tail attempt's `error` string when status === 'failed'
  attemptsSummary: EngineAttemptSummary[]; // ordered per-attempt summary (yields dropped)
}

interface EngineAttemptSummary {
  startedAt?: string;         // ISO timestamp when the attempt started
  endedAt?: string;           // ISO timestamp when the attempt terminated
  status?: 'completed' | 'failed';
  error?: string;             // error message if `status === 'failed'`
  sessionId?: string;         // Animator session id, if any
  // (yields are intentionally dropped — pulse is a diagnostic surface, not an audit log)
}

interface QueueDrainedContext {
  drainedAt: string;
  lastTerminalWritId: string;
  writUpdatedAt: string;      // dedupe identity — see "Idempotency under replay"
}
```

---

## Engine-failure enrichment on `writ-failed`

When a root mandate enters `failed` because Spider's engine-retry path
exhausted its budget, the pulse's context carries an additional
`engineFailure` block populated from the rigs book. The block surfaces
the failed engine's identity, retry counter, last attempt error, and a
per-attempt history summary so the patron can identify the failed engine
and read the attempt trail without dropping into `nsg rig show`.

The lookup is a separate resolver module (`engine-context.ts`) called
from the writ-failed emit path after the dedupe guard and before
`lattice.emit()`. It queries the rigs book for the most-recent failed
rig keyed to the writ (`status='failed'` ordered by `createdAt desc`,
`limit 1`), scans the rig's `engines` array for the first engine in
`status='failed'`, and assembles the `EngineFailureContext`. When the
writ has no rig, the rig is not failed, or no engine on the rig is
failed (patron-driven failure, cascade-only failure), the resolver
returns `undefined` and the pulse emits with the legacy `WritFailedContext`
shape unchanged.

The resolver **never throws** past the boundary — book-read errors are
caught and surfaced as `undefined`, preserving the Phase 2 watcher's
`failOnError: false` semantics.

The dedupe identity for `reckoner.writ-failed` is unchanged
(`(writId, triggerType, writUpdatedAt)`); the enrichment widens the
context payload but does not affect idempotency.

The Sentinel re-declares narrow `RigRow` / `EngineInstance` /
`EngineAttempt` row shapes locally rather than importing from
`@shardworks/spider-apparatus`, mirroring the existing
`ClerkChildCascadeStatus` precedent. Spider remains a `recommend`, not
a `require`.

The enrichment is failed-only: `reckoner.writ-stuck`,
`reckoner.queue-drained`, and any other trigger are never enriched
with engine context. Stuck transitions in the post-reshape model carry
no engine-failure information; adding fields with no producer is
structure with no consumer.

---

## Roots-only scoping (D23)

Only writs with no `parentId` emit their own stuck / failed pulses. Child
writs transitioning to stuck or failed do **not** produce per-child pulses
— the Clerk's children-behavior cascade engine drives the parent's
terminal transition, and the parent's pulse surfaces the leaf cause via
the chase-chain mechanism described below.

Net effect: one commission produces at most one pulse per trigger, no
matter how deep the child tree is.

The drain check (below) is exempt from roots-only. It runs on every
terminal transition — including child transitions — because a child
completion can genuinely drain the queue.

### Leaf-cause chase-chain

The Clerk's children-behavior cascade engine writes a structured record
onto the parent's Clerk-owned status sub-slot
(`status['clerk'].triggeringChildId`) before each cascaded transition.
The slot carries the *immediate* triggering child id — exactly the writ
whose terminal transition fired the cascade onto this parent.

At emit time, the Sentinel walks the chain by reading each successive
writ's own `status['clerk'].triggeringChildId`: starting from the pulse's
writ, it follows the slot down through one or more cascaded ancestors
until a writ has no triggeringChildId. The terminating writ is the leaf
cause; the resulting ordered list of short ids is what populates
`WritFailedContext.childFailures` and the "Originated from child …"
fragment in the pulse summary (for both `writ-stuck` and `writ-failed`
pulses).

Cascade depth is bounded by the Stacks `MAX_CASCADE_DEPTH = 16` invariant.
The chase-chain walk is bounded above that cap defensively (a corrupt
forward-cycle in the slot graph would otherwise be unbounded), but a
legitimate cascade is never truncated.

---

## Drain predicate (D7)

```typescript
isQueueDrained = (writsCount('phase = open') === 0)
                  AND (rigsCount('status IN (running, blocked)') === 0)
```

Stuck writs are intentionally excluded: retryable stucks flip back to
`open` within one retry tick (so would count as still-runnable in one
reading but not the other), and terminal stucks are effectively drained
from the auto-dispatcher's viewpoint. The simple two-count definition
mirrors Spider's `trySpawn` filter without reimplementing it.

There is intentionally **no dedupe across bursts** in MVP. If multiple
terminal transitions land in rapid succession and each sees the drain
condition, each will emit. The accepted cost is documented here and in the
brief's primer observations.

---

## Phase 2 watcher — why

```typescript
stacks.watch<WritDoc>('clerk', 'writs', handler, { failOnError: false });
```

- `failOnError: false` — a pulse is a layered notification. A failure here
  must not void the underlying writ transition.
- Post-commit — at emit time the Sentinel may read the same writs book
  the Clerk just committed to (to look up siblings, to count active rigs,
  etc.). Running inside the triggering transaction would re-enter the CDC
  dispatch and risk recursion.

---

## Startup behavior (D27)

No backfill. The Sentinel fires on transitions only. Restarting a guild
with pre-existing stuck or failed writs does not double-ping — the CDC
watcher observes transitions, not state snapshots.

---

## Idempotency under replay

The Phase 2 observer is idempotent under same-transition replay: a
duplicated CDC delivery of the same writ transition produces at most
one pulse row per trigger type, and the guarantee survives a process
restart.

### Dedupe identity

Every Clerk transition bumps the writ's `updatedAt`, so
`(writId, triggerType, writUpdatedAt)` is a true per-transition
identity. A CDC replay fires with the same `updatedAt` and is
suppressed; a legitimate re-visit of the same phase pair (e.g. stuck →
open → stuck) carries a fresh `updatedAt` and produces a fresh pulse.

For `reckoner.queue-drained` — which is not scoped to a single writ
(its `pulse.writId` is `null`) — the identity is
`(triggerType = reckoner.queue-drained, writId = null,
lastTerminalWritId, writUpdatedAt)`, where `writUpdatedAt` is the
triggering terminal writ's own `updatedAt` at evaluation time.

Every Sentinel context payload (`WritStuckContext`, `WritFailedContext`,
`QueueDrainedContext`) carries a `writUpdatedAt` field that records the
identifying timestamp so the guard can re-check it after a restart.

### Persisted lookup

Before each `lattice.emit()`, the observer queries the persisted
`lattice/pulses` book for a prior pulse matching the identity above. The
lookup narrows on the already-indexed columns (`writId`, `triggerType`)
and filters the handful of candidates in-process on the `writUpdatedAt`
field inside `pulse.context`. No new index is required.

Because the check hits the persisted book rather than an in-memory set,
a restart that replays the same transition still finds the prior pulse
and suppresses the duplicate.

### Scope

The guard is **emitter-local**: it lives inside the Sentinel observer
and reads the pulses book directly rather than changing the Lattice's
`EmitPulseRequest` contract. The Sentinel is the only pulse emitter
today; promoting the check into `LatticeApi.emit` is a follow-up to be
earned when a second emitter appears.

The guard runs strictly **after** the existing predicate gating
(roots-only, `isTerminalStuck`, drain predicate). The predicates decide
whether a transition is pulse-worthy in principle; the guard decides
whether this particular delivery of a pulse-worthy transition has
already been handled.

### Cross-apparatus contract

This invariant depends on the Stacks' Phase 2 exactly-once delivery
contract for coalesced post-commit events. Any future relaxation on the
Stacks side (at-least-once delivery, durable outbox, etc.) must audit
downstream pulse emitters for idempotency before loosening the
guarantee. The Stacks apparatus doc carries a matching note.

---

## Configuration

None. The brief's D12 explicitly rules out a configuration surface on the
Sentinel itself; trigger-gating belongs on the Lattice's delivery side
(future channel-filter work).

---

## Failure Behaviour Matrix

| Situation | Effect |
|-----------|--------|
| Emit call throws | Swallowed by the Phase 2 watcher (`failOnError: false`); writ transition is unaffected. |
| Rigs book missing (Spider absent) | `readBook` returns a zero-count handle; the drain predicate reduces to `open == 0 AND active rigs == 0` with `active rigs == 0` trivially satisfied. |

---

## Open Questions

- **Drain dedupe.** Burst-induced duplicate drain pulses are an accepted
  MVP cost. A future commission may add a short suppressive window.
- **`reckoner.writ-cancelled`.** Patron-initiated cancellations currently
  produce no pulse. If this proves a gap in practice, adding the fourth
  trigger is a straightforward follow-up.
- **Idempotency as a cross-apparatus contract.** The "Idempotency under
  replay" invariant (exactly one pulse row per
  `(writId, triggerType, writUpdatedAt)` identity, persisted across
  restart) depends on the Stacks' Phase 2 exactly-once delivery
  contract for coalesced post-commit events. A future Stacks change
  that relaxes this (at-least-once, durable outbox, shared-process
  distribution, etc.) must audit downstream pulse emitters — the
  Sentinel today, and any future emitter — for idempotency before
  loosening the invariant. When a second emitter appears, promoting
  the emitter-local guard into `LatticeApi.emit` (via an explicit
  `EmitPulseRequest` idempotency key) is the natural follow-up.

---

## Implementation Notes

- The Sentinel reads `writ.status?.spider` through an inline narrow cast
  (`as { stuckCause?: string }`) at the single read site rather than
  naming a shared type. Spider is a recommend, not a require; the inline
  cast keeps the dependency direction one-way.
- The Sentinel re-declares a narrow `ClerkChildCascadeStatus` shape
  locally (`{ triggeringChildId?: string }`) and reads
  `writ.status?.clerk` through that type. This mirrors the Spider
  precedent — writer-owned shape, consumer-side narrow re-declaration —
  rather than depending on a Clerk type re-export.
- Drain detection uses `isQueueDrained(writs, rigs)`, which issues two
  `count` queries in parallel and returns a boolean. The parallelism keeps
  the per-transition overhead small.
