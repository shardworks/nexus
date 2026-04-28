# `@shardworks/reckoner-apparatus`

The Reckoner stands up the **petition-scheduler apparatus**: the
kit-static registry of petitioner sources, the canonical
`petition()` / `withdraw()` helpers (Workflow 2 in the contract document),
the inspection helpers downstream consumers use to read the registry
and live config, and a Phase 2 CDC handler on `clerk/writs` that drives
held petitions out of `new` and writes one row per substantive
consideration to its `reckoner/reckonings` evaluation journal.

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
- The `petition()` helper — posts a writ in `new` phase via
  `clerk.post()`, then stamps `writ.ext['reckoner']` via
  `clerk.setWritExt()`. Two-step and non-atomic by design (see D7).
- The `withdraw()` helper — a thin pass-through to
  `clerk.transition(writId, 'cancelled', { resolution: reason })`.
- Inspection helpers — `isSourceRegistered`, `isSourceDisabled`,
  `listPetitioners` — typed under `ReckonerApi` and reachable through
  `guild().apparatus<ReckonerApi>('reckoner')`.
- A `reckoner` block in `guild.json` with `enforceRegistration` and
  `disabledSources`; both fields are optional and re-read on every
  consumer call so operators can hot-edit without restarting the guild.
- A **Phase 2 CDC handler** that watches `clerk/writs` for held
  petitions (writs in `new` phase carrying `ext.reckoner`), runs the
  rule sequence (skip / disabled-source / source-check / scheduler-
  evaluate), drives `clerk.transition(...)` to the type's active state
  on accept (or to `cancelled` with a structured resolution on
  decline), and idempotently appends one row to the `reckoner/reckonings`
  book per consideration. The scheduler call site (Rule 5) routes
  through the registry-resolved active scheduler — the default
  `reckoner.always-approve` instance approves every held petition
  that clears the source / disabled / registration gates. The
  configured scheduler can also emit `defer` (no transition, no row)
  or `decline` (transition to `cancelled` with the decision's reason
  recorded as the resolution string + a Reckonings row carrying
  `declineReason: 'other'`). The other decline path remains
  `enforceRegistration: true` against an unregistered source, which
  produces an `outcome: 'declined'` row with
  `declineReason: 'source_unregistered'`.
- A **startup catch-up scan** that re-routes pre-existing held
  petitions through the same handler at apparatus start so a process
  restart does not strand work.
- The **`reckoner/reckonings` book** — the Reckoner's evaluation
  journal. One row per substantive consideration, immutable after
  write. The auto-wired
  `book.reckoner.reckonings.{created,updated,deleted}` Clockworks
  events fire normally (no carve-out); `created` is the channel
  petitioners subscribe to. See
  `docs/architecture/reckonings-book.md` for the schema, index set,
  and CDC contract.

The Reckoner requires `clerk` and consumes `petitioners`. Stacks is
reached transitively through Clerk; no Clockworks dependency is
declared.

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
