# `@shardworks/surveyor-apparatus`

The Surveyor stands up the **cartograph-decomposition substrate**: the
kit-static registry of surveyor implementations, the CDC observers that
watch for cartograph writs needing decomposition, the anima tools that
surface survey actions to agents, and the inspection helpers downstream
consumers use to read the active surveyor at runtime.

What ships here (T1 scaffold; T2-T6 fill in the full implementation):

- A new `surveyors` kit-contribution type. Kits declare surveyor
  implementations by contributing an array of `SurveyorDescriptor`
  entries; the Surveyor consumes the array at boot, validates the id
  grammar, and seals the registry at `phase:started`. Only one active
  surveyor may be registered at a time; contributing two descriptors
  is a hard startup error.
- The `SurveyorExt` shape — cartograph-side priority hints stamped at
  `writ.ext['surveyor']` for vision/charge/piece writs. Written by
  `nsg vision apply` (for visions) and by surveyor rigs (for
  charges/pieces). Fields: `severity`, `deadline`, `decay`,
  `complexity`.
- The `SurveyorWritExt` shape — provenance blob stamped at
  `writ.ext['surveyor']` for survey-vision/survey-charge/survey-piece
  writs. Fields: `surveyorId`, `rigVersion`, `parentUpdatedAt`. The
  `parentUpdatedAt` field drives the dedupe gate: if a non-terminal
  survey writ already exists for the same `(parentId, parentUpdatedAt)`
  pair, re-emission is skipped.
- The `SurveyorStatus` shape — post-completion observation blob stamped
  at `writ.status['surveyor']` when a survey writ reaches a terminal
  phase. Fields: `surveyedAt`, `childCount`, `terminal`.
- The `SurveyorLayer` type — `'vision' | 'charge' | 'piece'`, identifying
  which cartograph layer a survey writ targets.
- The `SurveyorDescriptor` type — the kit-contribution shape. A
  descriptor's `id` must equal the contributing kit's `pluginId`.
  The `rigTemplates` map must cover all three survey types:
  `survey-vision`, `survey-charge`, and `survey-piece`.
- Inspection helpers — `listSurveyors()`, `getActiveSurveyor()` — typed
  under `SurveyorApi` and reachable through
  `guild().apparatus<SurveyorApi>('surveyor')`.
- Six anima tools: `surveyor-create-charge`, `surveyor-create-charges`,
  `surveyor-create-piece`, `surveyor-create-pieces`,
  `surveyor-create-mandate`, `surveyor-create-mandates`. All are
  `callableBy: ['anima']` and wrap their operations in a single
  `stacks.transaction`.

The Surveyor requires `stacks`, `clerk`, `cartograph`, and `reckoner`.
`spider`, `animator`, `loom`, `clockworks`, and `oculus` are soft
`recommends`; the Surveyor's CDC observers and rig-dispatch paths
only activate when those apparatus are present.

See the contract document at
`docs/architecture/apparatus/surveyor.md` for the full data shape.

---

## Default surveyor implementation

The Surveyor substrate ships **no concrete surveyor** — it only provides
the registry. To start surveying immediately, install and configure the
default first-light implementation:

```json
{
  "dependencies": {
    "@shardworks/scaffold-surveyor": "workspace:*"
  }
}
```

Add `@shardworks/scaffold-surveyor` to your guild's `plugins` array.
`@shardworks/scaffold-surveyor` is explicitly designed to be replaced
— replace it by contributing your own `SurveyorDescriptor` kit and
removing the scaffold plugin from `guild.json`.

---

## Installation

```json
{
  "dependencies": {
    "@shardworks/surveyor-apparatus": "workspace:*"
  }
}
```

Add `surveyor` to `guild.json`'s `plugins` array.

## Kit-contribution convention

A kit (or apparatus's `supportKit`) declares a surveyor implementation
under the `surveyors` key:

```typescript
import type { SurveyorDescriptor } from '@shardworks/surveyor-apparatus';

const mySurveyor: SurveyorDescriptor = {
  id: 'my-plugin',
  description: 'Decomposes visions using the my-plugin strategy.',
  version: '0.1.0',
  rigTemplates: {
    'survey-vision':  { /* rig template body */ },
    'survey-charge':  { /* rig template body */ },
    'survey-piece':   { /* rig template body */ },
  },
};

export default {
  kit: {
    requires: ['surveyor'],
    surveyors: [mySurveyor],
  },
};
```

The `id` must equal the contributing kit's `pluginId`. Duplicate ids
across two kits, a missing required `rigTemplates` key, and post-seal
registration all hard-fail at startup. Only one surveyor may be active
at a time; a guild with two contributing kits is a startup error.

## Extension types

### `SurveyorExt` (on cartograph writs)

Stamped at `writ.ext['surveyor']` for `vision`, `charge`, and `piece`
writs. Written by `nsg vision apply` (visions) and by surveyor rigs
(charges and pieces).

```typescript
interface SurveyorExt {
  severity?:   'moderate' | 'serious' | 'critical';
  deadline?:   string;   // ISO date
  decay?:      boolean;
  complexity?: 'mechanical' | 'bounded' | 'exploratory' | 'open-ended';
}
```

### `SurveyorWritExt` (on survey writs)

Stamped at `writ.ext['surveyor']` for `survey-vision`, `survey-charge`,
and `survey-piece` writs.

```typescript
interface SurveyorWritExt {
  surveyorId:       string;  // id of the registered surveyor
  rigVersion?:      string;  // semver of the surveyor rig at queue time
  parentUpdatedAt:  string;  // ISO timestamp; dedupe key
}
```

The `parentUpdatedAt` field is the parent cartograph writ's `updatedAt`
at queue time. The CDC observer skips emission when a non-terminal survey
writ with the same `(parentId, parentUpdatedAt)` pair already exists.

## Anima tools

Six tools are surfaced to surveyor rigs. All require `callableBy: ['anima']`
and execute inside a single `stacks.transaction`.

| Tool name                       | Permission        | Description                                              |
| ------------------------------- | ----------------- | -------------------------------------------------------- |
| `surveyor-create-charge`        | `create-charge`   | Create one charge under a vision.                        |
| `surveyor-create-charges`       | `create-charge`   | Create a batch of charges under one vision.              |
| `surveyor-create-piece`         | `create-piece`    | Create one piece under a charge or piece.                |
| `surveyor-create-pieces`        | `create-piece`    | Create a batch of pieces under one parent.               |
| `surveyor-create-mandate`       | `create-mandate`  | Create one mandate and stamp it with Reckoner priority.  |
| `surveyor-create-mandates`      | `create-mandate`  | Create a batch of mandates and petition each.            |

Each create-charge / create-piece tool accepts optional `hints` (stamped at
`ext['surveyor']`) and an optional `supersedes` id (recorded as a
`surveyor.supersedes` link). Each create-mandate tool requires a `source`
field matching the Reckoner source-id convention
(`<surveyorId>.survey-<layer>`).

## Reading the active surveyor

```typescript
import type { SurveyorApi } from '@shardworks/surveyor-apparatus';
import { guild } from '@shardworks/nexus-core';

const surveyor = guild().apparatus<SurveyorApi>('surveyor');

const active = surveyor.getActiveSurveyor();
if (active) {
  console.log('Active surveyor:', active.id, active.version);
}

const all = surveyor.listSurveyors();
console.log('Registered surveyors:', all.map(s => s.id));
```
