# The Surveyor — API Contract

Status: **Draft**

Package: `@shardworks/surveyor-apparatus` · Plugin id: `surveyor`

> **⚠️ CDC-driven substrate.** The Surveyor drives cartograph
> decomposition from two Phase-2 CDC observers on `(clerk, writs)`.
> Observer #1 fires on vision/charge/piece writ events and emits a
> typed survey writ plus a Reckoner petition in one transaction.
> Observer #2 fires on survey-writ terminal transitions and stamps
> `writ.status['surveyor']`. No periodic tick; no startup catch-up
> scan. The kit-static surveyor registry is sealed at `phase:started`;
> D15 (multi-surveyor fail-loud) enforces single-surveyor operation
> in v0. Six anima tools are contributed via `supportKit.tools`. See
> [Surveying Cascade](../surveying-cascade.md) for the end-to-end
> design.

---

## Purpose

The Surveyor is the cartograph-decomposition substrate. It owns the
survey writ types (`survey-vision`, `survey-charge`, `survey-piece`),
the surveyor registry, the two CDC observers, and the anima tool
surface that surveyor rigs use to create cartograph children.

It does not provide a concrete surveyor implementation. Surveyor
implementations (e.g. `@shardworks/scaffold-surveyor`) register via
the `surveyors` kit contribution type.

See: [Surveying Cascade](../surveying-cascade.md) for the full
end-to-end architecture.

---

## Dependencies

```
requires:   ['stacks', 'clerk', 'cartograph', 'reckoner']
recommends: ['spider', 'animator', 'loom', 'clockworks', 'oculus']
consumes:   ['surveyors']
```

- **The Stacks** (required) — `stacks.watch()` registers the two
  Phase-2 CDC observers; `stacks.transaction()` wraps each
  survey-writ emission atomically.
- **The Clerk** (required) — `clerk.post()` creates survey writs;
  `clerk.setWritExt()` stamps `writ.ext['surveyor']` provenance and
  `writ.ext['cartograph']` reads come via stacks; `clerk.setWritStatus()`
  stamps `writ.status['surveyor']` on terminal transitions.
- **The Cartograph** (required) — the surveyor anima tools call
  `CartographApi.createCharge` / `createPiece` when rigs decompose
  cartograph nodes.
- **The Reckoner** (required) — `reckoner.petition()` (stamp-only
  form) queues survey petitions.
- **The Spider** (recommended) — dispatches survey writ types once
  the Reckoner accepts. The Surveyor contributes rig templates via
  the surveyor registry; Spider resolves them by writ type.

---

## Writ Types

Three six-state mandate-clone writ types registered at startup:

| Type | Surveyed layer |
|------|---------------|
| `survey-vision` | vision writs |
| `survey-charge` | charge writs |
| `survey-piece` | piece writs |

State machine (same shape for all three):

```
new → open → stuck → open
              ↓       ↓
          completed  failed
new → cancelled
open → cancelled
stuck → cancelled
```

No `childrenBehavior` cascade on any type.

---

## Kit Contributions

### Consumed: `surveyors`

Surveyor implementations contribute an array of `SurveyorDescriptor`
objects:

```typescript
interface SurveyorDescriptor {
  id: string;          // must equal the contributing plugin id (D14)
  description: string;
  rigTemplates: Record<string, unknown>;
  version?: string;
}
```

Validation rules at registration time:

- `id` must be a non-empty kebab-case string
- `id` must equal the contributing `pluginId` (D14 — v0 ships exactly
  one surveyor per plugin)
- `description` must be a non-empty string
- `rigTemplates` must be an object (content is implementation-defined)
- `version` must be a string or omitted

D15: if more than one surveyor is registered across all kit
contributions, `sealRegistry()` throws. Only one surveyor is
supported in v0.

### Provided: link kinds

```
surveyor.supersedes  —  links a new cartograph node to the one it
                        supersedes; authored by anima tools when a
                        supersedes argument is passed
```

### Provided: tools

Six anima tools, all `callableBy: ['anima']`:

| Tool | Permission | Description |
|------|-----------|-------------|
| `surveyor-create-charge`   | `create-charge`  | Create one charge under a vision |
| `surveyor-create-charges`  | `create-charge`  | Create a batch of charges under one vision |
| `surveyor-create-piece`    | `create-piece`   | Create one piece under a charge or piece |
| `surveyor-create-pieces`   | `create-piece`   | Create a batch of pieces under one parent |
| `surveyor-create-mandate`  | `create-mandate` | Create one mandate and petition Reckoner |
| `surveyor-create-mandates` | `create-mandate` | Create a batch of mandates |

**`descriptor.rigTemplates` role.** The `rigTemplates` field on a
`SurveyorDescriptor` is a declarative inventory — it records which writ types
the surveyor handles and serves as validation evidence at registration time
(the substrate asserts it is a non-null object). The substrate does *not*
forward this field to Spider; it is not wired into any routing machinery.
See "Rig-template routing" below for how Spider dispatch actually works.

Each create-charge / create-piece tool wraps one `stacks.transaction`:

1. `cartograph.createCharge` / `createPiece`
2. `clerk.setWritExt('surveyor', hints)` — if hints present
3. `clerk.linkWrits(newId, supersedes, 'surveyor.supersedes')` — if
   supersedes argument present

Each create-mandate tool wraps one `stacks.transaction`:

1. `clerk.post({ type: 'mandate', ... })`
2. `reckoner.petition(writId, ext)` — stamp-only form

---

## Rig-template routing

Survey writs reach Spider via the Astrolabe-pattern kit-channel mechanism —
no Spider changes are required (source: commission D / c-moje41iq). Surveyor
implementations contribute their rig templates and mappings directly through
their own `supportKit`:

```typescript
// In the surveyor implementation's plugin definition:
export default {
  apparatus: {
    // ...
    supportKit: {
      rigTemplates: [
        {
          name:     'survey-vision-v1',
          engine:   'animator',
          roleFile: 'roles/survey-vision.md',
          // ...
        },
        {
          name:     'survey-charge-v1',
          engine:   'animator',
          roleFile: 'roles/survey-charge.md',
          // ...
        },
        {
          name:     'survey-piece-v1',
          engine:   'animator',
          roleFile: 'roles/survey-piece.md',
          // ...
        },
      ],
      rigTemplateMappings: [
        { writType: 'survey-vision', templateName: 'survey-vision-v1' },
        { writType: 'survey-charge', templateName: 'survey-charge-v1' },
        { writType: 'survey-piece',  templateName: 'survey-piece-v1'  },
      ],
    },
  },
};
```

Spider resolves the mapping at dispatch time: when a `survey-vision` writ
enters the queue, Spider looks up `rigTemplateMappings` for the first
matching entry and runs the associated template. The substrate imposes no
naming convention on template names — implementations are free to version
them (`survey-vision-v1`, `survey-vision-v2`, …) and update the mapping
without touching the substrate.

**Per-layer tool subsetting.** The brief assigns enforcement of per-layer
tool availability (vision-layer rigs can call create-charge; charge-layer
rigs can call create-piece or create-mandate; piece-layer rigs can call
create-mandate) to the rig template author — the substrate exposes all six
tools globally and does not key tool registration by writ type. Enforcing
the constraint in role files or engine configuration is the surveyor
implementation's responsibility.

---

## CDC Observers

### Observer #1 — cartograph node observer (`cdc.ts`)

Fires on `create` and `update` events on `(clerk, writs)`. Type
filter: `vision`, `charge`, `piece` only. Ignores `survey-*` types
(prevents loops) and all others.

**Zero-surveyor skip.** When no surveyor is registered (activeSurveyor
is undefined), the observer returns without action.

**D24 idempotency.** Before emitting, the observer checks for an
existing non-terminal survey writ with the same `parentId` and
matching `ext['surveyor'].parentUpdatedAt`. If found, emission is
skipped. A terminal existing survey writ does not block emission —
a re-survey after completion is valid.

**Emission shape.** One `stacks.transaction`:

1. `clerk.post({ type: 'survey-<layer>', title: 'Survey <layer>: <parentTitle>', body: '', parentId: parent.id })`
2. `clerk.setWritExt(surveyWrit.id, 'surveyor', { surveyorId, rigVersion?, parentUpdatedAt })`
3. `reckoner.petition(surveyWrit.id, { source: '<surveyorId>.survey-<layer>', priority, complexity? })`

Priority dimensions derived from `ext['surveyor']` hints on the
parent writ using the substrate defaults table (see §3.10 of the
Surveying Cascade doc).

### Observer #2 — outcome stamper (`outcome.ts`)

Fires on `update` events on `(clerk, writs)`. Type filter:
`survey-vision`, `survey-charge`, `survey-piece`. Terminal phase
filter: `completed`, `failed`, `cancelled`. Ignores transitions where
the previous phase was already terminal (no re-fire).

On a terminal transition, stamps `writ.status['surveyor']` via
`clerk.setWritStatus(writId, 'surveyor', ...)`:

```typescript
interface SurveyorStatus {
  terminal: 'success' | 'failure' | 'cancelled';
  surveyedAt: string;   // writ.resolvedAt
  childCount: number;   // cartograph children of surveyWrit.parentId
                        // created at or after surveyWrit.createdAt
}
```

`childCount` counts `vision`, `charge`, and `piece` writs only;
excludes `mandate`, `survey-*`, and other types.

---

## API (`provides`)

```typescript
interface SurveyorApi {
  listSurveyors(): SurveyorDescriptor[];
  getActiveSurveyor(): SurveyorDescriptor | undefined;
}
```

`getActiveSurveyor()` returns `undefined` before `phase:started` or
when zero surveyors are registered. After `phase:started` with
exactly one registered surveyor, returns that surveyor's descriptor.

---

## Plugin-keyed Slots

| Slot | Writ type | Written by | Content |
|------|-----------|------------|---------|
| `writ.ext['surveyor']` | survey writs | Observer #1 | `{ surveyorId, rigVersion?, parentUpdatedAt }` |
| `writ.ext['surveyor']` | cartograph writs | `vision-apply` / rig tools | Priority hints `{ severity?, deadline?, decay?, complexity? }` |
| `writ.status['surveyor']` | survey writs | Observer #2 | `{ terminal, surveyedAt, childCount }` |

---

## Priority Defaults

| Dimension | Default |
|-----------|---------|
| `visionRelation` | `vision-advancer` |
| `severity` | `moderate` |
| `scope` | vision → `major-area`; charge/piece → `minor-area` |
| `time.decay` | `false` |
| `time.deadline` | `null` |
| `domain` | `[]` |
| `complexity` | omitted when no hint supplied |

Hints are read from `writ.ext['surveyor']` on the parent cartograph
writ. CLI flags on `nsg vision apply` override sidecar values for
visions; rig tools set hints for charges and pieces at creation time.

---

## Related Documents

- [Surveying Cascade](../surveying-cascade.md) — end-to-end flow,
  design decisions, worked example
- [Petitioner Registration](../petitioner-registration.md) — how
  `ext['reckoner']` works and how the Reckoner gates petitions
- [Cartograph apparatus](cartograph.md) — vision/charge/piece writ
  types and the CartographApi
