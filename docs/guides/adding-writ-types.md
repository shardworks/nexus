# Adding Writ Types

This guide explains how to add a new writ type to the guild — its lifecycle states, the transitions between them, the attrs that tag terminal outcomes, and the children-driven triggers that lift child terminals back onto the parent. For the substrate's architectural treatment and the full per-field schema reference, see [The Clerk → Writ-Types Substrate](../architecture/apparatus/clerk.md#writ-types-substrate). For the conceptual framing of per-type lifecycles, see [The Guild Metaphor → Writ](../guild-metaphor.md#writ).

## What a writ type is

A writ type is a complete state-machine config: named states, per-state classifications, semantic attribute tags, outbound transition edges, and optional aggregate children triggers. Every type — from the built-in `mandate` to a plugin-contributed domain-specific type — is described by the same `WritTypeConfig` shape. The Clerk composes each type's declared lifecycle with its own apparatus (phase validation, parent/child cascade) and with the Spider's dispatch layer.

> **Children-behavior cascade — runtime contract.** When any writ transitions to a terminal state, the children-behavior engine (a Phase 1 watcher on the `clerk/writs` book) evaluates the parent's `WritTypeConfig.childrenBehavior` block and applies the configured action via `ClerkApi.transition`. `anyFailure` is evaluated before `allSuccess` — a failing child wins precedence. When the firing trigger declares `copyResolution: true`, the triggering child's `resolution` string is copied verbatim onto the parent. Types that omit `childrenBehavior` are silent no-ops (no cascade). Cascade writes join the triggering transaction (Phase 1 atomicity); grandparent lift is the natural CDC re-fire on the parent's own update event.

## Quick start

A plugin contributes writ types through its `ClerkKit.writTypes` array. Each entry is a complete `WritTypeConfig`:

```typescript
import type { Plugin } from '@shardworks/nexus-core';
import type { WritTypeConfig } from '@shardworks/clerk-apparatus';

const proposalReviewConfig: WritTypeConfig = {
  name: 'proposal-review',
  states: [
    { name: 'drafting',     classification: 'initial', allowedTransitions: ['circulating', 'withdrawn'] },
    { name: 'circulating',  classification: 'active',  allowedTransitions: ['approved', 'rejected', 'revising', 'withdrawn'] },
    { name: 'revising',     classification: 'active',  allowedTransitions: ['circulating', 'withdrawn'] },
    { name: 'approved',     classification: 'terminal', attrs: ['success'],            allowedTransitions: [] },
    { name: 'rejected',     classification: 'terminal', attrs: ['failure'],            allowedTransitions: [] },
    { name: 'withdrawn',    classification: 'terminal', attrs: ['cancelled'],          allowedTransitions: [] },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'approved', copyResolution: true },
    anyFailure: { transition: 'rejected', copyResolution: true },
    parentTerminal: {
      transition: 'withdrawn',
      resolution: 'Parent proposal terminated',
    },
  },
};

export default {
  kit: {
    requires: ['clerk'],
    writTypes: [proposalReviewConfig],
  },
} satisfies Plugin;
```

That's the complete contribution. When the guild starts, the Clerk scans the Wire-phase kit snapshot, validates each entry through `validateWritTypeConfig()`, and merges valid entries into the type registry. Once merged, `commission-post --type proposal-review` is accepted; posts with undeclared types are rejected.

## Walking through the config

The example above declares six states, a non-trivial transition graph, and both children triggers. Each piece is doing specific work.

### States and classifications

Every type needs exactly one `initial` state (the entry point for newly-created writs), zero or more `active` states (mid-flight, freely entered and left), and one or more `terminal` states (absorbing — no outbound transitions). The validator enforces the counts: zero initial states, multiple initial states, or a terminal state with any outbound edge all hard-fail at registration.

For `proposal-review`:

| State | Classification | Purpose |
|-------|----------------|---------|
| `drafting` | `initial` | A newly-created proposal, not yet submitted to reviewers |
| `circulating` | `active` | Under review by the reviewers |
| `revising` | `active` | Proposal pulled back for revisions; will re-enter `circulating` |
| `approved` | `terminal` | Proposal accepted |
| `rejected` | `terminal` | Proposal denied |
| `withdrawn` | `terminal` | Proposal pulled before a decision |

The `drafting → circulating ↔ revising → approved|rejected` loop captures a realistic proposal workflow: draft, circulate, possibly revise after feedback, land on an outcome. `withdrawn` is the escape hatch — available from any non-terminal state.

### Attrs on terminal states

Classifications answer "where does this state sit on the lifecycle?" Attrs answer "what does this terminal outcome *mean*?" The two fields are independent and both matter. The attrs in the example:

- `approved` carries `['success']` — `childrenBehavior.allSuccess` keys on this when this type is a parent. (Note: success-attr terminals do *not* fire the downward `parentTerminal` cascade.)
- `rejected` carries `['failure']` — `childrenBehavior.anyFailure` keys on this when this type is a parent, and `childrenBehavior.parentTerminal` keys on this when this type is a parent that itself reaches the terminal state.
- `withdrawn` carries `['cancelled']` — surfaces to observability and, alongside `failure`, triggers the downward `parentTerminal` cascade when this type is a parent that itself terminates.

The four well-known attrs (`success`, `failure`, `cancelled`, `stuck`) are the vocabulary framework-wired triggers consume. Custom strings (e.g. `'approved-with-conditions'`, `'blocked-on-legal'`) are accepted and preserved, but only your plugin's own consumers will read them. Under-tagging is the common mistake: a terminal state without the `success` attr silently prevents `allSuccess` triggers from firing against this type's children.

### `allowedTransitions`

Each state's `allowedTransitions` is the outbound edge list — the set of states a writ in this state may transition to directly. The validator checks:

- Every target is a non-empty string referencing a state that exists in the same config.
- Terminal states declare an empty array (`allowedTransitions: []`).
- Every non-initial state has at least one inbound transition from some other state. A state with no inbound edges is orphaned — a writ could never reach it.
- Every upward `childrenBehavior` transition target (`allSuccess`, `anyFailure`) is reachable from every non-terminal state via `allowedTransitions`. A trigger that targets a state the parent can't reach from its current state is unreachable and fails registration. The downward `parentTerminal` trigger is exempt from this same-config check — its target lives in *child* type configs, not this one.

In the example, `circulating` can go anywhere useful (`approved`, `rejected`, `revising`, `withdrawn`). `revising` is the odd one — it only goes back to `circulating` (the revised version re-enters review) or `withdrawn` (give up). That asymmetry reflects the real workflow: you don't go straight from `revising` to `approved`; the revised proposal must be re-reviewed first.

### `childrenBehavior` triggers

When a proposal-review writ has children (for example, per-reviewer child writs), the parent type's `childrenBehavior` declares both cascade directions: how to lift aggregate child outcomes upward onto the parent, and how to push parent-terminal events downward onto non-terminal descendants.

Upward triggers (terminal child → parent lift):

- `allSuccess: { transition: 'approved', copyResolution: true }` — when every child is terminal *and* every such state carries the `success` attr, the parent transitions to `approved` with the last triggering child's resolution copied onto the parent.
- `anyFailure: { transition: 'rejected', copyResolution: true }` — when any child reaches a terminal state carrying the `failure` attr, the parent transitions to `rejected` with that child's resolution copied onto the parent.

Downward trigger (terminal parent → non-terminal-children cancellation):

- `parentTerminal: { transition: 'withdrawn', resolution: 'Parent proposal withdrawn' }` — when *this* type's writ itself reaches a `failure`- or `cancelled`-attr terminal (`rejected` or `withdrawn` here), every non-terminal descendant is driven to `withdrawn` with the configured static resolution. Use `copyResolution: true` instead if you'd rather propagate the parent's own resolution string to each cancelled child; `copyResolution` and `resolution` are mutually exclusive.

The children-behavior engine implements these triggers exactly: `anyFailure` is evaluated first (upward precedence), `allSuccess` only fires when every sibling is in a `success`-attr terminal state, and `copyResolution: true` copies the triggering writ's `resolution` onto the target through the same `transition` call. When the parent itself is already terminal the upward branch short-circuits, so a late-arriving terminal child event is a no-op. Downward, already-terminal children are skipped (idempotent on re-fire).

The reachability invariant matters for the upward triggers. `approved` and `rejected` must be reachable from *every* non-terminal state — `drafting`, `circulating`, `revising` — otherwise a parent stuck in one of those states couldn't land on the trigger's target. Walk through the graph: from `drafting`, you reach `approved` via `circulating`; from `revising`, you reach `approved` via `circulating`; from `circulating`, directly. Same story for `rejected`. The validator runs this reachability check on upward triggers and fails registration if it doesn't hold. The downward `parentTerminal` trigger is exempt from same-config reachability — its target lives in child type configs and is enforced at runtime by `api.transition`.

## Registering via a kit

The fast path: ship the type as part of a plugin's kit. The Clerk scans `ClerkKit.writTypes` at startup and merges valid entries.

```typescript
// src/index.ts of a proposal-review plugin
import type { Plugin } from '@shardworks/nexus-core';
import type { WritTypeConfig } from '@shardworks/clerk-apparatus';

const proposalReviewConfig: WritTypeConfig = {
  name: 'proposal-review',
  states: [
    { name: 'drafting',    classification: 'initial',  allowedTransitions: ['circulating', 'withdrawn'] },
    { name: 'circulating', classification: 'active',   allowedTransitions: ['approved', 'rejected', 'revising', 'withdrawn'] },
    { name: 'revising',    classification: 'active',   allowedTransitions: ['circulating', 'withdrawn'] },
    { name: 'approved',    classification: 'terminal', attrs: ['success'],   allowedTransitions: [] },
    { name: 'rejected',    classification: 'terminal', attrs: ['failure'],   allowedTransitions: [] },
    { name: 'withdrawn',   classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'approved', copyResolution: true },
    anyFailure: { transition: 'rejected', copyResolution: true },
    parentTerminal: {
      transition: 'withdrawn',
      resolution: 'Parent proposal terminated',
    },
  },
};

export default {
  kit: {
    requires: ['clerk'],
    writTypes: [proposalReviewConfig],
  },
} satisfies Plugin;
```

Once the guild installs the kit, the Clerk's startup logs will include the merged registry, and `writ-types` (the CLI tool or `ClerkApi.listWritTypes()`) will show the new entry with `source: 'proposal-review-kit'` (the contributing plugin id).

### Validating locally before shipping

Run the config through `validateWritTypeConfig()` in your plugin's own tests so registration failures are caught before startup:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateWritTypeConfig } from '@shardworks/clerk-apparatus';
import { proposalReviewConfig } from './config.ts';

describe('proposal-review writ type', () => {
  it('is structurally valid', () => {
    assert.doesNotThrow(() => validateWritTypeConfig(proposalReviewConfig));
  });
});
```

`validateWritTypeConfig` throws a plain `Error` on the first structural violation with a path-based message: `[clerk] writTypeConfig.<path>: <problem>; received <value>`. The path names the offending field (`states[2].classification`, `childrenBehavior.anyFailure.transition`) so failures are easy to diagnose.

## Registering via `guild.json`

The override path: declare the type in the guild's own `guild.json` under `clerk.writTypes`. Useful when you want to keep the declaration in the guild, override a kit-contributed type, or try out a type without publishing a plugin.

```json
{
  "clerk": {
    "writTypes": [
      {
        "name": "proposal-review",
        "states": [
          { "name": "drafting",    "classification": "initial",  "allowedTransitions": ["circulating", "withdrawn"] },
          { "name": "circulating", "classification": "active",   "allowedTransitions": ["approved", "rejected", "revising", "withdrawn"] },
          { "name": "revising",    "classification": "active",   "allowedTransitions": ["circulating", "withdrawn"] },
          { "name": "approved",    "classification": "terminal", "attrs": ["success"],   "allowedTransitions": [] },
          { "name": "rejected",    "classification": "terminal", "attrs": ["failure"],   "allowedTransitions": [] },
          { "name": "withdrawn",   "classification": "terminal", "attrs": ["cancelled"], "allowedTransitions": [] }
        ],
        "childrenBehavior": {
          "allSuccess": { "transition": "approved", "copyResolution": true },
          "anyFailure": { "transition": "rejected", "copyResolution": true },
          "parentTerminal": {
            "transition": "withdrawn",
            "resolution": "Parent proposal terminated"
          }
        }
      }
    ]
  }
}
```

The JSON shape is exactly the `WritTypeConfig` TypeScript shape — same fields, same rules, same validator. A config entry wins over any kit contribution with the same name (the guild operator's vocabulary is authoritative).

Use the kit path when the type ships with domain-specific engines, standing orders, or Spider dispatch mappings that belong together in one installable unit. Use the config path when the type is specific to one guild or when you're overriding a kit declaration.

## Wiring dispatch

Declaring a writ type makes `commission-post` accept it. It does **not** dispatch it — the Spider's `rigTemplateMappings` is the layer that maps a writ type onto a rig template. A writ whose type has no mapping sits in `open` indefinitely, never spawning a rig.

To dispatch `proposal-review` writs through a rig pipeline, register a mapping in Spider config or via a kit's `rigTemplateMappings`. See [The Spider → Plugin-default template and mapping](../architecture/apparatus/spider.md#plugin-default-template-and-mapping) for the mapping shape and the collision rules (config wins over kit; two kits is a hard error).

The recommended declaration order for plugin authors:

1. Declare the `WritTypeConfig` and register it through `ClerkKit.writTypes`.
2. Add a matching entry in `spider.rigTemplateMappings` (or contribute one through your kit) pointing at the rig template that should handle posts of this type.
3. Test end-to-end: post a writ of the type, verify the Spider spawns the rig, verify the rig's terminal status cascades into the writ's declared terminal state.

## Pitfalls

### Kit-vs-kit name collisions hard-fail at startup

Two kits contributing a writ type with the same `name` is a guild-config hazard. The Clerk refuses to start under a duplicate kit contribution — the startup error names both contributing plugins and the conflicting type:

```
[clerk] writTypes: writ type "proposal-review" is contributed by two kits
— kit "proposal-review-kit" already registered it, and kit "alt-review-kit"
attempted to register it again. Two kits cannot contribute the same writ type.
Resolve by removing one of the kit contributions, or by overriding via guild
config (clerk.writTypes).
```

The winner is never selected by kit load order. Operators resolve by removing one contribution or declaring an override in `clerk.writTypes` (config always wins). This same fail-loud rule applies framework-wide at every kit-vs-kit merge site (Spider `rigTemplateMappings`, Fabricator engine designs, etc.).

### Kits that redeclare a built-in type are silently skipped

A kit contributing an entry with `name: 'mandate'` is a no-op — the built-in is already valid, and the kit's config is silently discarded rather than shadowing the built-in. If you want different lifecycle behaviour for mandate-shaped work, declare a new type under a different name instead.

### Declaring a type does not dispatch it

The most common footgun. `commission-post --type proposal-review` succeeds once the type is declared, the writ lands in its `initial` state, and then… nothing happens, because the Spider has no rig template mapping for the type. If posted writs sit indefinitely, check `spider.rigTemplateMappings`. See the [Spider cross-reference](#wiring-dispatch) above.

### Under-tagging terminal states

If a terminal state lacks the `success` attr, `childrenBehavior.allSuccess` will never fire against children in that state. Similarly for `failure` and `anyFailure`. The downward `parentTerminal` trigger reads both the `failure` and `cancelled` attrs — a terminal state representing parent-rejected work that omits both will silently fail to cascade-cancel its non-terminal descendants. Tag every terminal state with at least one known attr (`success`, `failure`, `cancelled`, `stuck`) unless you have a specific reason not to — observability surfaces and cascade rules both key on these.

### Writ type name format

The validator enforces only non-emptiness on `name`. **Recommendation** (not constraint): use kebab-case, lowercase, and keep the name short and specific (`proposal-review`, `spike`, `bug-triage`). The guild config surfaces and `writ-types` CLI output all render the name as-is.

### `childrenBehavior` reachability (upward triggers)

If you add an active state that can't reach an upward `childrenBehavior` target (`allSuccess` or `anyFailure`), registration fails with an unreachability error. Walk the transition graph from every active state to each trigger target before shipping. The example's `revising` state only connects to `circulating` and `withdrawn` directly, but both triggers still work because the chain `revising → circulating → approved` exists.

### Heterogeneous-child convention (downward `parentTerminal`)

If you register a writ type that may sit *beneath* a parent type declaring a `parentTerminal` action, the child type must declare the configured target state reachable from every non-terminal state via `allowedTransitions`. Mandate's `parentTerminal: { transition: 'cancelled' }` is the canonical case: every type that may be a child of a mandate must declare a `cancelled`-equivalent terminal state and make it reachable from each non-terminal state. The validator does *not* enforce this cross-type contract — it cannot, because the trigger's downstream target lives in child type configs — so a misconfigured child surfaces at runtime as a fail-loud throw from `api.transition` that rolls the cascade back. Build your child type's state machine with the parent's downward cascade in mind, and add an integration test that drives a parent of the canonical parent type into a `failure`- or `cancelled`-attr terminal to exercise the path end-to-end.

## Further reading

- [The Clerk → Writ-Types Substrate](../architecture/apparatus/clerk.md#writ-types-substrate) — architectural treatment and the full per-field schema reference, including the mandate canonical example.
- [The Spider → Plugin-default template and mapping](../architecture/apparatus/spider.md#plugin-default-template-and-mapping) — how declared types are dispatched into rigs.
- [The Guild Metaphor → Writ](../guild-metaphor.md#writ) — conceptual framing of writs and per-type lifecycles.
- [Building Relays](building-relays.md) — adjacent guide for event-driven handlers your writ type may fire into.
- [Building Tools](building-tools.md) — adjacent guide for interactive tools animas wield.
