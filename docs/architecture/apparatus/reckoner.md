# The Reckoner — API Contract

Status: **Draft**

Package: `@shardworks/reckoner-apparatus` · Plugin id: `reckoner`

> **⚠️ Periodic-tick model.** The Reckoner drives evaluation from a
> single canonical surface: a `reckoner.tick` relay paired with a
> kit-contributed `@every 60s` standing order. There is no CDC
> observer on `clerk/writs`, no per-writ-update path, and no startup
> catch-up scan; held petitions are picked up by the next tick after
> they land. The tick step set runs the full rule sequence on each
> surviving candidate (source-check / disabled-source /
> dependency-gate / scheduler-evaluate), drives `clerk.transition()`
> on accept or decline, defers (no transition, deferred row) when the
> dependency gate fires, and idempotently appends one row per
> state-change to the `reckoner/reckonings` book. The Reckonings book,
> the kit-static petitioner registry, the `petition()` / `withdraw()`
> helpers (Workflow 2 in the contract document, in both create+stamp
> and stamp-only forms), the `enforceRegistration` /
> `disabledSources` config, and the inspection helpers on `provides`
> all ship here. Lattice pulse emission remains out of scope (the
> auto-wired Clockworks events on the reckonings book are sufficient
> for v0 consumers). The legacy stall/fail/drain pulse emitter
> (formerly named "the Reckoner") now lives at
> [sentinel.md](sentinel.md) under the `sentinel` plugin id.

---

## Purpose

The Reckoner is the petitioner-scheduler apparatus. It owns the
**contract surface** that lets any apparatus post a Reckoner-gated
writ — a writ in `new` phase carrying `writ.ext['reckoner']` — and
maintains the registry of recognized petitioner sources.

Held petitions are evaluated by a periodic tick: a `reckoner.tick`
relay paired with a kit-contributed `@every 60s` standing order. On
each fire the Reckoner sweeps `clerk/writs` for held petitions,
applies source / disabled-source gates, runs the dependency-aware
gate (defer + deferred row when one or more outbound `depends-on`
targets are not all cleared), dedupes against its evaluation
journal, calls the active scheduler with the full surviving
candidate set, and applies each emitted decision (`approve` →
transition to active target; `decline` → transition to cancelled;
`defer` → no transition, deferred row). The tick is the single
evaluation entry — there is no CDC observer on `clerk/writs`. The
default scheduler is always-approve; petitioners may withdraw a
held writ via `withdraw()` (a thin wrapper over
`clerk.transition(writId, 'cancelled', …)`).

The Reckoner is the canonical Workflow-2 path. Workflow-1 callers
(direct `clerk.post()` + `clerk.setWritExt()`) get the same on-disk
shape and are equally welcome — the helper exists for ergonomics,
default-fill, and registry validation, not as a gate.

See: the load-bearing contract document at
[../petitioner-registration.md](../petitioner-registration.md).

---

## Dependencies

```
requires:   ['clerk']
recommends: ['clockworks']
consumes:   ['petitioners', 'schedulers']
```

- **The Clerk** (required) — `clerk.post()` is the writ-creation
  primitive `petition()` calls; `clerk.setWritExt()` writes the
  `writ.ext['reckoner']` slot; `clerk.transition()` drives
  `withdraw()`. Stacks is a transitive `requires` via Clerk and is
  not declared explicitly (D16).
- **The Clockworks** (recommended) — the standing-order dispatcher
  that fires the Reckoner's `@every 60s` tick. The Reckoner ships
  the `reckoner.tick` relay and the standing order via
  `apparatus.supportKit.relays` / `apparatus.supportKit.standingOrders`.
  When the Clockworks is not installed the Reckoner still boots —
  the standing order is simply never consumed and the tick never
  fires. Petitioners can still call `petition()` / `withdraw()` and
  read the registry, but no scheduler decisions are applied until
  Clockworks is added (or until an external caller drives the
  tick directly through some future operator surface).

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
        source: 'tech-debt.detected',
        description:
          'Worked-example petitioner emitting tech-debt ' +
          'findings worth surfacing as held writs.',
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

- `tech-debt.detected`
- `patron-bridge.commission`

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

The Reckoner's `apparatus.supportKit` declares:

- **`books.reckonings`** — the Reckonings evaluation journal
  with the contract index set. Stacks materialises the book during
  the Wire phase; the auto-wired
  `book.reckoner.reckonings.{created,updated,deleted}` Clockworks
  events fire normally. The Reckoner is the sole writer. See
  [reckonings-book.md](../reckonings-book.md) for the full schema
  and CDC contract.
- **`schedulers: [alwaysApproveScheduler]`** — the built-in
  `reckoner.always-approve` scheduler. Surfaces through
  `ctx.kits('schedulers')` exactly like a user-contributed
  scheduler; see the [Schedulers](#schedulers) section below.
- **`relays: [tickRelay]`** — the `reckoner.tick` relay that
  drives the per-fire sequence (held-writ query, source gates,
  dependency-aware gate, dedupe, scheduler invocation, decision
  application).
- **`standingOrders: [{ schedule: '@every 60s', run: 'reckoner.tick' }]`**
  — the kit-contributed standing order that wires the relay
  through the Clockworks dispatcher. The schedule is hard-coded —
  no operator knob exists in this commission. The order has no
  `id` field, per the kit-standing-orders additive-merge model:
  operators may append their own orders but cannot disable or
  override this one.

---

## `ReckonerApi` Interface (`provides`)

```typescript
interface ReckonerApi {
  /**
   * Create + stamp form. Post a writ in its registered initial
   * phase with `writ.ext['reckoner']` set correctly.
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
   * merge). Delegates to the stamp-only form below for the actual
   * ext write — source/priority validation runs once via the
   * shared internal helper consumed by both forms.
   *
   * Returns the writ document with `ext.reckoner` populated.
   */
  petition(request: PetitionRequest): Promise<WritDoc>;

  /**
   * Stamp-only form. Stamps `writ.ext['reckoner']` onto an
   * already-posted writ that is still in its writ-type's initial
   * phase. The draft-then-publish idiom: post the writ, wire
   * `clerk.link(...)` dependencies, then call this form to make
   * the writ Reckoner-visible.
   *
   * Same source / priority semantics as the create+stamp form.
   * Additional fail-loud guards: writ must exist, must be in its
   * type's initial phase (via `clerk.isInitial(writ)`), and must
   * not already carry `ext.reckoner`. Composes with
   * `stacks.transaction(...)`: when the petitioner wraps
   * `clerk.link()` + `reckoner.petition(writId, ext)` in a single
   * transaction, the writ becomes Reckoner-visible only after
   * commit.
   *
   * Returns the patched writ.
   */
  petition(writId: string, extRequest: PetitionExtRequest): Promise<WritDoc>;

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

interface PetitionExtRequest {
  // ── ext.reckoner fields ───────────────────────────────
  source:      string;
  priority?:   Partial<Priority>;
  complexity?: ComplexityTier;
  payload?:    unknown;
  labels?:     Record<string, string>;
}

interface PetitionRequest extends PetitionExtRequest {
  // ── writ fields (passed through to clerk.post) ────────
  type?:     string;
  title:     string;
  body:      string;
  codex?:    string;
  parentId?: string;
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

The create+stamp form of `petition()` runs two non-atomic Clerk
calls:

1. `clerk.post(...)` — creates the writ in its registered initial
   phase with the writ-shape fields (`type`, `title`, `body`,
   `codex`, `parentId`). `type` defaults to the guild's configured
   default writ type when omitted (D21).
2. `clerk.setWritExt(writId, 'reckoner', ext)` — writes the
   `writ.ext['reckoner']` slot. The `pluginId` argument is the
   hardcoded literal `'reckoner'` (D11): the constant *is* the
   contract slot key.

There is a small orphan window between these two calls. The
contract document (`docs/architecture/petitioner-registration.md`,
observation `obs-4`/`obs-5`) records the trade-off; in v0 the
window is acceptable and recoverable. Wrapping the create+stamp
form in a single Stacks transaction is left to the petitioner — see
the stamp-only form below for the supported transactional idiom.

### Stamp-only form (draft-then-publish idiom)

The stamp-only form (`petition(writId, extRequest)`) is the
canonical implementation; the create+stamp form is a convenience
wrapper that does writ-shape construction plus delegation. Both
forms route through the same internal validate-and-fill helper, so
source-registry / `enforceRegistration` semantics, priority
dimension validation, and partial-priority default-fill behave
identically.

The stamp-only form's order of operations:

1. Validate the ext-only fields (source registry +
   `enforceRegistration`, priority dimensions, default-fill). A
   malformed input never pays a Stacks read.
2. Read the writ via `clerk.show(writId)`. Throws (with a
   `[reckoner] petition:` prefix) when the writ does not exist.
3. Verify the writ is in its writ-type's initial phase via
   `clerk.isInitial(writ)`. Type-aware — never hardcodes `'new'`,
   so a non-mandate writ-type with a differently-named initial
   state is supported by construction. Fail-loud with no mutation
   when the writ is past its initial phase.
4. Verify `writ.ext['reckoner']` is absent. Petitioning is a
   one-time act; an already-petitioned writ never silently
   re-stamps. Fail-loud with no mutation.
5. Call `clerk.setWritExt(writId, 'reckoner', ext)`. Returns the
   patched writ.

Composition with `stacks.transaction(...)`: `clerk.setWritExt`
joins the surrounding transaction via Stacks AsyncLocalStorage, so
a petitioner that wraps `clerk.link()` (or any other writ-graph
prep) plus `reckoner.petition(writId, ext)` in a single transaction
gets atomicity for free — the writ becomes Reckoner-visible only
after the outer transaction commits. The Reckoner CDC handler
observes the post-commit `setWritExt` UPDATE event and runs the
rule sequence as for any other Reckoner-stamped writ (no special
case in the handler).

Out of scope (parked at the parent click): re-prioritization on
already-`open` writs, cross-apparatus authoring (apparatus X
creates, apparatus Y stamps), and atomic `clerk.post() + setWritExt`
bundling inside a single Clerk call.

---

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

- **`enforceRegistration`** (boolean, default `false`) — when
  `true`, `petition()` with an unregistered source throws fail-
  loud at the helper boundary and does not post a writ. When
  `false`, it logs a warning and proceeds.
- **`disabledSources`** (string array, default `[]`) — sources
  the operator wants to skip. Surfaced through
  `isSourceDisabled()`. The list is re-read on every call (D20)
  so operators can hot-edit `guild.json` without restarting the
  guild.
- **`scheduler`** (string, optional) — selects the active scheduler
  from the kit-static scheduler registry. Defaults to
  `reckoner.always-approve` when unset; setting it to an
  unregistered id throws fail-loud at startup with a diagnostic
  listing every registered id. Resolution happens once at
  `phase:started`.
- **`schedulerConfig`** (any, optional) — opaque config slice
  passed to the active scheduler. Re-read from `guild.json` on
  every consideration so operators can hot-edit; each scheduler
  narrows the value through its own `validateConfig`.

When the entire `reckoner` block is missing, every field takes its
default silently. When the block is present, type mismatches in any
field throw fail-loud at the read site (D12). The
`scheduler` / `schedulerConfig` fields are described in detail in
the [Schedulers](#schedulers) section below.

---

## Schedulers

The Reckoner consumes a second kit-contribution type — `schedulers`
— for pluggable selection policy. Exactly one scheduler is active
per Reckoner instance, resolved at startup from
`guild.json reckoner.scheduler`.

### Kit Interface

A kit (or apparatus's `supportKit`) declares one or more scheduler
instances under the `schedulers` array:

```typescript
export default {
  kit: {
    requires: ['reckoner'],
    schedulers: [myScheduler],
  },
} satisfies Plugin;

interface Scheduler<TConfig = unknown> {
  /** Fully-qualified id of the form `{pluginId}.{kebab-suffix}`. */
  id:           string;
  /** Human-readable description of the scheduling policy. */
  description:  string;
  /** Run the policy against the candidate set and emit decisions. */
  evaluate(input: SchedulerInput<TConfig>): Promise<readonly SchedulerDecision[]>;
  /** Optional config narrower; called per evaluation. */
  validateConfig?(raw: unknown): TConfig;
}

interface SchedulerInput<TConfig = unknown> {
  candidates: readonly HeldWrit[];
  capacity:   CapacitySnapshot;        // empty in v0
  now:        Date;                    // sampled at the call boundary
  config:     TConfig;                 // validated slice
}

interface SchedulerDecision {
  writId:  string;
  outcome: 'approve' | 'defer' | 'decline';
  reason:  string;
  weight?: number;                     // optional — threaded onto the row
}
```

The Reckoner contributes its own built-in `reckoner.always-approve`
instance via its apparatus `supportKit.schedulers`. That entry
flows through `ctx.kits('schedulers')` exactly like a user-
contributed scheduler; there is no special-cased default-bypass.

### Id-grammar validation

Scheduler ids match `{contributingPluginId}.{kebab-suffix}` — the
same grammar used for petitioner sources, link-kinds, and Lattice
trigger types. The kebab-case suffix regex is the shared
`^[a-z0-9]+(?:-[a-z0-9]+)*$` pattern.

- **Prefix mismatch** → startup hard-fails with a diagnostic naming
  the offending id and the contributing kit.
- **Malformed kebab-case suffix** → same hard-fail policy.
- **Duplicate id across two kits** → startup hard-fails naming both
  kits.
- **Missing or wrong-typed `evaluate` / non-string id / non-string
  description** → startup hard-fails per the
  `[reckoner] Kit "<id>" schedulers:` shape.
- **Sealing.** The registry seals at the framework's
  `phase:started` signal. Post-seal registration attempts throw a
  sealed-registry error patterned on the petitioner-registry
  diagnostic shape (`[reckoner] registerSchedulers: …`).

### Selector resolution

At `phase:started`, immediately after both registries seal, the
Reckoner resolves the active scheduler from `guild.json
reckoner.scheduler`:

- **Unset** → defaults to `reckoner.always-approve` and emits one
  info-level log line.
- **Set to a registered id** → caches that instance for the seal's
  life.
- **Set to an unregistered id** → throws fail-loud at startup with a
  diagnostic listing every registered id (the
  `[reckoner] guild config: scheduler …` prefix).

Resolution is one-shot at startup; selector errors surface where
they are catchable, not deferred to per-call.

### Per-evaluation config flow

`reckoner.schedulerConfig` is re-read from `guild.json` on every
consideration so operators can hot-edit. The Reckoner does not
narrow this value — each scheduler's `validateConfig`, when
declared, is the trust boundary. The narrowed result becomes
`SchedulerInput.config` for the immediately-following `evaluate`
call.

### Outcome mapping

The three `SchedulerDecision` outcomes map to apparatus actions:

| Outcome   | Phase transition       | Reckonings row | Notes |
|-----------|------------------------|----------------|-------|
| `approve` | `new` → active target  | `accepted`     | The target is the writ-type config's active state; weight (if present) is threaded onto the row. |
| `defer`   | none                   | `deferred`     | The writ stays in `new`. The row carries `deferReason: 'other'` and the decision's `reason` in `deferNote`; other defer-metadata fields stay absent until a real consumer earns them. |
| `decline` | `new` → `cancelled`    | `declined`     | The decision's `reason` is recorded as the writ's resolution string; the row carries `declineReason: 'other'` and the reason in `remediationHint`. |

### Dependency-aware defer

Between source-registration enforcement and the scheduler call, the
Reckoner runs a per-petition dependency gate. Every held writ's
outbound `depends-on` links are walked (filtered by `link.kind ===
'depends-on'`), each target is classified via the target's writ-type
config attrs, and the per-target classifications are aggregated into
one of three outcomes:

| Outcome           | Phase transition | Reckonings row | Notes |
|-------------------|------------------|----------------|-------|
| `proceed`         | none yet         | none yet       | All targets are *cleared* (or the writ has no `depends-on` links). The scheduler runs next. |
| `defer-pending`   | none             | `deferred`     | At least one target is non-terminal (gating). The row carries `deferReason: 'dependency_pending'` and `deferNote: 'gating: <id>, ...'`. |
| `defer-failed`    | none             | `deferred`     | At least one target is terminal-but-not-cleared (failed-precedence: takes priority over any gating targets). The row carries `deferReason: 'dependency_failed'` and `deferNote: 'failed: <id>, ...'`. |

**Per-target classification (D2 of the dependency-aware-consideration
commission).** Read `clerk.getWritTypeConfig(target.type)` and look up
the state matching `target.phase`:

- **cleared** iff `state.classification === 'terminal'` AND `state.attrs` includes `'success'` OR `'cancelled'`.
- **failed**  iff `state.classification === 'terminal'` (and the cleared attrs are absent — catches `failure`, terminal-`stuck`, or any plugin-contributed terminal that does not declare success/cancelled).
- **gating**  iff `state.classification !== 'terminal'`.

Cancelled is success-equivalent in v0 — a withdrawn dependency
releases its dependents the same way a successful one does (D2).
A dangling target (the link points at a writ that no longer exists in
the writs book) is treated as gating per Spider precedent — the link
was created against a live target, so a missing target is an
operator/data-integrity condition better surfaced as "still gated"
than as "ready". A target whose writ-type config is missing or whose
stored phase is not declared in its config throws fail-loud with the
`[reckoner]` diagnostic prefix; defer-as-gating or treat-as-failed
would silently absorb registration drift.

**Row-shape note.** Dependency-defer rows do not carry `deferUntil`
or `deferSignal` — those companion fields remain reserved on the row
schema as forward-compat for a future event-driven wake-up
mechanism. The running counters (`deferCount`, `firstDeferredAt`,
`lastDeferredAt`) live on the `ReckonerStatus` snapshot at
`writ.status['reckoner']` rather than on the row; see
[Staleness diagnostic](#staleness-diagnostic) below. The row's
audit trail is the `deferNote` field, which lists the gating or
failed dep writ ids.

**Rule ordering.** Disabled-source decline and source-registration
enforcement run *before* the dependency check. A disabled-source writ
produces a `source_banned` decline + transition to cancelled and no
dep evaluation; an unregistered-source writ under
`enforceRegistration: true` declines + transitions and never reaches
the dep check.

**Cadence and idempotency.** The dependency check runs on every tick —
it is not gated by the existing `(writId, writUpdatedAt)` dedupe
(which counts only non-deferred prior rows, so a deferred writ stays
free for re-evaluation at the same `writUpdatedAt`). Re-evaluating a
deferred writ at the same outcome shape suppresses the row write
rather than emitting a heartbeat duplicate; a fresh row appears only
when the outcome shape changes (a dep cleared, a new dep failed, the
dep set's classification mix changed). The wake-up mechanism in v0
is the polling tick — deferred dependents do not subscribe to
wake-up events on dependency-target updates.

### Staleness diagnostic

The Reckoner maintains a derived snapshot at `writ.status['reckoner']`
on every held writ, kept in sync by a Phase-2 CDC watcher on the
Reckoner's own `reckonings` book. Each `create` event on a Reckonings
row runs through the staleness handler, which derives the next
`ReckonerStatus` from the row plus the writ's prior snapshot and
writes it back through `clerk.setWritStatus(writId, 'reckoner', next)`.
The watcher is registered in `start()` ahead of `phase:started`, so
it closes before the first event flows.

```typescript
interface ReckonerStatus {
  decision:         'accepted' | 'deferred' | 'declined' | 'no-op';
  deferReason?:     ReckoningDeferReason;       // mirrored from the row
  deferCount?:      number;                     // running count of deferrals
  firstDeferredAt?: string;                     // ISO timestamp
  lastDeferredAt?:  string;                     // ISO timestamp
  stalled?:         boolean;
  stalledReason?:   'dependency_failed';        // singleton literal in v0
  stalledSince?:    string;                     // first-seen-as-stalled ISO
  lastEvaluatedAt:  string;                     // most-recent considered-at
}
```

**v0 threshold table.** The stalled flag is set per a hardcoded
per-defer-reason table. Only `dependency_failed` flags at
`defer_count >= 1` (immediate); every other reason leaves the flag
unset.

| Defer reason          | Threshold        | Stalled |
|-----------------------|------------------|---------|
| `dependency_failed`   | `defer_count ≥ 1` | yes — `stalledReason: 'dependency_failed'` |
| `dependency_pending`  | n/a              | no |
| every other reason    | n/a              | no |

The threshold table is hardcoded — there is no operator knob, and
configurability earns its existence from a second consumer.

**Petitioner-withdrawal cross-check.** A petitioner-initiated
withdrawal (`clerk.transition(writId, 'cancelled', …)` or
`reckoner.withdraw(writId)`) bypasses the Reckoner entirely and
produces no Reckonings row, so the snapshot's `decision` may lag the
writ's actual phase. Consumers reading the snapshot should
cross-check `writ.phase` to detect this lag — a writ whose phase is
`cancelled` while the snapshot still reads `deferred` was withdrawn
out of band.

**`lastEvaluatedAt` cadence.** The dependency-aware-consideration
commission's no-op-row suppression rule means the Reckoner only
emits a fresh deferred row when the outcome shape changes. During
stable-stalled stretches the Reckoner re-runs the dep gate every
tick but writes no row, so `lastEvaluatedAt` does not advance —
only outcome-shape changes produce a fresh row, and only fresh rows
update the snapshot.

**Counter semantics.**

- `deferCount` advances only on rows with `outcome === 'deferred'`
  (D9). No-op rows and terminal rows do not advance it.
- Running counters are preserved verbatim across `deferred →
  accepted` and `deferred → declined` transitions (D10) — the
  counters record historical deferrals; clearing them on a terminal
  decision would lose the "deferred N times before being accepted"
  signal.
- `stalled` / `stalledSince` transitions follow the brief: a
  false → true transition takes the row's `consideredAt` as
  `stalledSince`; a true → true transition preserves the prior
  `stalledSince` verbatim; any → false transition clears both
  fields (D11).
- A `'no-op'` row bumps `lastEvaluatedAt` only and preserves every
  other field (D19). The decision, deferReason, counters, and
  stalled state are all carried forward verbatim because a no-op
  row records "I re-considered and held without changing state."

**Failure handling.** The watcher runs Phase-2
(`failOnError: false`) — a snapshot-write failure must never roll
back the journal entry that drove it. The `setWritStatus` call is
wrapped in a `try/catch` that logs with a `[reckoner]` prefix and
the offending writ id (covering both the writ-not-found case and
any other write failure). Shape-mismatch errors thrown by the
snapshot derivation are NOT caught — they propagate to the Stacks
Phase-2 error path so migration drift surfaces loudly.

### Per-tick failure modes

The tick handler runs the active scheduler once per fire over the
entire surviving candidate set. The table below summarises how each
failure mode is handled — note that several failures fail-loud-skip
the **whole tick**, not just the offending writ:

| Condition                                                          | Behavior |
|---|---|
| Tick fires before `phase:started` (active scheduler not yet resolved) | Throws fail-loud with `[reckoner] tick: activeScheduler not resolved …`. Production should never trip this; tests can assert the throw. |
| Held-petition query returns an empty set                            | Early return — no scheduler call, no rows, no errors. |
| Disabled-source / unregistered-strict gate matches                  | Per-writ `declined` row + transition to cancelled (the writ is dropped from the candidate set the scheduler sees). |
| Dedupe lookup short-circuits on the same `(writId, writUpdatedAt)`  | The writ is dropped from the candidate set before the scheduler is called; no row, no transition. |
| `validateConfig` throws                                             | Fail-loud log via the `[reckoner] scheduler:` prefix; the **entire tick is skipped** (no row written for any candidate). |
| `evaluate` throws or does not return an array                       | Fail-loud log; the entire tick is skipped. |
| Decision carries a `writId` not in the candidate set                | Per-decision `console.warn` naming the offending id; ignore-and-continue (in-scope decisions still apply). |
| Two decisions target the same `writId`                              | Fail-loud log; the **entire tick is skipped** (no decision applied for any writ). |
| Decision carries an unknown outcome                                 | Fail-loud log; that decision is ignored, sibling decisions still apply. |

---

## Workflow-2: petition()

### Create + stamp (one-shot)

```typescript
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { guild } from '@shardworks/nexus-core';

const reckoner = guild().apparatus<ReckonerApi>('reckoner');

const writ = await reckoner.petition({
  source: 'tech-debt.detected',
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
  labels:  { 'tech-debt.io/finding-id': 'q3-audit' },
});
```

After this call, the writ exists in its registered initial phase
with `writ.ext.reckoner = { source, priority, complexity, payload,
labels }`. The next periodic tick after `phase:started` picks it
up.

### Draft-then-publish (stamp-only)

When the petitioner needs to wire `clerk.link()` dependencies (or
any other writ-graph prep) onto a writ before it becomes Reckoner-
visible, post the writ first, perform the prep, then call the
stamp-only form to publish:

```typescript
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';
import { guild } from '@shardworks/nexus-core';

const clerk    = guild().apparatus<ClerkApi>('clerk');
const stacks   = guild().apparatus<StacksApi>('stacks');
const reckoner = guild().apparatus<ReckonerApi>('reckoner');

// Post the draft writ. It is in its initial phase but not yet
// Reckoner-visible (no ext.reckoner).
const draft = await clerk.post({
  title: 'Address vision drift',
  body:  '...',
});

// Wire the link and stamp ext.reckoner inside a single transaction
// so the writ becomes Reckoner-visible only after the outer commit.
await stacks.transaction(async () => {
  await clerk.link(draft.id, blockerId, 'depends-on');
  await reckoner.petition(draft.id, {
    source:   'tech-debt.detected',
    priority: { visionRelation: 'vision-violator' },
  });
});
```

The stamp-only form fails loud (with no writ mutation) when the
writ is past its initial phase, when `ext.reckoner` is already
present, or when the writ id does not exist. See the
`ReckonerApi.petition` interface above for the full guard set.

---

## What the Reckoner does NOT do (in v0)

- **No CDC observer on `clerk/writs`.** Per-writ-update evaluation is
  out of scope; the periodic tick is the single evaluation entry.
- **No operator-configurable tick cadence.** The `@every 60s`
  schedule is hard-coded in the kit-contributed standing order.
  There is no `reckoner.tickSchedule` knob and no way to disable
  the standing order short of removing the apparatus. Future
  improvement is parked.
- **No tick disable / pause mechanism.** Operators have no
  config-side way to suspend the tick.
- **No Lattice pulses.** The Reckoner does not emit pulses; the
  auto-wired `book.reckoner.reckonings.{created,updated,deleted}`
  Clockworks events are sufficient for v0 consumers.
- **No `CapacitySnapshot` fields.** v0 ships the empty stub;
  capacity-tracking lands when a capacity-aware scheduler does.
- **No multi-scheduler dispatch in one tick.** One active scheduler
  per Reckoner instance.
- **No new framework events on tick.** The auto-wired Clockworks
  book events on `reckoner/reckonings` continue to fire as they do
  today; the tick handler emits no new events.
- **No re-prioritization on already-`open` writs.** Mutating
  `ext.reckoner.priority` on an accepted writ is a different
  operation than petitioning and is not addressed here.
- **No cross-apparatus authoring.** Apparatus X creates the writ
  and apparatus Y stamps `ext.reckoner` is not addressed here —
  parked at the parent click.
- **No atomic `clerk.post() + setWritExt()` bundling.** The
  create+stamp form remains two underlying Clerk calls; atomicity
  inside a single transaction is the petitioner's concern via the
  stamp-only form composed with `stacks.transaction(...)` (see
  above).
- **No `no-op` outcome rows, throttling, or per-source quotas.**
  Reserved for future commissions. (Dependency-aware deferral *is*
  implemented as a tick step — see "Dependency-aware defer" above
  — and the scheduler-emitted `defer` outcome now writes a
  deferred row with `deferReason: 'other'`.)
- **No `dependency_failed` petitioner notification.** Cycle
  visibility through Lattice channels, dangling-target escalation,
  and explicit petitioner-side wake-ups on dependency failures
  remain parked. The staleness diagnostic surfaces the stalled
  state on the writ's snapshot (see [Staleness diagnostic](#staleness-diagnostic));
  pushing that signal into a notification path is a separate
  follow-up.
- **No event-driven wake-up via `defer_signal`.** `deferSignal`
  remains reserved on the Reckonings record. Dependency-deferred
  petitions wake up on the next polling tick only — the Reckoner
  does not subscribe to writ-completion events on the dep target's
  side to drive an immediate re-evaluation.
- **No Stacks transaction wrapping `petition()`.** The two-step
  flow is the chosen design (D7). The orphan-window observations
  are recorded in the contract document.
- **No `ext` field on `clerk.post()`.** Clerk's
  `PostCommissionRequest` is unchanged; the ext slot is written
  via the `setWritExt` call.
- **No silent re-stamping or deep-compare in the stamp-only form.**
  An already-petitioned writ fails loud; petitioning is a one-time
  act.
- **No `defaultPriority()` export.** Internal helper only (D14).
- **No `contributingPluginId` / timestamps on
  `PetitionerDescriptor`.** Contract floor only (D19).
- **No source/owner check inside `withdraw()`.** Thin pass-through
  (D10).
- **No explicit Stacks dependency.** `requires: ['clerk']`
  only (D16); Stacks is transitive through Clerk.
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
