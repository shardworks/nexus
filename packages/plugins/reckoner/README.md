# `@shardworks/reckoner-apparatus`

The Reckoner stands up the **petition-scheduler apparatus**: the
kit-static registry of petitioner sources, the canonical
`petition()` / `withdraw()` helpers (Workflow 2 in the contract document),
the inspection helpers downstream consumers use to read the registry
and live config, and a periodic tick relay that drives held petitions
out of `new` and writes one row per consideration to its
`reckoner/reckonings` evaluation journal.

What ships here:

- A new `petitioners` kit-contribution type. Kits declare petitioners by
  contributing an array of `{ source, description }` entries; the
  Reckoner consumes the array at boot, validates the source-id grammar,
  and seals the registry at `phase:started`.
- A new `schedulers` kit-contribution type. Kits (and the Reckoner's
  own `supportKit`) declare scheduler instances by contributing an
  array of `Scheduler` objects under that key. The Reckoner consumes
  the array at boot, validates the id grammar, seals the registry at
  `phase:started`, and resolves a single active scheduler from
  `guild.json reckoner.scheduler`. The default scheduler is
  `reckoner.always-approve` (shipped from the Reckoner's own
  `supportKit.schedulers`); plugins land additional policies by
  contributing their own scheduler under their own `{pluginId}.…` id.
- The `Priority` type (five dimensions: `visionRelation`, `severity`,
  `scope`, `time`, `domain`), the `ComplexityTier` enum, and the
  `ReckonerExt` shape — all faithful to the contract document at
  `docs/architecture/petitioner-registration.md`.
- The `petition()` helper in two forms:
  - **Create + stamp** (`petition(request)`) — posts a writ in its
    initial phase via `clerk.post()`, then stamps `writ.ext['reckoner']`
    via `clerk.setWritExt()`. Two-step and non-atomic by design (see D7).
  - **Stamp-only** (`petition(writId, extRequest)`) — the draft-then-
    publish idiom. Stamps `ext.reckoner` onto an already-posted writ
    that is still in its writ-type's initial phase, making the writ
    Reckoner-visible. Lets a petitioner create the writ, wire
    dependencies via `clerk.link()`, and then publish it as a single
    transactional unit when wrapped in `stacks.transaction(...)`. Both
    forms run through the same source / priority validation path.
- The `withdraw()` helper — a thin pass-through to
  `clerk.transition(writId, 'cancelled', { resolution: reason })`.
- Inspection helpers — `isSourceRegistered`, `isSourceDisabled`,
  `listPetitioners` — typed under `ReckonerApi` and reachable through
  `guild().apparatus<ReckonerApi>('reckoner')`.
- A `reckoner` block in `guild.json` with `enforceRegistration` and
  `disabledSources`; both fields are optional and re-read on every
  consumer call so operators can hot-edit without restarting the guild.
- A **periodic tick relay** (`reckoner.tick`) plus a kit-contributed
  standing order at `@every 60s` that drives the relay. Every fire
  sweeps the held-petition set in one batch, applies source /
  disabled-source gates, runs the dependency-aware consideration
  gate, dedupes against the persisted `(writId, writUpdatedAt)`
  lookup, calls the active scheduler's `evaluate` once with the full
  surviving candidate set, and applies each emitted decision
  (`approve` → transition to active target; `decline` → transition
  to `cancelled` with the decision's reason recorded as the
  resolution string + a Reckonings row carrying
  `declineReason: 'other'`; `defer` → no transition + a row
  carrying `deferReason: 'other'` and the decision's reason in
  `deferNote`). The other decline path is the source-unregistered +
  `enforceRegistration: true` rule (row carries
  `declineReason: 'source_unregistered'`); the disabled-source path
  produces a row with `declineReason: 'source_banned'`. The
  `@every 60s` cadence is hard-coded — there is no operator
  knob in this commission, and no way to disable the standing order
  short of removing the apparatus. The tick is the single
  evaluation entry — there is no CDC handler, no startup catch-up
  scan, and no per-writ-update path. Pre-existing held petitions
  are picked up on the first tick after `phase:started`.
- A **dependency-aware defer rule**, slotted into the tick sequence
  between source-registration enforcement and the scheduler call. The
  rule walks each held petition's outbound `depends-on` links
  (filtered by `link.kind === 'depends-on'`), resolves each target via
  the writs book, and classifies the target via its writ-type config
  attrs: a target is *cleared* iff its current state is terminal AND
  its attrs include `success` or `cancelled`; a terminal-but-not-
  cleared target is *failed*; any non-terminal target is *gating*. A
  dangling target is treated as gating. Failed-precedence aggregation
  produces one of three outcomes — `proceed` (all targets cleared, or
  no `depends-on` links exist), `defer-pending` (≥1 gating, none
  failed), or `defer-failed` (≥1 failed). Defer outcomes leave the
  writ in `new` phase and emit a `deferred` Reckonings row carrying
  `deferReason: 'dependency_pending'` or `'dependency_failed'` and
  `deferNote` listing the gating / failed dep writ ids. The dep gate
  re-evaluates on every Reckoner tick (the polling cadence is the v0
  wake-up mechanism); the row write is suppressed when the outcome
  shape is identical to the writ's most recent deferred row, so a
  long-deferred dependent does not produce a heartbeat duplicate per
  tick.
- A **`ReckonerStatus` snapshot** at `writ.status['reckoner']`, kept
  in sync by a Phase-2 CDC watcher on the Reckoner's own
  `reckonings` book. Every `create` event runs through the snapshot
  handler, which derives the writ's current decision shape, running
  deferral counters (`deferCount`, `firstDeferredAt`,
  `lastDeferredAt`), and a stalled flag (set in v0 only on
  `dependency_failed` defer rows at `defer_count >= 1`) and writes
  it back via `clerk.setWritStatus(writId, 'reckoner', next)`.
  Counters are preserved verbatim across deferred → accepted /
  declined transitions; `'no-op'` rows bump `lastEvaluatedAt` only.
  Consumers reading the snapshot should cross-check `writ.phase` to
  detect the petitioner-withdrawal lag case (a withdrawn writ still
  reads as deferred on the snapshot until a future Reckonings row
  refreshes it). See `docs/architecture/apparatus/reckoner.md`
  §"Staleness diagnostic" for the full surface, the v0 threshold
  table, and the `lastEvaluatedAt`-during-stable-stalled cadence
  note.
- The **`reckoner/reckonings` book** — the Reckoner's evaluation
  journal. One row per substantive consideration, immutable after
  write. The auto-wired
  `book.reckoner.reckonings.{created,updated,deleted}` Clockworks
  events fire normally (no carve-out); `created` is the channel
  petitioners subscribe to. See
  `docs/architecture/reckonings-book.md` for the schema, index set,
  and CDC contract.

The Reckoner requires `clerk`. Stacks is reached transitively through
Clerk. Clockworks is a soft `recommends` because the periodic tick
relay only fires when Clockworks is installed; the Reckoner's
`petition()` / `withdraw()` and registry inspection helpers continue
to work without it.

See the contract document at
`docs/architecture/petitioner-registration.md` for the full data shape
and the apparatus shape doc at `docs/architecture/apparatus/reckoner.md`.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/reckoner-apparatus": "workspace:*"
  }
}
```

Add `reckoner` to `guild.json`'s `plugins` array.

## Posting a petition (Workflow 2)

### Create + stamp (one-shot)

```typescript
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { guild } from '@shardworks/nexus-core';

const reckoner = guild().apparatus<ReckonerApi>('reckoner');

const writ = await reckoner.petition({
  source: 'vision-keeper.snapshot',
  title: 'Address vision drift detected at 04:00 UTC',
  body: '...',
  codex: 'nexus',
  priority: {
    visionRelation: 'vision-violator',
    severity: 'serious',
    scope: 'major-area',
    time: { decay: true, deadline: null },
    domain: ['quality'],
  },
  complexity: 'bounded',
  payload: { /* opaque petitioner-defined data */ },
});
// writ is in `new` phase with `writ.ext.reckoner` populated.
```

Omitted priority dimensions fall back to the contract defaults at the
helper boundary (see §3 of the contract document).

### Draft-then-publish (stamp-only)

When the petitioner needs to wire links or other dependencies onto a
writ before it becomes Reckoner-visible, use the stamp-only form.
Post the writ first, perform any setup, then call
`petition(writId, extRequest)` to stamp `ext.reckoner` and publish:

```typescript
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { guild } from '@shardworks/nexus-core';

const clerk    = guild().apparatus<ClerkApi>('clerk');
const stacks   = guild().apparatus<StacksApi>('stacks');
const reckoner = guild().apparatus<ReckonerApi>('reckoner');

// Post the draft writ first — it is in its initial phase but not yet
// Reckoner-visible (no ext.reckoner).
const draft = await clerk.post({
  title: 'Address vision drift',
  body:  '...',
});

// Wire dependencies and stamp ext.reckoner inside a single
// transaction so the writ becomes Reckoner-visible only after the
// outer commit. The Reckoner CDC handler observes the post-commit
// update event and runs its rule sequence.
await stacks.transaction(async () => {
  await clerk.link(draft.id, blockerId, 'depends-on');
  await reckoner.petition(draft.id, {
    source: 'vision-keeper.snapshot',
    priority: { visionRelation: 'vision-violator' },
  });
});
```

The stamp-only form fails loud (with no writ mutation) when the writ
is past its initial phase, when `ext.reckoner` is already present, or
when the writ id does not exist. Source registration and priority
defaults / dimension validation are identical to the create+stamp
form — a single canonical validation path runs for both.

## Declaring a petitioner

A kit (or apparatus's `supportKit`) declares its source(s) under the
`petitioners` key:

```typescript
export default {
  kit: {
    requires: ['reckoner'],
    petitioners: [
      {
        source: 'vision-keeper.snapshot',
        description:
          'Periodic vision-vs-reality snapshots emitted when the keeper observes drift worth surfacing.',
      },
    ],
  },
};
```

The source id must match `{contributingPluginId}.{kebab-suffix}`;
malformed entries hard-fail at startup. Two kits contributing the same
source is also a hard startup error (mirrors Clerk link-kinds, Spider
`rigTemplateMappings`, and Fabricator engine-design collision rules).

## Configuration

The Reckoner reads its configuration from `guild.json` under the
`reckoner` key. Every field is optional:

```json
{
  "reckoner": {
    "enforceRegistration": false,
    "disabledSources": [],
    "scheduler": "reckoner.always-approve",
    "schedulerConfig": {}
  }
}
```

- `enforceRegistration` (boolean, default `false`) — when `true`,
  `petition()` throws fail-loud for an unregistered source and does not
  post the writ.
- `disabledSources` (string array, default `[]`) — sources operators
  want to skip. The list is re-read on every call; operators can
  hot-edit `guild.json` without restarting the guild.
- `scheduler` (string, optional) — selects the active scheduler from
  the kit-static scheduler registry. Defaults to
  `reckoner.always-approve` when unset; setting it to an unregistered
  id throws fail-loud at startup with a diagnostic listing every
  registered id. Resolution happens once at `phase:started`.
- `schedulerConfig` (any, optional) — opaque config passed to the
  active scheduler's `evaluate` call. Re-read from `guild.json` on
  every consideration so operators can hot-edit; each scheduler
  narrows the value through its own `validateConfig`.

## Declaring a scheduler

A kit (or apparatus's `supportKit`) declares one or more scheduler
instances under the `schedulers` key:

```typescript
import type { Scheduler } from '@shardworks/reckoner-apparatus';

const myScheduler: Scheduler = {
  id: 'my-plugin.priority-walk',
  description: 'Selects highest-weight petition first.',
  async evaluate(input) {
    // input.candidates: the held petitions for this consideration.
    // input.config:     the validated config from guild.json.
    return [{ writId: input.candidates[0]!.id, outcome: 'approve', reason: 'top-of-queue' }];
  },
  validateConfig(raw) {
    // optional; throw on shape mismatch.
    return raw;
  },
};

export default {
  kit: {
    requires: ['reckoner'],
    schedulers: [myScheduler],
  },
};
```

The id grammar matches the petitioner-source grammar:
`{contributingPluginId}.{kebab-suffix}`. Duplicate ids across two
kits, malformed grammar, missing `evaluate`, and post-seal
registration all hard-fail at startup. Schedulers reach for shared
guild state (Stacks book handles, Clerk helpers) via `guild()` rather
than constructor injection.

## Withdrawing a petition

```typescript
await reckoner.withdraw(writId, 'Snapshot superseded by drift detected before this ran.');
```

Equivalent to `clerk.transition(writId, 'cancelled', { resolution: reason })`.
No source check, no owner check. Reason is passed through verbatim — when
omitted, no resolution is fabricated.
