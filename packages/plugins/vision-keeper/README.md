# `@shardworks/vision-keeper-apparatus`

The Vision-keeper is the **canonical worked-example petitioner** from
the Reckoner contract document
(`docs/architecture/petitioner-registration.md` §11). It exists to
exercise every contract surface — kit declaration, source stamping,
dimension claims, complexity, payload, labels, withdraw, and standing-
order feedback — against a real consumer, and to give every future
petitioner an in-tree reference implementation to model from.

This v0 commission ships the **petitioner side only**:

- An apparatus exposing three caller-facing methods —
  `submitDriftSnapshot()`, `submitElaborationNudge()`, and
  `superseded()` — surfaced under `VisionKeeperApi`.
- A typed `VisionSnapshotPayload` shape (the `visionId`,
  `snapshotTimestamp`, `visionVsRealityDelta`, `metricValues` fields
  the brief enumerates) that the keeper auto-fills before stamping it
  onto `ext.reckoner.payload`.
- A `petitioners` kit contribution (declaring the
  `vision-keeper.snapshot` source) consumed by the Reckoner at
  apparatus startup and sealed at `phase:started`.
- The auto-supersede invariant: at most one outstanding petition per
  `visionId`. Emitting a second snapshot for the same vision while one
  is still outstanding withdraws the prior writ before posting the
  new one.
- A decline-feedback relay (`vision-keeper-on-decline`) operators wire
  via a Clockworks standing order — see "Wiring the decline-feedback
  relay" below.

Out of scope for this commission (separate follow-up work):

- The vision-artifact storage, the drift-detection runtime, and the
  rig that processes vision-keeper writs.
- Multi-vision orchestration (multiple keeper apparatuses, per-vision
  factories, vision registries). v0 supports the labels surface for
  multi-instance discrimination — see the per-call `visionId` argument.

The Reckoner now ships a CDC approval handler (the always-approve
v0 stub): a vision-keeper petition lands in `new`, the handler picks
it up via the Phase 2 watcher on `clerk/writs`, and the writ
transitions to the type's active state (`open` for mandate). The
keeper does not need to drive that transition itself.

The apparatus declares `requires: ['reckoner']` and
`recommends: ['clockworks']`. Without Clockworks the keeper still
emits and withdraws petitions cleanly; only the decline-feedback
channel needs the standing-order substrate.

See: `docs/architecture/petitioner-registration.md` (the load-bearing
contract document) and the sibling Reckoner README for the underlying
helper API.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/vision-keeper-apparatus": "workspace:*"
  }
}
```

Add `vision-keeper` to `guild.json`'s `plugins` array. The Reckoner
must already be declared as a plugin (the keeper hard-requires it).

```json
{
  "plugins": ["clerk", "reckoner", "vision-keeper"]
}
```

## Emitting a drift snapshot

```typescript
import type { VisionKeeperApi } from '@shardworks/vision-keeper-apparatus';
import { guild } from '@shardworks/nexus-core';

const keeper = guild().apparatus<VisionKeeperApi>('vision-keeper');

const writ = await keeper.submitDriftSnapshot({
  visionId: 'product-vision-2026',
  title: 'API ergonomics drift detected at 04:00 UTC',
  body: 'The `/v2/orders` endpoint now requires three round-trips to '
      + 'complete what the vision document specifies as a single call.',
  visionVsRealityDelta: {
    promised: 'one-call order placement',
    observed: 'three sequential calls',
  },
  metricValues: { ordersPerSecond: 12.3, p95LatencyMs: 410 },
});
// writ is in `phase: 'new'` with:
//   ext.reckoner.source     = 'vision-keeper.snapshot'
//   ext.reckoner.priority   = drift-default dimensions (see below)
//   ext.reckoner.complexity = 'bounded'
//   ext.reckoner.payload    = the typed VisionSnapshotPayload
//   ext.reckoner.labels     = { 'vision-keeper.io/vision-id': 'product-vision-2026' }
```

**Drift-default dimensions** (overridable per-call via the request):

| Dimension        | Value                                  |
| ---------------- | -------------------------------------- |
| `visionRelation` | `'vision-violator'`                    |
| `severity`       | `'serious'`                            |
| `scope`          | `'major-area'`                         |
| `time`           | `{ decay: true, deadline: null }`      |
| `domain`         | `['quality']`                          |
| `complexity`     | `'bounded'`                            |

Per-call overrides for `severity`, `scope`, and `complexity` are
exposed on the request object — useful for the contract document's
"or critical for severe drift" escalation case.

## Emitting an elaboration nudge

```typescript
const writ = await keeper.submitElaborationNudge({
  visionId: 'product-vision-2026',
  title: 'Enable saved order presets per the vision document',
  body: 'The vision document calls for one-click reorders; we have the '
      + 'data model but no UI affordance yet.',
  visionVsRealityDelta: {
    promised: 'one-click reorder from saved presets',
    observed: 'no UI affordance; data is available',
  },
  metricValues: { reorderRate: 0.04 },
});
```

**Elaboration-default dimensions:**

| Dimension        | Value                                  |
| ---------------- | -------------------------------------- |
| `visionRelation` | `'vision-advancer'`                    |
| `severity`       | `'moderate'`                           |
| `scope`          | `'minor-area'`                         |
| `time`           | `{ decay: false, deadline: null }`     |
| `domain`         | `['feature']`                          |
| `complexity`     | (omitted)                              |

Complexity is omitted for elaborations by default. Pass `complexity`
on the request object to set one explicitly.

## Auto-supersede

The keeper holds an in-memory map `Map<visionId, writId>` recording at
most one outstanding petition per vision. Emitting a second petition
for a `visionId` that already has an outstanding writ withdraws the
prior writ first (with a "superseded by newer snapshot" reason) before
posting the new one. There is no caller-visible knob for this — it is
the keeper's identity (D10).

State lives in process memory only; a daemon restart loses it. That is
an honest v0 limitation. Callers that need durable supersede semantics
across restart should treat each restart as a fresh slate.

## Withdrawing the keeper's outstanding petition

```typescript
const withdrawn = await keeper.superseded(
  'product-vision-2026',
  'Drift was resolved out-of-band before this petition was considered.',
);
// withdrawn === null when there was nothing to withdraw (idempotent).
```

Idempotent — calling `superseded()` for a vision that has no
outstanding petition returns `null` rather than throwing.

## Wiring the decline-feedback relay

When the Reckoner CDC handler declines a vision-keeper petition (or
the petitioner-initiated `withdraw()` helper cancels one), the writ
transitions into `cancelled` and a `book.clerk.writs.updated` event
fires. The Vision-keeper contributes a relay named
`vision-keeper-on-decline` that logs a single line per decline;
operators wire it through the Clockworks standing-order surface.

Add the following entry to `clockworks.standingOrders` in
`guild.json`:

```json
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "book.clerk.writs.updated",
        "run": "vision-keeper-on-decline"
      }
    ]
  }
}
```

The relay handler narrows the CDC payload itself — only updates that
represent a transition into `cancelled` for a writ whose
`ext.reckoner.source` equals `vision-keeper.snapshot` produce a log
line. Other writ updates flowing past the relay are ignored. The
standing order accepts no `with:` parameters (the relay is zero-
config); operators only set `on:` and `run:`.

## Configuration

The Vision-keeper does not augment `guild.json`. There are no tunables
in v0 — dimension presets are hardcoded (with per-call overrides on
the API), the decline relay is zero-config, and the keeper holds no
configuration block.

## Caveats

- **No persistence of the outstanding-petition map.** The
  `Map<visionId, writId>` lives in process memory. A daemon restart
  loses the map; downstream Reckoner consideration of any orphaned
  outstanding writ continues unaffected, but the keeper itself
  treats the post-restart state as "no outstanding petitions known".
- **No payload size cap.** The keeper does not enforce a payload size
  limit; a separate cross-cutting commission owns that policy.
