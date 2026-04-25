# `@shardworks/reckoner-apparatus`

The Reckoner — a narrow observer that emits Lattice pulses when a
root writ stalls, fails, or when the guild's work queue drains. It is the
first consumer of the Lattice substrate: a Phase 2 CDC watcher on
`clerk/writs` that emits three trigger types.

See also: [`docs/architecture/apparatus/reckoner.md`](../../../docs/architecture/apparatus/reckoner.md).

---

## Installation

```sh
pnpm add @shardworks/reckoner-apparatus
```

Register the apparatus in `guild.json`:

```json
{
  "plugins": [
    "@shardworks/lattice-apparatus",
    "@shardworks/reckoner-apparatus"
  ]
}
```

The Reckoner has no configuration surface. Install turns it on; uninstall
turns it off.

---

## API

```typescript
interface ReckonerApi {
  readonly source: string;               // always 'reckoner'
  readonly triggerTypes: readonly string[];
}
```

Most callers do not need to touch `ReckonerApi` — the Reckoner runs
autonomously via CDC. The API exists so surfaces (list views, dashboards)
can enumerate the trigger types the Reckoner emits.

### Trigger types

| Trigger | `writId` | Emitted on |
|---|---|---|
| `reckoner.writ-stuck` | root writ id | root writ enters `stuck` and the stuck is terminal non-success. |
| `reckoner.writ-failed` | root writ id | root writ enters `failed`. |
| `reckoner.queue-drained` | `null` | any terminal writ transition that brings the guild to `open = 0 AND active rigs = 0`. |

### Context payloads

Each trigger emits a typed `context` payload on the pulse:

```typescript
interface WritStuckContext {
  writShortId: string;   // `w-abc123`
  writPhase: 'stuck';
  writTitle: string;
  writType: string;
  writUpdatedAt: string; // dedupe identity (see "Idempotency under replay")
  stuckCause?: string;
  retryable?: boolean;
  detail?: string;
}

interface WritFailedContext {
  writShortId: string;
  writTitle: string;
  writType: string;
  writUpdatedAt: string; // dedupe identity
  resolution?: string;
  childFailures?: string[]; // chase-chain of cascaded leaf-cause short ids
                            // (outer→inner; populated from status['clerk'])
}

interface QueueDrainedContext {
  drainedAt: string;
  lastTerminalWritId: string;
  writUpdatedAt: string; // dedupe identity — triggering writ's updatedAt
}
```

Channels (e.g. the Discord kit) use these payloads to render richer
notifications without having to re-parse the pulse's plain-text summary.
The `writUpdatedAt` field records the triggering transition's `updatedAt`
stamp so the emitter's idempotency guard can detect same-transition
replays (see "Idempotency under replay" below).

---

## Dependencies

- **Required:** `@shardworks/clerk-apparatus`, `@shardworks/lattice-apparatus`, `@shardworks/stacks-apparatus`.
- **Recommended:** `@shardworks/clockworks-retry-apparatus` — the Reckoner reads
  `maxAttempts` from the retry apparatus's API to decide whether a stuck is
  terminal. When clockworks-retry is absent, every stuck is terminal from
  the Reckoner's viewpoint.
- **Recommended:** `@shardworks/spider-apparatus` — the Reckoner reads
  `spider/rigs` for retry-cap evaluation and drain counts. Without Spider
  the rig counts resolve to zero and the Reckoner still emits
  correctly-shaped pulses.

---

## Behavior

- **Roots-only.** Child-writ transitions never emit their own pulses;
  the Clerk's children-behavior cascade engine lifts the parent into its
  own terminal state and records the immediate triggering child id under
  `status['clerk'].triggeringChildId` before each cascaded transition.
  At emit time the Reckoner walks the chain by reading each successive
  writ's own `status['clerk']` slot until it reaches a writ without one
  (the leaf), and surfaces the resulting ordered short-id list in the
  parent pulse's `childFailures` context field plus an "Originated from
  child …" fragment in the summary.
- **Phase 2 CDC.** The observer runs post-commit with `failOnError: false`:
  a pulse failure never voids the underlying writ transition.
- **No startup backfill.** The Reckoner fires on transitions only.
  Restarting a guild with pre-existing stuck / failed writs does not
  produce pulses for them.
- **No dedupe on drain.** Multiple terminal transitions in rapid
  succession may each emit a drain pulse. This is an accepted MVP cost.
- **Idempotent under replay.** Every emission site is routed through a
  persisted-lookup guard: before each `lattice.emit()` the observer
  queries the `lattice/pulses` book for a prior pulse matching the
  `(writId, triggerType, writUpdatedAt)` identity (or
  `(lastTerminalWritId, writUpdatedAt)` for drain) and skips the emit
  if one is already present. Because the check hits the persisted
  book, the guarantee survives a process restart. See
  [`docs/architecture/apparatus/reckoner.md`](../../../docs/architecture/apparatus/reckoner.md)
  §"Idempotency under replay" for the full contract.

---

## Support Kit

None — the Reckoner contributes no books, no tools, and no pages. Its
only observable effect is the pulses it writes to the Lattice.
