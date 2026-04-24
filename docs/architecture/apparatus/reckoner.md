# The Reckoner — API Contract

Status: **Draft**

Package: `@shardworks/reckoner-apparatus` · Plugin id: `reckoner`

> **⚠️ MVP scope.** MVP ships three trigger types (`writ-stuck`,
> `writ-failed`, `queue-drained`), roots-only scoping, and the
> clockworks-retry soft dependency. Every other Reckoner-style trigger
> (`needs-review`, anima completion, coinmaster alerts, …) is out of scope.

---

## Purpose

The Reckoner is a narrow observer: a Phase 2 CDC watcher on `clerk/writs`
that emits Lattice pulses when a *commission* stalls, fails, or when the
guild's work queue drains. It turns the Clerk's phase-transition events into
the first three observer-emitted pulses on the Lattice substrate.

The Reckoner does **not** decide how pulses are delivered; that is the
Lattice's job. It does not modify writs, does not inspect rig internals, and
does not interact with Spider's dispatch path. It reads two books
(`clerk/writs` and `spider/rigs`) and writes one API (`LatticeApi.emit`).

The Reckoner is install-only configurable: there is no `guild.json` section
for it. Install turns it on, uninstall turns it off. Decisions about *which*
pulses get delivered live on the Lattice's channel-configuration side, not
here.

---

## Dependencies

```
requires:   ['clerk', 'lattice', 'stacks']
recommends: ['spider', 'clockworks-retry', 'oculus']
```

- **The Clerk** (required) — source of writ transitions the Reckoner
  watches.
- **The Lattice** (required) — consumer of every pulse the Reckoner emits.
- **The Stacks** (required) — CDC substrate plus the rigs book the
  Reckoner reads for cap evaluation and drain counts.
- **Spider** (recommended) — owner of the `rigs` book. When Spider is
  absent the rig counts resolve to zero, `isQueueDrained` degrades
  gracefully, and retry-cap evaluation falls back to the fail-safe
  `isTerminalStuck` path.
- **Clockworks-retry** (recommended) — source of the `maxAttempts` cap. The
  soft-dependency resolution is described below.
- **Oculus** (recommended) — future patron-facing surface for pulse
  inspection.

---

## Kit Interface

The Reckoner consumes no kit contributions. It exposes a narrow
`ReckonerApi` (`source`, `triggerTypes`) for surfaces that want to list what
this observer emits, but has no extensibility hooks.

---

## Support Kit

None — the Reckoner contributes no books, no tools, and no pages. Its
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
| `reckoner.writ-stuck` | root writ id | root writ enters `stuck` and the stuck is terminal non-success (see predicate). |
| `reckoner.writ-failed` | root writ id | root writ enters `failed`. |
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
  retryable?: boolean;
  detail?: string;
}

interface WritFailedContext {
  writShortId: string;
  writTitle: string;
  writType: string;
  writUpdatedAt: string;      // dedupe identity — see "Idempotency under replay"
  resolution?: string;        // the writ's resolution text
  childFailures?: string[];   // parsed short-ids of cascaded leaf causes
}

interface QueueDrainedContext {
  drainedAt: string;
  lastTerminalWritId: string;
  writUpdatedAt: string;      // dedupe identity — see "Idempotency under replay"
}
```

---

## Predicate: terminal non-success stuck (D2)

A stuck transition is pulse-worthy only when clockworks-retry will not
requeue the writ. Equivalently, the stuck is *terminal non-success* when:

- `status.spider.retryable !== true` (definitional non-retryable OR missing
  flag — clockworks-retry's fail-safe: stay stuck), OR
- the rigs-for-writ count is at or above the clockworks-retry cap.

Formally:

```typescript
function isTerminalStuck(
  spiderStatus: SpiderStuckStatus | undefined,
  rigCount: number,
  maxAttempts: number | undefined,
): boolean {
  if (maxAttempts === undefined) return true;       // no retry installed
  if (spiderStatus?.retryable !== true) return true;
  if (rigCount >= maxAttempts) return true;
  return false;
}
```

The `maxAttempts` argument resolves to `clockworksRetryApi?.maxAttempts` at
emit time. When clockworks-retry is not installed, `maxAttempts` is
`undefined`, and every stuck is terminal from the Reckoner's viewpoint —
there is no retry to rescue the writ, so a pulse is the correct behavior.

This predicate is the **complement** of clockworks-retry's requeue
condition. A transient stuck that clockworks-retry will flip back to `open`
produces zero pulses, exactly as brief-section D2 prescribes.

---

## Roots-only scoping (D23)

Only writs with no `parentId` emit their own stuck / failed pulses. Child
writs transitioning to stuck or failed do **not** produce per-child pulses
— the Clerk's upward cascade re-writes the parent's resolution as
`Child "<child id>" failed: <child resolution>`, and the Reckoner parses
that string on the parent's emission to surface the leaf cause in the
pulse's `summary` and `context.childFailures`.

Net effect: one commission produces at most one pulse per trigger, no
matter how deep the child tree is.

The drain check (below) is exempt from roots-only. It runs on every
terminal transition — including child transitions — because a child
completion can genuinely drain the queue.

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

## Soft clockworks-retry dependency (D16)

The Reckoner reads `maxAttempts` via `guild().apparatus('clockworks-retry')`.
Because `apparatus(name)` throws when the apparatus is not installed, the
resolver catches the error and returns `undefined`:

```typescript
function resolveMaxAttempts(): number | undefined {
  try {
    const api = guild().apparatus<MaxAttemptsApi>('clockworks-retry');
    return api?.maxAttempts;
  } catch {
    return undefined;
  }
}
```

Duplicating the cap constant would split the source of truth; reading the
constant from the API keeps it exactly where clockworks-retry declares it.

---

## Phase 2 watcher — why

```typescript
stacks.watch<WritDoc>('clerk', 'writs', handler, { failOnError: false });
```

- `failOnError: false` — a pulse is a layered notification. A failure here
  must not void the underlying writ transition.
- Post-commit — at emit time the Reckoner may read the same writs book
  the Clerk just committed to (to look up siblings, to count active rigs,
  etc.). Running inside the triggering transaction would re-enter the CDC
  dispatch and risk recursion.

---

## Startup behavior (D27)

No backfill. The Reckoner fires on transitions only. Restarting a guild
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

Every Reckoner context payload (`WritStuckContext`, `WritFailedContext`,
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

The guard is **emitter-local**: it lives inside the Reckoner observer
and reads the pulses book directly rather than changing the Lattice's
`EmitPulseRequest` contract. The Reckoner is the only pulse emitter
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
Reckoner itself; trigger-gating belongs on the Lattice's delivery side
(future channel-filter work).

---

## Failure Behaviour Matrix

| Situation | Effect |
|-----------|--------|
| Emit call throws | Swallowed by the Phase 2 watcher (`failOnError: false`); writ transition is unaffected. |
| Rigs book missing (Spider absent) | `readBook` returns a zero-count handle; stuck predicate still evaluates (falls through via maxAttempts path); drain predicate returns `open=0 AND activeRigs=0` whenever there are no open writs. |
| Clockworks-retry absent | `resolveMaxAttempts` returns `undefined`; every stuck is terminal; `reckoner.writ-stuck` always fires on root stuck transitions. |

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
  Reckoner today, and any future emitter — for idempotency before
  loosening the invariant. When a second emitter appears, promoting
  the emitter-local guard into `LatticeApi.emit` (via an explicit
  `EmitPulseRequest` idempotency key) is the natural follow-up.

---

## Implementation Notes

- The Reckoner re-declares a narrow `SpiderStuckStatus` type locally
  rather than importing from `@shardworks/spider-apparatus`. Spider is a
  recommend, not a require; this keeps the dependency direction one-way.
- Drain detection uses `isQueueDrained(writs, rigs)`, which issues two
  `count` queries in parallel and returns a boolean. The parallelism keeps
  the per-transition overhead small.
