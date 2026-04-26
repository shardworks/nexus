# Petitioner Registration — Contract

Status: **Draft**

> **⚠️ v0 scope.** This document fixes the *registration-side* contract
> between the (forthcoming) petition-scheduler Reckoner and the plugins
> that emit petitions to it. v0 covers the registration call shape, the
> source-id registry, the handle-rooted emit and withdraw surface, the
> three opt-in feedback channels, the authority-to-priority gate, and
> the v0 stance on lifecycle hooks (none) and shared base classes
> (none — recipes only). The intake-side validators, the Reckonings
> book schema, the patron-emit surface (CLI / MCP), the renamed
> queue-observer / pulse-emitter, and any non-`patron` / non-`vision-keeper`
> petitioner are explicitly out of scope. See [Open Questions](#open-questions)
> for the named follow-ups.

---

## Dependencies

```
contract spans: ['clerk', 'clockworks', 'lattice', 'spider']
```

- **The [Clerk](apparatus/clerk.md)** — the closest live precedent for a
  runtime-laden, single-surface, programmatic registry sealed at
  `phase:started`. The petitioner registry mirrors Clerk's writ-type
  registry almost verbatim (registration call shape, duplicate check,
  fail-loud-on-unknown stance, self-registration of the framework's
  one mandatory entry).
- **[Clockworks](clockworks.md)** — the event-and-CDC substrate the
  feedback-receipt section routes through. Standing orders and the
  auto-wired `book.<owner>.<bookName>.{created,updated,deleted}` events
  are the only sanctioned petitioner-feedback path in v0.
- **The [Lattice](apparatus/lattice.md)** — the source of the
  `{pluginId}.{kebab-suffix}` source-id grammar this contract adopts,
  and the precedent the doc's identity section explicitly diverges
  from (Lattice trusts emitter-stamped `pulse.source` strings; this
  contract returns a typed handle and stamps the source internally).
- **The [Spider](apparatus/spider.md)** — the source of the
  framework-wide kit-vs-kit collision policy this contract adopts:
  a duplicate registration with the same source string is a hard
  startup error that names both contributing plugins.

---

## 1. Registration mechanism

A plugin declares itself a petitioner by calling `registerPetitioner` on
the Reckoner's runtime API from inside its own apparatus's `start()`:

```typescript
const handle: PetitionerHandle = reckoner.registerPetitioner({
  source: 'vision-keeper.snapshot',
  allowedPriorities: ['urgent', 'normal', 'low'],
  description: 'Periodic vision-vs-reality snapshots emitted when '
             + 'the keeper observes drift worth surfacing.',
});
```

Registration is **programmatic only**. There is no `petitioners` field
on a kit export, no `guild.json` registry of declared sources, and no
declarative side-channel that completes the binding without a runtime
call. `registerPetitioner` is the single-surface entry point — the
same trade-off the Clerk made for writ types (per `c-mod9a2gh`):
petitioners are runtime-laden (the registration call returns a handle
that closes over the source string and the allowed-priority allow-list
and that is the only path through which `emit` and `withdraw` can be
reached), and a static kit channel cannot complete the runtime-binding
step on its own. Co-locating registration with the apparatus's
runtime state keeps the binding mechanical and the call site grep-
findable.

Each `registerPetitioner` call accepts the static descriptor below
(D8 — no hooks in v0; D7 — `allowedPriorities` is the authority gate's
canonical home):

```typescript
interface RegisterPetitionerRequest {
  /** Fully-qualified source id. See §2 for the grammar. */
  source: string;
  /**
   * Priority levels this source may emit. Optional; omitting yields
   * the default `['urgent', 'normal', 'low']`. See §7 for the gate.
   */
  allowedPriorities?: PetitionPriority[];
  /** Short human-facing description for diagnostics and Oculus. */
  description: string;
}
```

No optional `onAccept` / `canRetry` / `onDefer` hooks are accepted in
v0. The deferred hook surface is named in [Open Questions](#open-questions);
the rationale is that the upstream conclusion (per `c-mod9a48y`)
already settled "no direct callback mechanism in v0," and the
observation need is covered by the CDC + standing-order recipes in
§4 without an additional invocation-ordering contract.

### Registry seal

The petitioner registry seals at the framework's global
`phase:started` signal — the moment every apparatus's `start()` has
finished. After the seal, every `registerPetitioner` call throws
with a clear `[reckoner] registerPetitioner: cannot register
petitioner "<source>" — the startup registration window has closed.`
diagnostic, naming the offending source. This matches the writ-type
seal in the [Clerk](apparatus/clerk.md#writ-type-registry): the
"apparatus startup is the registration window" invariant is framework-
wide, not Reckoner-specific. By the time the first `crawl()` /
scheduler tick runs, the registry is inspectable and immutable.

### Kit-vs-kit collision policy

Two `registerPetitioner` calls with the same `source` string are a
**hard error**. The second call throws at registration time with a
diagnostic that names *both* contributing plugin ids and the
conflicting source — the winner is never selected by load order. This
mirrors the framework-wide rule the Spider documents for
`rigTemplateMappings` (per `c-mod9a6x3`'s lineage) and that
[Clerk applies to writ-types](apparatus/clerk.md#writ-type-registry),
[Spider to `blockTypes` / `rigTemplateMappings`](apparatus/spider.md#plugin-default-template-and-mapping),
and the Fabricator to engine designs:

> Two kits contributing a [registration entry] for the same key —
> including a plugin's own self-registered defaults — refuse to start
> the guild; the startup error names both contributing plugins and
> the conflicting key.

Silent first-or-last-wins is rejected because a typo in a source string
would silently corrupt the registry — exactly the failure mode the
fail-loud rule exists to surface.

---

## 2. Petitioner identity

The Reckoner maintains a closed registry of petitioner sources. Only a
source registered through `registerPetitioner` may emit; an unknown
source at emit time is unreachable through the handle surface (see §3)
and any direct intake call carrying an unregistered source is
rejected fail-loud — there is no silent fallback. The closure stance
is free: the registry already exists for authority-gating metadata
(see §7), so closing it merely refuses unannounced sources rather than
silently letting them propagate. This is the same trade-off the
[Clerk's writ-type registry](apparatus/clerk.md#writ-type-registry)
takes — closure plus a fail-loud "Registered sources: …" diagnostic
beats silent acceptance every time.

### Source-id grammar

A source id has the form **`{pluginId}.{kebab-suffix}`** — the
contributing plugin's derived id, a literal `.`, then a kebab-case
suffix (lowercase letters, digits, and single-hyphen separators; no
leading or trailing hyphen). The grammar matches
[Lattice trigger-types](apparatus/lattice.md) and
[Clerk link-kinds](apparatus/clerk.md#kit-interface). Examples:

- `vision-keeper.snapshot`
- `vision-keeper.drift-detected`
- `coinmaster.balance-low` (illustrative future consumer)

The `{pluginId}.` prefix is validated at registration time wherever the
plugin id is derivable from the call site — same pattern the
[Clerk uses for link-kind ids](apparatus/clerk.md#linkkinds-registry):
malformed ids and mismatched prefixes hard-fail at the registration
call, never at first emit. Cross-plugin collisions are made structurally
impossible by the prefix rule and operationally impossible by the
duplicate-registration check in §1.

The one hard-coded exception is **`'patron'`** — a bare, prefix-free
identifier reserved for the patron's own elevated emit path. The
Reckoner self-registers this source from its own `start()` (see §6),
so the exception is internal to the apparatus that enforces the
gate — third-party plugins can never reach this name through the
public API.

### Source authentication — handle-based

The source field on every emitted petition is **never passed as a
string by callers**. `registerPetitioner` returns a typed
`PetitionerHandle` (see §3) whose `emit` and `withdraw` methods stamp
the handle's bound source field internally. The caller's only path
to emit is through the handle returned by their own registration
call, so the `source` field on a petition is mechanically guaranteed
to match the registering plugin.

This is a **deliberate divergence** from the
[Lattice](apparatus/lattice.md)'s emitter-trust model, where
`pulse.source` is a string the emitter stamps and the substrate
trusts (per the Lattice's D21). Petitions carry authority weight
(`priority=immediate` is gated on `source=patron`; see §7), so
trusting an emitter-supplied string would let a typo in *any*
emit call site silently elevate authority. With handle-based
stamping a misnamed source becomes a TypeScript error or an
unreachable call path, not a runtime authority drift. The handle is
also the natural carrier for petitioner-scoped withdraw (see §3).
The handle-vs-trust-stamp tradeoff is named in
[Open Questions](#open-questions) for the case where a non-handle-
reachable caller eventually appears.

---

## 3. Emit-petition interface

### `PetitionerHandle`

`registerPetitioner` returns a typed handle. The handle is the **sole**
runtime surface a petitioner uses to interact with the Reckoner —
there is no global `reckoner.emitAs(source, …)` shortcut, no string-
keyed lookup, and no way to recover a handle from outside the
registering plugin's `start()`.

```typescript
interface PetitionerHandle {
  /** The source string this handle stamps onto every emit/withdraw. */
  readonly source: string;

  /** The priority levels this handle is permitted to emit at. */
  readonly allowedPriorities: readonly PetitionPriority[];

  /**
   * Emit a petition. Returns the persisted PetitionDoc.
   * The caller does NOT pass `source`; the handle stamps it.
   */
  emit(request: EmitPetitionRequest): Promise<PetitionDoc>;

  /**
   * Withdraw a previously-emitted petition. The handle's source
   * must match the petition's source — cross-source withdraw throws.
   */
  withdraw(petitionId: string, reason?: string): Promise<PetitionDoc>;
}
```

The handle's `readonly source` and `readonly allowedPriorities` fields
are diagnostic — useful inside the registering plugin for logging and
for sanity-checking the inputs to a `with:` block — but they are not
the binding mechanism. The binding is closure: `emit` and `withdraw`
close over the registration record at the moment `registerPetitioner`
returns, and the registration record is the one the registry validates
against on every call.

### `emit` — call shape and return type

The emit call carries the petition payload minus the source field
(stamped by the handle) and minus any lifecycle metadata (set by the
Reckoner on persist):

```typescript
interface EmitPetitionRequest {
  /** What the petitioner wants the Reckoner to schedule. */
  intent: string;

  /** Priority — must appear in this handle's allowedPriorities. */
  priority: PetitionPriority;

  /** Optional structured payload — petitioner-defined shape. */
  context?: Record<string, unknown>;

  /** Optional writ binding — when non-null, the petition is writ-scoped. */
  writId?: string | null;
}

handle.emit({ intent, priority, context, writId }):
  Promise<PetitionDoc>
```

Note the absence of any `source` parameter — there is no place in this
contract where a caller passes a `source` string to emit. Every
example in this document is handle-rooted for the same reason.

`emit` is **final-on-call**. There is no draft phase, no
`emitDraft()`, no `handle.partial()`, and no commit step. The
petition lands in the Reckoner's `pending` state immediately and
becomes visible to the scheduler on its next tick. v0 deliberately
omits the draft surface: the petition shape is already coarse, and
adding a draft state would duplicate the [Clerk's `new` phase](apparatus/clerk.md#mandates-lifecycle-an-example-registered-type)
without a named consumer to motivate the second-write step.
Petitioners that need to assemble data across multiple steps assemble
it before calling `emit`. Adding drafts later is purely additive — a
future `handle.draft(...)` returning a draft handle would not
invalidate any v0 caller — and is named in
[Open Questions](#open-questions) as a deferred consideration.

The emit return type is the **full persisted `PetitionDoc`** — same
shape the Reckoner stores in the petitions book, including its
generated id, timestamps, lifecycle state, and the Reckoner-stamped
fields the petitioner did not supply. This mirrors
[`ClerkApi.post`](apparatus/clerk.md#clerkapi-interface-provides) and
[`LatticeApi.emit`](apparatus/lattice.md#latticeapi-interface-provides):
both return the complete persisted document so the caller can chain
reads, log the resulting id, or pin observability without a second
lookup. A handle-tuple shape (`{ id, ack }`) was considered and
rejected — neither adjacent API earns a richer return shape, and
handle returns are unearned generality.

### `withdraw` — petitioner-initiated

A petitioner may withdraw a petition it previously issued by calling
`withdraw` on the **same handle** that issued it:

```typescript
await handle.withdraw(petitionId, 'Snapshot superseded by drift '
                                + 'detected before this one ran.');
```

The withdraw call's contract:

- **Handle-scoped.** The Reckoner asserts that the petition's stored
  `source` matches the handle's bound source. A petitioner trying to
  withdraw another petitioner's petition throws fail-loud — the lookup
  is structurally one-source-only. "Only the issuing source can
  withdraw" is enforced by reachability, not by a runtime authority
  check.
- **Allowed only from non-terminal states.** A petition can be
  withdrawn while it is in `new`, `pending`, or `deferred`. Petitions
  in any terminal state — already accepted, declined, executed, or
  withdrawn — reject the call. The terminal-state list is the
  petition lifecycle's own (per `c-modaqnpt`); withdraw lands the
  petition in the lifecycle's petitioner-initiated `withdrawn`
  terminal.
- **Optional reason.** A short freeform string surfaced on the
  resulting decline-feedback channel and persisted on the petition
  document. Omitting it is allowed; passing one helps the standing-
  order recipes in §4 explain themselves to the patron.
- **Returns the updated `PetitionDoc`.** Same shape as `emit`'s
  return — the post-transition snapshot, useful for logging the
  resolved-at timestamp without a second read.

There is no Reckoner-initiated withdraw call exposed on the handle.
The Reckoner's own decline / defer transitions are observed through
the feedback recipes in §4; they are not invoked by the petitioner.

---

## 4. Feedback receipt patterns

A petitioner observes what happened to its petitions through
**[Clockworks](clockworks.md) standing orders** keyed on the
auto-wired CDC events the Reckonings book emits. There is no
`handle.onStateChange(callback)` API and no in-process subscribe
surface on the Reckoner — the v0 conclusion (per `c-mod9a54n`) is
that a parallel handle-subscribe path would duplicate the substrate
that already exists, lack durability and replay across daemon
restarts, and add an invocation-ordering contract the framework has
not yet earned. Standing orders are durable (the trigger lives in
`guild.json`), survive process restarts, and slot into the same
event-routing fabric every other apparatus uses.

The Reckonings book is owned by the Reckoner and its CDC events are
auto-wired by [Clockworks](clockworks.md#book-change-events-stacks-auto-wiring)
through the standard
`book.<ownerId>.<bookName>.{created,updated,deleted}` pattern — the
same substrate every other plugin's books ride on. (The book exists
and is CDC-attached; its specific record fields and payload schema
are owned by the parallel Reckonings-book commission, per
`c-modeou1t`. This contract relies only on the existence of CDC
events keyed by the petition's `source`, not on any specific
schema field.)

A petitioner picks one of three opt-in feedback channels.

### Channel 1 — event-driven standing order (the canonical path)

The recommended channel. The petitioner declares a standing order in
`guild.json` keyed on the petitions book's `updated` event, filtered
to its own source via the standard standing-order filter the order
hands to its relay through `with:`. The relay reads the post-commit
event payload, decides whether the lifecycle change is one the
petitioner cares about, and re-emits / cleans up / notifies as
appropriate.

The vision-keeper's decline-watch recipe:

```jsonc
{
  "clockworks": {
    "standingOrders": [
      {
        "on": "book.reckoner.petitions.updated",
        "run": "vision-keeper-on-decline",
        "with": {
          "filterSource": "vision-keeper.snapshot",
          "filterTerminalAttr": "declined"
        }
      }
    ]
  }
}
```

The relay's handler (a vision-keeper-side relay contributed via the
plugin's [`ClockworksKit`](clockworks.md#clockworkskit)) inspects the
event payload at handler time:

```typescript
// vision-keeper/src/relays/on-decline.ts
import { relay } from '@shardworks/clockworks-apparatus';

export default relay({
  name: 'vision-keeper-on-decline',
  handler: async (event, { params }) => {
    const entry  = event?.payload?.entry as { source?: string; ... };
    if (!entry || entry.source !== params.filterSource) return;
    // Inspect the entry's lifecycle attrs / decline reason and re-emit
    // the snapshot petition with adjusted context, log to the keeper's
    // own book, ping a Lattice channel — whatever the keeper does on
    // a decline. The handle (closed over from the keeper's start())
    // is reachable through `guild().apparatus(...)` for the keeper's
    // own runtime API.
  },
});
```

Two things worth highlighting. First, the filter on
`event.payload.entry.source` is the load-bearing one — every
petition-book CDC event carries the entry as its payload, and the
source field is what scopes the keeper's relay to its own petitions
without coupling to other plugins' sources. Second, the standing
order points at a relay the keeper itself ships in its
`supportKit.relays`; standing orders never name the petitioner
plugin directly.

The `book.reckoner.petitions.updated` event name is the auto-wired
form (`book.<ownerId>.<bookName>.updated`) — the petitioner does not
need to declare the event in `clockworks.events`; it is supplied by
the Stacks-Clockworks bridge automatically.

### Channel 2 — polling the petitions book

For petitioners that need point-in-time aggregate state (a status
dashboard, a periodic reconciliation pass, a quick "do I have
anything outstanding?" check), the channel is a direct read of the
Reckonings book filtered by the petitioner's own source:

```typescript
// In a vision-keeper-owned tool or scheduled relay handler:
const stacks  = guild().apparatus<StacksApi>('stacks');
const book    = stacks.book<PetitionDoc>('reckoner', 'petitions');
const mine    = await book.list({
  where: [['source', '=', 'vision-keeper.snapshot']],
});
const pending = mine.filter((p) => p.lifecycleClassification !== 'terminal');
```

Polling is appropriate when the petitioner wants a snapshot rather
than a stream — daily reports, reconciliation, ad-hoc inspection.
For event-by-event reaction, prefer Channel 1 — polling cannot
distinguish a transition from steady state without keeping its own
side-channel state.

### Channel 3 — fire-and-forget

The third channel is no channel at all: the petitioner emits and
walks away. Acceptance, decline, defer, or successful execution all
happen without the petitioner ever observing the outcome. Re-emission
is driven by the petitioner's own conditions — when the same
condition triggers again, the petitioner emits again; the Reckoner's
lifecycle (per `c-modaqnpt`) handles dedupe / supersede on its own.

Fire-and-forget is the right channel for petitioners whose intent is
"I noticed *X* happened; route this to the scheduler if it matters."
A `vision-keeper.snapshot` triggered hourly by a cron-like relay can
emit without subscribing — if it is declined as a duplicate of an
in-flight snapshot petition, the next hour's tick will emit again
when the keeper's conditions re-evaluate. The petitioner never has
to encode lifecycle reactions; the cadence handles it.

### Channel selection — recommended order

| Need | Channel |
|------|---------|
| React to declines / defers / completions in real time | **1 — standing order** |
| Periodic reconciliation, dashboards, "what's outstanding?" | **2 — polling** |
| "I noticed *X*; route it" with no follow-up | **3 — fire-and-forget** |

A petitioner is free to combine channels (a dashboard tool polling +
a relay reacting to declines) — they observe the same underlying
book through the same auto-wired CDC substrate. The recipes do not
compete; they slice the same data different ways.

---

## 5. Lifecycle hooks

**v0 declares no lifecycle hooks.** A petitioner's full declarative
surface is the three-field `RegisterPetitionerRequest` shape from §1
(`source`, `description`, and the optional `allowedPriorities` whose
default is `['urgent', 'normal', 'low']`):

```typescript
interface RegisterPetitionerRequest {
  source:             string;
  allowedPriorities?: PetitionPriority[];
  description:        string;
}
```

There is no `onAccept`, no `canRetry`, no `onDefer`, no `onWithdraw`,
no per-petitioner intake validator, and no callback that runs on the
Reckoner's process before a petition is persisted. The upstream
conclusion (per `c-mod9a48y`) was that a hook surface is "no direct
callback mechanism in v0," and this contract makes that final.

The reasoning is twofold: the observation need is already covered by
the CDC + standing-order recipes in §4 without an additional
invocation-ordering contract, and pre-empting hooks now keeps the
petition lifecycle's observe-and-re-emit pattern uniform across every
petitioner. A hook surface that runs in the Reckoner's process would
introduce ordering questions (does `canRetry` race with the parent's
update event? does an `onDefer` throw block the defer transition?)
that the framework has no precedent to lean on.

**Deferred hook surface.** The most-likely future hooks are named
in [Open Questions](#open-questions) — `canRetry`, `onDefer`,
`onAccept` are the obvious candidates — and re-evaluation is gated on
a real consumer with a concrete need that CDC + re-emit cannot
satisfy. Adding a hook later is additive: a future
`registerPetitioner({ source, allowedPriorities, description, onDefer })`
shape does not invalidate any v0 caller.

---

## 6. Built-in petitioner classes

v0 ships with exactly **two** built-in petitioner classes. Both are
the smallest set the contract needs to be coherent and testable.

### `'patron'`

The patron's elevated petition source. Registered by the **Reckoner
itself** from its own `start()` — the Reckoner is the apparatus that
enforces the authority gate (see §7), so self-registering the one
identity that gate requires keeps the invariant local. This mirrors
the [Clerk's self-registration of `mandate`](apparatus/clerk.md#writ-type-registry):
the framework's one mandatory registry entry is contributed by the
apparatus that owns the registry, not by an external kit.

The patron source is the hard-coded exception to the
`{pluginId}.{kebab-suffix}` grammar from §2. The bare `'patron'`
identifier is reserved; third-party plugins cannot register it
(blocked by the duplicate-source check in §1) and cannot reach the
Reckoner-issued patron handle.

How the patron *invokes* emit — the CLI surface, the MCP tool, the
`commission-post` interaction — is **not** part of this contract. A
downstream commission designs the patron-emit surface against the
internally-issued handle. This document fixes only how `'patron'` is
*registered*, not how the patron *invokes* emit.

### `'vision-keeper'`

The canonical worked example of a third-party petitioner. The
vision-keeper exercises every contract surface in this doc:

- It registers via `registerPetitioner` from its own apparatus's
  `start()` (§1).
- It declares a qualified source id `vision-keeper.snapshot` (§2).
- It calls `handle.emit(...)` with `priority: 'urgent' | 'normal' | 'low'`
  drawn from the default allow-list (§7).
- It withdraws superseded petitions through `handle.withdraw(...)` (§3).
- It observes outcomes through a Channel-1 standing order on the
  petitions book filtered by its own source (§4).

Every example in this document is calibrated against the keeper.

### Future consumers — out of scope for v0

The renamed pulse-emitter (the apparatus currently documented as the
[Reckoner](apparatus/reckoner.md)'s queue-observer) is named **only
as a future consumer**, not a v0 deliverable. Its rename and
subsume-later track is a separate commission; pulling it into this
contract would conflate the two. It is named in
[Open Questions](#open-questions) for completeness.

### Shared base classes / utility packages — recipes only

v0 documents shared registration patterns as **worked recipes**, not
as exported base classes or shared utility packages. There is no
`PetitionerBase` to extend, no `mountPetitioner()` helper, no
`@shardworks/petitioner-utils` package. Every petitioner writes the
five-line registration call from §1 against the Reckoner API directly.

Two consumers (`patron` + `vision-keeper`) is below the threshold
where the right shape for a base class becomes obvious — base-class
extraction is the kind of refactor a third petitioner usually
motivates. The earned-extraction stance is named in
[Open Questions](#open-questions).

---

## 7. Authority / priority gating

The `priority=immediate` level is reserved for elevated authority,
and the gate that enforces this is **registration metadata**, not a
hard-coded `if (source === 'patron')` check inside the intake
validator.

Every `registerPetitioner` call carries an `allowedPriorities`
allow-list (optional in the descriptor; `undefined` resolves to the
default `['urgent', 'normal', 'low']`):

```typescript
type PetitionPriority = 'immediate' | 'urgent' | 'normal' | 'low';

interface RegisterPetitionerRequest {
  source:             string;
  allowedPriorities?: PetitionPriority[];
  description:        string;
}
```

The Reckoner's own `start()` registers `'patron'` with the full
allow-list:

```typescript
// inside reckoner apparatus start()
registerPetitionerInternal({
  source: 'patron',
  allowedPriorities: ['immediate', 'urgent', 'normal', 'low'],
  description: 'Elevated patron-originated petitions.',
}, 'builtin');
```

Every other registration (third-party plugins calling the public
`registerPetitioner`) **defaults to** `['urgent', 'normal', 'low']`
when the allow-list is omitted, and the Reckoner refuses any
registration that includes `'immediate'` for any source other than
the self-registered `'patron'`. The refusal is enforced at
registration time, not at first emit — a third-party plugin trying
to register `allowedPriorities: ['immediate', ...]` fails the
guild's startup with a `[reckoner] registerPetitioner: priority
"immediate" is reserved for the patron source` diagnostic.

The emit-time validator (the one that runs inside `handle.emit(...)`)
reads the allow-list from the **registry** for the handle's bound
source — there is no source-name comparison in the validator's body,
no `if (req.source === 'patron')` branch, and no special case for
the patron string. A petition arrives with a priority; the validator
asks the registry "is this priority in this source's allow-list?";
yes admits the petition, no throws fail-loud.

Two properties fall out of this design:

- **The constraint is queryable.** Operators (and the keeper-side
  diagnostic logging) can read `handle.allowedPriorities` to see
  what the petitioner is permitted to emit at, without parsing the
  validator's source code.
- **The gate generalizes to future elevated sources.** If a future
  apparatus needs to emit at `'immediate'` (e.g. a "guild-emergency-
  drain" source), the design space is "the Reckoner registers a
  second internal source with the full allow-list" — the validator
  does not change. There is no domain-specific name baked into the
  gate.

---

## 8. Existing precedents

The petitioner registration contract is not new framework shape — it
composes patterns the framework's adjacent apparatuses have already
settled. This section names *what fits* and *what's different* for
each precedent the contract draws from.

### [Clerk](apparatus/clerk.md) writ-types

**What fits.** Clerk's writ-type registry is the closest live
precedent — same call shape, same seal timing, same fail-loud-on-
duplicate stance, same self-registration of the framework's one
mandatory entry. Specifically:

- `ClerkApi.registerWritType` ↔ `ReckonerApi.registerPetitioner` —
  programmatic, single-surface, called from the contributing
  apparatus's `start()`.
- `phase:started` registry seal ↔ identical seal timing here.
- "Two plugins cannot contribute the same writ type name" ↔
  identical duplicate-source policy here.
- The Clerk's self-registration of `mandate` ↔ the Reckoner's self-
  registration of `'patron'` (per §6).

**What's different.** Writ types are fully static descriptors
(`WritTypeConfig` is a pure data shape — states, classifications,
attrs, transitions). Petitioner registrations bind a runtime closure:
the returned `PetitionerHandle` carries `emit` and `withdraw` closures
that the registering plugin calls into. The writ-type registry has
no per-type runtime handle returned to the caller; the Clerk's
public surface is the same `ClerkApi.transition(id, …)` for every
type.

### [Spider](apparatus/spider.md) rig-template mappings

**What fits.** The framework-wide kit-vs-kit collision policy is the
shape this contract adopts in §1: a duplicate `registerPetitioner`
with the same source string is a hard startup error that names both
contributing plugins, identical to the rule the Spider documents for
[`rigTemplateMappings`](apparatus/spider.md#plugin-default-template-and-mapping)
and that applies framework-wide to Clerk `writTypes`, Spider
`blockTypes`, and Fabricator engines. The winner is never selected
by load order.

**What's different.** Spider's rig-template mappings have a
config-overlay tier: a `guild.json` `spider.rigTemplateMappings`
entry overrides any kit contribution silently. The petitioner
registry has **no config tier** — there is no `reckoner.petitioners`
section in `guild.json` — because the registration is runtime-laden
(it returns a handle the calling plugin needs to hold). A config
overlay would have nowhere to put the handle. Operators resolve
collisions by removing one of the registering plugins, not by
declaring an override.

### [Clockworks](clockworks.md) events / standing orders

**What fits.** The feedback-receipt path in §4 is purely Clockworks'
substrate — the auto-wired
`book.<owner>.<bookName>.{created,updated,deleted}` events, the
standing-order `{ on, run, with? }` shape, the relay handler's
`(event, { params })` signature. The Reckoner does not duplicate
any of this; petitioners reuse the standing-order vocabulary they
already know.

**What's different.** Clockworks itself does not own a registry of
event emitters — any apparatus may signal events into the stream,
constrained only by the reserved-namespace check. The petitioner
registry is exactly the registry Clockworks declines to maintain
for events: it pairs identity with authority metadata and exists
because petitions carry weight (priority gating, withdraw
authorization). Events do not need this; petitions do.

### [Lattice](apparatus/lattice.md) trigger-types

**What fits.** The `{pluginId}.{kebab-suffix}` source-id grammar from
§2 is identical to Lattice's
[`triggerType` grammar](apparatus/lattice.md#latticeapi-interface-provides) —
same prefix derivation, same kebab suffix rule, same "validated where
the plugin id is derivable" policy. Source-of-emission and
trigger-type are independent axes in both contracts.

**What's different.** Lattice trusts the emitter to stamp
`pulse.source` correctly — the Lattice's D21 explicitly says "the
emitter stamps the source field; the Lattice trusts emitters (same
trust model as Stacks books' owner keys)." The petitioner contract
**rejects** that trust model: petitions carry authority weight
(`priority=immediate` is bound to `source=patron`), and a typo in an
emitter-stamped string would silently elevate authority. Returning a
handle that stamps the source internally turns the trust question
into a reachability question — the only path through which `emit`
can be called is the handle returned by a successful registration.

---

## 9. Open Questions

The following follow-ups are deliberately deferred. Each names the
trade-off the contract consciously took, the trigger that would
re-open the question, and the shape the answer would likely take.

### a. Base-class / shared-utility extraction

- **Question.** Should there be an exported `PetitionerBase` class, a
  `mountPetitioner()` helper, or a shared `@shardworks/petitioner-utils`
  package that the third-and-beyond petitioner extends instead of
  hand-writing the registration call?
- **Trade-off.** v0 documents shared patterns as recipes only (per
  D11 in the commission brief). Two consumers (`patron` +
  `vision-keeper`) is below the threshold where the right shape for
  a base class becomes obvious — premature extraction would lock in
  the wrong abstraction and force a second migration when a third
  consumer's needs differ.
- **Re-evaluation trigger.** A third real petitioner whose code
  duplicates a non-trivial chunk of the keeper's registration /
  withdraw / feedback wiring.

### b. Lifecycle hook surface

- **Question.** Should the registration descriptor accept
  `canRetry`, `onDefer`, `onAccept`, or other invocation-time hooks
  that run inside the Reckoner's process before / after a petition's
  state transitions?
- **Trade-off.** v0 declares no hooks (per D8 and `c-mod9a48y`).
  CDC + standing-order observation covers the need without an
  invocation-ordering contract; adding hooks pre-emptively would
  introduce ordering questions the framework has no precedent to
  lean on.
- **Re-evaluation trigger.** A real `canRetry` use case — i.e. a
  petitioner whose decline / defer logic genuinely needs to run in
  the same transaction as the lifecycle change, not a follow-up
  observation pass.

### c. Declarative kit-channel re-evaluation

- **Question.** Should there be a `petitioners` field on the kit
  export so a kit-only plugin (no apparatus, no `start()`) can
  register a petitioner without contributing an apparatus?
- **Trade-off.** v0 is programmatic-only (per D1 / D13). The
  registration is runtime-laden — the returned handle has no
  natural home in a static kit declaration — and Clerk's writ-type
  precedent ran the same trade-off and reached the same conclusion.
- **Re-evaluation trigger.** A third-party kit-only petitioner
  whose contribution is genuinely static (no need to hold the
  handle in apparatus state) and whose use case justifies the
  per-emit lookup the kit-only path would require.

### d. Coordination with the Reckonings book commission

- **Question.** What are the specific record fields and CDC payload
  shapes of the petitions book that §4's standing-order recipes
  filter on?
- **Trade-off.** This contract intentionally references *that* the
  petitions book exists and is CDC-attached without naming its
  schema. The Reckonings-book commission (`c-modeou1t`'s parallel,
  dispatched as the Reckonings book design track) owns the schema
  decisions.
- **Re-evaluation trigger.** When the Reckonings-book commission
  lands, this contract's §4 recipes need a follow-up pass to
  cross-reference the actual `event.payload.entry.*` field names
  the recipes filter on, replacing the illustrative `source` /
  `lifecycleClassification` references with the real schema's
  vocabulary.

### e. Renamed pulse-emitter as a future petitioner

- **Question.** The current
  [Reckoner](apparatus/reckoner.md) (the queue-observer / pulse-
  emitter that watches writs and emits Lattice pulses) is on a
  rename-and-subsume-later track. Once renamed, will it become a
  built-in petitioner of this contract?
- **Trade-off.** v0 deliberately does not name it as a built-in
  class (per D10). Pulling it in now would conflate this contract
  with the rename track and bake assumptions about the renamed
  apparatus's source-id grammar before that track has chosen one.
- **Re-evaluation trigger.** The pulse-emitter rename track lands
  and the renamed apparatus's first commission needs to wire its
  petition emission against this contract — at which point it
  registers like any other third-party petitioner.

### f. Handle-vs-trust-stamp tradeoff

- **Question.** The contract requires that all `emit` calls go
  through the registration-time handle (per D3). Should there be an
  escape hatch for a non-handle-reachable caller — a long-lived
  process that loses its handle reference, a cross-process emit
  bridge, an external actor that needs to inject a petition without
  going through a registering apparatus's runtime?
- **Trade-off.** Handle-based stamping is the load-bearing reason
  the authority gate in §7 can be enforced structurally rather than
  by runtime trust. A trust-stamped escape hatch would re-introduce
  the failure mode the handle design exists to prevent — a typo in
  an emitter-stamped source string silently elevating authority.
- **Re-evaluation trigger.** A concrete consumer with a non-handle-
  reachable call site and a clear story for how it survives the
  authority-gate invariant — likely an "auth-token-stamped emit"
  shape that re-derives the source through some other unforgeable
  channel, not a free-form trust-stamp.
