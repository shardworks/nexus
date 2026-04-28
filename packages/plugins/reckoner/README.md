# `@shardworks/reckoner-apparatus`

The Reckoner stands up the **petitioner-scheduler contract surface**: the
kit-static registry of petitioner sources, the canonical
`petition()` / `withdraw()` helpers (Workflow 2 in the contract document),
and the inspection helpers downstream consumers use to read the registry
and live config.

This v0 commission ships the **contract surface only**. There is no CDC
handler, no Lattice pulse emission, and no Reckonings book. Petitions
posted through `petition()` land in `new` phase carrying
`writ.ext['reckoner']` — the follow-on CDC handler commission picks them
up and drives consideration.

What ships here:

- A new `petitioners` kit-contribution type. Kits declare petitioners by
  contributing an array of `{ source, description }` entries; the
  Reckoner consumes the array at boot, validates the source-id grammar,
  and seals the registry at `phase:started`.
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

The Reckoner requires `clerk` and consumes `petitioners`.

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
`reckoner` key. Both fields are optional:

```json
{
  "reckoner": {
    "enforceRegistration": false,
    "disabledSources": []
  }
}
```

- `enforceRegistration` (boolean, default `false`) — when `true`,
  `petition()` throws fail-loud for an unregistered source and does not
  post the writ.
- `disabledSources` (string array, default `[]`) — sources operators
  want to skip. The list is re-read on every call; operators can
  hot-edit `guild.json` without restarting the guild.

## Withdrawing a petition

```typescript
await reckoner.withdraw(writId, 'Snapshot superseded by drift detected before this ran.');
```

Equivalent to `clerk.transition(writId, 'cancelled', { resolution: reason })`.
No source check, no owner check. Reason is passed through verbatim — when
omitted, no resolution is fabricated.
