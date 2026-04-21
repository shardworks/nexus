# `@shardworks/clockworks-retry-apparatus`

The Clockworks-Retry apparatus — the autonomous-hopper retry primitive. It observes stuck writs carrying `retryable: true` on their `status.spider` sub-slot and transitions them `stuck → open`, causing Spider to spawn the next rig attempt. Retries are bounded by a single global cap of **2 attempts**, counted as the number of rigs already attached to the writ (multi-rig-lite — one writ accumulates multiple rigs over successive attempts).

This apparatus keeps Spider's core logic unaware of retry policy. Retry is a post-commit observer layered on top of Spider's substrate, not a concern Spider itself knows about, so retry policy can evolve (or be swapped entirely) without touching Spider.

The Clockworks-Retry sits downstream of Clerk and Stacks and observes Spider's rigs book: `stacks ← clerk ← clockworks-retry` and `spider ← clockworks-retry` (read-only).

---

## Installation

Add to your package's dependencies:

```json
{
  "@shardworks/clockworks-retry-apparatus": "workspace:*"
}
```

The apparatus declares:

- **requires:** `stacks`, `clerk` — the CDC subscription and the phase-transition primitive.
- **recommends:** `spider` — Spider is the realistic producer of retryable-stuck events and owner of the rigs book. Without Spider the apparatus is safely inert (no rigs, no engine-failure stucks, nothing to count).

Once installed in a guild, the apparatus wires itself up on startup and runs autonomously for the lifetime of the process.

---

## API

The apparatus exposes a minimal `ClockworksRetryApi` via its `provides` interface — the clockwork runs autonomously via a CDC watcher on the writs book, so the public API is only the cap constant:

```typescript
import type { ClockworksRetryApi } from '@shardworks/clockworks-retry-apparatus';

const retry = guild().apparatus<ClockworksRetryApi>('clockworks-retry');
console.log(retry.maxAttempts); // 2
```

### `ClockworksRetryApi`

| Field | Type | Description |
|---|---|---|
| `maxAttempts` | `readonly number` | Maximum number of attempts (rigs) allowed before the clockwork stops requeuing a retryable-stuck writ. Exposed for tests and for surfaces that want to display the cap alongside the attempt count. |

### `MAX_RETRY_ATTEMPTS`

The constant backing `maxAttempts`, re-exported for convenience:

```typescript
import { MAX_RETRY_ATTEMPTS } from '@shardworks/clockworks-retry-apparatus';
// MAX_RETRY_ATTEMPTS === 2
```

### `SpiderWritStatus`

The shape of the `status.spider` sub-object the apparatus reads, re-exported from `@shardworks/spider-apparatus` so producer (Spider's `failEngine`) and reader (this clockwork) share a single canonical type:

```typescript
import type { SpiderWritStatus } from '@shardworks/clockworks-retry-apparatus';

// Populated by Spider's failEngine path on engine-failure stucks:
//   { stuckCause: 'engine-failure', retryable: true,  detail: '...' }
//   { stuckCause: 'engine-failure', retryable: false, detail: '...' }
//
// Populated by Spider's gating path on dependency stucks:
//   { stuckCause: 'failed-blocker', blockerIds: [...], observedAt: '...' }
//   { stuckCause: 'cycle',          blockerIds: [...], observedAt: '...' }
```

All fields are flat on `status.spider` — there is no nested `status.spider.stuck` sub-object. The apparatus keys only on `status.spider.retryable`, so dependency stucks (which never carry `retryable`) cannot accidentally trigger a requeue. See `@shardworks/spider-apparatus` for the full field list.

Consumers of the apparatus never need to construct this type directly — the apparatus only reads. It is re-exported for diagnostic surfaces that want to display stuck metadata alongside the attempt counter.

---

## Behavior

The apparatus registers a Phase 2 (post-commit) CDC watcher on the `clerk/writs` book. On every `update` event where the writ enters `stuck` (i.e. `prev.phase !== 'stuck' && writ.phase === 'stuck'`), it evaluates:

1. Is `status.spider.retryable === true`? If not, no-op.
2. Is `rigs.length < MAX_RETRY_ATTEMPTS` for this writ? If not, no-op.
3. Otherwise, `clerk.transition(writ.id, 'open')` — Spider picks this up on its next crawl and spawns a fresh rig as a sibling child of the writ.

The apparatus never mutates rigs directly; it only reads the rigs book to count attempts. New rigs are attached by Spider as part of its normal scheduling.

### What is *not* retried

The apparatus is intentionally narrow:

| Stuck category | Decision | Where handled |
|---|---|---|
| `retryable: true` on `status.spider` | Requeued up to the cap | This apparatus |
| `retryable: false` on `status.spider` | Stays stuck — definitional failure | Human attention |
| Missing `retryable` field | Stays stuck — fail-safe | Human attention |
| Dependency stucks (`failed-blocker`, `cycle`) | Ignored — populate the same `status.spider` slot with `stuckCause` + `blockerIds` but never `retryable` | Spider's `autoUnstick` |

Dependency stucks and engine-failure stucks share the same flat `status.spider` slot — they are distinguished by which fields are populated. The apparatus keys only on `retryable` (never on `stuckCause`), so dependency stucks never accidentally trigger a requeue.

### Rig counting

Attempt count is `rigs.count([['writId', '=', writ.id]])`. There is no separate counter field; `rigs.length` is the natural counter for the multi-rig-lite model (one writ, multiple rigs over successive attempts, writ identity stable).

---

## Configuration

The apparatus has no user-facing configuration. The cap is a compile-time constant (`MAX_RETRY_ATTEMPTS = 2`). If the cap needs to change, edit the constant and ship a new version; surfaces that depend on the cap read it from `maxAttempts`.

---

## Preconditions

The apparatus relies on the producer side (Spider's `failEngine` path) to populate `writ.status.spider.retryable` on engine-failure stucks. `failEngine` writes the rig patch and the writ's `status.spider` slot inside a single transaction, so both land in the same Phase 2 CDC event — the watcher observes a stuck entry whose status slot is already fully populated. Without the `retryable` flag, the clockwork's trigger condition is never met and the apparatus is safely inert — no spurious requeues, no missed writs held past the cap.

The apparatus issues its requeue from Phase 2 deliberately:

- The retry transition is a non-critical policy action layered on top of the primary stuck transition. A failure here must never roll back the underlying stuck write.
- The transition the apparatus issues (`clerk.transition(..., 'open')`) is itself a write on the same book the apparatus watches. Phase 1 (pre-commit) handlers would re-enter the CDC dispatch and risk recursion; Phase 2 runs after commit, so the open-transition's event is dispatched cleanly on the next cycle.
