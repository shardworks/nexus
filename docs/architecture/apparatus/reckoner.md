# The Reckoner — API Contract

Status: **Draft**

Package: `@shardworks/reckoner-apparatus` · Plugin id: `reckoner`

> **⚠️ v0 scope.** v0 ships the contract surface only — the
> kit-static petitioner registry, the `petition()` /
> `withdraw()` helpers (Workflow 2 in the contract document),
> the `enforceRegistration` and `disabledSources` config keys,
> and the inspection helpers on `provides`. There is no CDC
> handler, no Lattice pulse emission, and no Reckonings book in
> this commission — those land in follow-on work. The legacy
> stall/fail/drain pulse emitter (formerly named "the Reckoner")
> now lives at [sentinel.md](sentinel.md) under the `sentinel`
> plugin id.

---

## Purpose

The Reckoner is the petitioner-scheduler apparatus. It owns the
**contract surface** that lets any apparatus post a Reckoner-gated
writ — a writ in `new` phase carrying `writ.ext['reckoner']` — and
maintains the registry of recognized petitioner sources.

In v0 the Reckoner does **not** evaluate or transition petitions;
it only stands up the contract. Petitions land in `new` phase and
wait there until the follow-on CDC handler commission picks them
up. Petitioners may withdraw a held writ via `withdraw()` (a thin
wrapper over `clerk.transition(writId, 'cancelled', …)`).

The Reckoner is the canonical Workflow-2 path. Workflow-1 callers
(direct `clerk.post()` + `clerk.setWritExt()`) get the same on-disk
shape and are equally welcome — the helper exists for ergonomics,
default-fill, and registry validation, not as a gate.

See: the load-bearing contract document at
[../petitioner-registration.md](../petitioner-registration.md).

---

## Dependencies

```
requires: ['clerk']
consumes: ['petitioners']
```

- **The Clerk** (required) — `clerk.post()` is the writ-creation
  primitive `petition()` calls; `clerk.setWritExt()` writes the
  `writ.ext['reckoner']` slot; `clerk.transition()` drives
  `withdraw()`. Stacks is a transitive `requires` via Clerk and is
  not declared explicitly (D16).

---

## Kit Interface

The Reckoner consumes the new `petitioners` kit-contribution type
— the third kit-static contribution registry in the framework
after Clerk's `linkKinds` and Spider's `rigTemplateMappings`.

A kit (or apparatus's `supportKit`) declares one or more
petitioner descriptors under the `petitioners` array:

```typescript
export default {
  kit: {
    requires: ['reckoner'],
    petitioners: [
      {
        source: 'vision-keeper.snapshot',
        description:
          'Periodic vision-vs-reality snapshots emitted when ' +
          'the keeper observes drift worth surfacing.',
      },
    ],
  },
} satisfies Plugin;

interface PetitionerDescriptor {
  /** Fully-qualified source id of the form `{pluginId}.{kebab-suffix}`. */
  source:      string;
  /** Human-readable description of what this petitioner emits. */
  description: string;
}
```

### Source-id grammar

A source id has the form **`{pluginId}.{kebab-suffix}`** — the
contributing plugin's derived id, a literal `.`, then a kebab-case
suffix (lowercase letters, digits, and hyphens; not starting or
ending with a hyphen). Mirrors Lattice trigger-types and Clerk
link-kinds (D2). Examples:

- `vision-keeper.snapshot`
- `patron-bridge.commission`
- `tech-debt.detected`

The kebab-case suffix grammar is the same regex Clerk uses for
link-kinds: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.

### Validation policy

- **Prefix mismatch.** When a `petitioners` entry's source prefix
  does not equal the contributing plugin's id, startup hard-fails
  with a diagnostic naming the offending source and the
  contributing kit (D3). The kit author either named the wrong
  prefix or named the wrong kit; either way the registry should
  not paper over the drift.
- **Malformed kebab-case suffix.** Same hard-fail policy (D4).
- **Duplicate source.** When two `petitioners` entries (across
  any kits, including the same kit) share a `source` string,
  startup hard-fails with a diagnostic naming **both** contributing
  kit ids and the conflicting source. Mirrors Clerk's link-kind
  collision rule, Spider's `rigTemplateMappings` collision rule,
  and Fabricator's engine-design collision rule.
- **Sealing.** The registry seals at the framework's
  `phase:started` signal — the same moment Clerk seals its
  writ-type registry (D5). Post-seal registration attempts throw
  a sealed-registry error patterned on Clerk's `[clerk]
  registerWritType:` diagnostic.

---

## Support Kit

None — the Reckoner contributes no books, no tools, and no pages
in v0. Its effect on the guild is the contract surface and the
`provides` API.

---

## `ReckonerApi` Interface (`provides`)

```typescript
interface ReckonerApi {
  /**
   * Post a writ in `new` phase with `writ.ext['reckoner']` set
   * correctly.
   *
   * Resolves the source against the registry. When the source is
   * not registered:
   *   - `enforceRegistration: true`  — throws fail-loud, no writ
   *     is created.
   *   - `enforceRegistration: false` (default) — logs a warning
   *     and proceeds.
   *
   * Validates every priority dimension against its enum. Applies
   * defaults to omitted priority dimensions (field-by-field
   * merge). Calls `clerk.post()` then `clerk.setWritExt()` —
   * two-step, non-atomic.
   *
   * Returns the writ document with `ext.reckoner` populated.
   */
  petition(request: PetitionRequest): Promise<WritDoc>;

  /**
   * Withdraw a held writ by transitioning it to `cancelled`.
   *
   * Thin wrapper around `clerk.transition(writId, 'cancelled',
   * { resolution: reason })`. No source check, no owner check,
   * no ext check. Reason passes through verbatim — undefined
   * stays undefined.
   */
  withdraw(writId: string, reason?: string): Promise<WritDoc>;

  /** True when `source` is in the kit-static petitioner registry. */
  isSourceRegistered(source: string): boolean;

  /**
   * True when `source` is currently in the live `disabledSources`
   * config list. Re-reads `guild.json` on every call so operators
   * can hot-edit (D20).
   */
  isSourceDisabled(source: string): boolean;

  /** Project every registered petitioner descriptor (source + description). */
  listPetitioners(): PetitionerDescriptor[];
}

interface PetitionRequest {
  // ── writ fields (passed through to clerk.post) ────────
  type?:     string;
  title:     string;
  body:      string;
  codex?:    string;
  parentId?: string;

  // ── ext.reckoner fields ───────────────────────────────
  source:      string;
  priority?:   Partial<Priority>;
  complexity?: ComplexityTier;
  payload?:    unknown;
  labels?:     Record<string, string>;
}

type Priority = {
  visionRelation:
    | 'vision-blocker' | 'vision-violator'
    | 'vision-advancer' | 'vision-neutral';
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  scope:    'whole-product' | 'major-area' | 'minor-area';
  time:     { decay: boolean; deadline: string | null };
  domain:   Array<
    | 'security' | 'compliance' | 'cost' | 'feature' | 'quality'
    | 'infrastructure' | 'documentation' | 'research' | 'ergonomics'
  >;
};

type ComplexityTier =
  | 'mechanical' | 'bounded' | 'exploratory' | 'open-ended';
```

### Default priority

`petition()` accepts a `Partial<Priority>`. Omitted dimensions are
filled with the contract defaults at the helper boundary (D15):

```typescript
{
  visionRelation: 'vision-neutral',
  severity:       'minor',
  scope:          'minor-area',
  time:           { decay: false, deadline: null },
  domain:         [],
}
```

The default-priority function is intentionally **not exported** —
the patron override (D14) keeps it internal. Workflow-1 callers
who hand-build the ext supply their own priority values.

### Two-step post (D7)

`petition()` runs two non-atomic Clerk calls:

1. `clerk.post(...)` — creates the writ in `new` phase with the
   writ-shape fields (`type`, `title`, `body`, `codex`, `parentId`).
   `type` defaults to the guild's configured default writ type
   when omitted (D21).
2. `clerk.setWritExt(writId, 'reckoner', ext)` — writes the
   `writ.ext['reckoner']` slot. The `pluginId` argument is the
   hardcoded literal `'reckoner'` (D11): the constant *is* the
   contract slot key.

There is a small orphan window between these two calls. The
contract document (`docs/architecture/petitioner-registration.md`,
observation `obs-4`/`obs-5`) records the trade-off; in v0 the
window is acceptable and recoverable. Wrapping `petition()` in a
Stacks transaction would cross a layering boundary not earned by
this commission.

---

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

- **`enforceRegistration`** (boolean, default `false`) — when
  `true`, `petition()` with an unregistered source throws fail-
  loud at the helper boundary and does not post a writ. When
  `false`, it logs a warning and proceeds.
- **`disabledSources`** (string array, default `[]`) — sources
  the operator wants to skip. Surfaced through
  `isSourceDisabled()`. The list is re-read on every call (D20)
  so operators can hot-edit `guild.json` without restarting the
  guild.

When the entire `reckoner` block is missing, both fields take
their defaults silently. When the block is present, type
mismatches in either field throw fail-loud at the read site (D12).

---

## Workflow-2: petition()

```typescript
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { guild } from '@shardworks/nexus-core';

const reckoner = guild().apparatus<ReckonerApi>('reckoner');

const writ = await reckoner.petition({
  source: 'vision-keeper.snapshot',
  title:  'Address vision drift detected at 04:00 UTC',
  body:   '...',
  codex:  'nexus',
  parentId: 'w-...',
  priority: {
    visionRelation: 'vision-violator',
    severity:       'serious',
    scope:          'major-area',
    time: { decay: true, deadline: null },
    domain: ['quality'],
  },
  complexity: 'bounded',
  payload: { /* opaque petitioner-defined data */ },
  labels:  { 'vision-keeper.io/vision-id': 'nexus' },
});
```

After this call, the writ exists in `new` phase, with
`writ.ext.reckoner = { source, priority, complexity, payload,
labels }`. The follow-on CDC handler picks it up.

---

## What the Reckoner does NOT do (in v0)

- **No CDC observer.** No subscription to `clerk/writs`. The
  follow-on commission (`w-mohuvpu2`) wires that.
- **No Lattice pulses.** The Reckoner does not emit pulses.
- **No Reckonings book.** The evaluation log lives in a separate
  parallel commission.
- **No Stacks transaction wrapping `petition()`.** The two-step
  flow is the chosen design (D7). The orphan-window observations
  are recorded in the contract document.
- **No `ext` field on `clerk.post()`.** Clerk's
  `PostCommissionRequest` is unchanged; the ext slot is written
  via the second `setWritExt` call.
- **No `defaultPriority()` export.** Internal helper only (D14).
- **No `contributingPluginId` / timestamps on
  `PetitionerDescriptor`.** Contract floor only (D19).
- **No source/owner check inside `withdraw()`.** Thin pass-through
  (D10).
- **No `recommends: ['oculus']` or explicit Stacks dependency.**
  `requires: ['clerk']` only (D16).
- **No `nsg reckoner list-petitioners` CLI tool.** Recorded as
  observation `obs-8`.

---

## Open Questions

- **Combination function.** How does the future Reckoner-core
  combine the five priority dimensions plus complexity into a
  scheduling weight? Owned by the Reckoner-core scheduling
  prototype.
- **Workflow-1 / Workflow-2 parity.** v0 ships Workflow-2; the
  contract document specifies that Workflow-1 (direct
  `clerk.post()`) reaches the same on-disk shape. The CDC
  handler commission will validate this once observation lands.
- **Atomicity of `petition()`.** Recorded as `obs-4` / `obs-5`.
  The orphan window is small and recoverable; promoting to a
  Stacks transaction is reserved for when a named bug surfaces.

---

## Implementation Notes

- The `reckoner` config block is re-read on every consumer call
  (D20). No caching at startup. Operators can disable a
  misbehaving petitioner by adding it to `disabledSources` and
  reloading the file — no restart required.
- Diagnostic prefixes match Clerk: `[reckoner]` for general
  errors, `[reckoner] Kit "<id>" petitioners:` for kit-validation
  errors. Two-kit collision diagnostics name both kits ("...
  already registered by kit \"<earlier-kit>\"...").
- The kebab-case suffix regex is duplicated across Clerk
  link-kinds, Lattice trigger-types, and the Reckoner. Extracting
  a shared `validateKebabSegmentSuffix` helper to nexus-core is
  observation `obs-6` — earned when a third consumer asks.
- The `RECKONER_PLUGIN_ID` constant in
  `@shardworks/sentinel-apparatus` (the Sentinel's source-id
  string for its Lattice pulses) and the `reckoner.writ-stuck` /
  `reckoner.writ-failed` / `reckoner.queue-drained` trigger
  strings are unrelated to this apparatus — they are baked into
  Lattice channel configurations and on-disk pulse rows. Renaming
  them is deferred to a separate scoped commission (D24).
