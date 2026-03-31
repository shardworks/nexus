# Agent Context: Architecture Doc Codebase Scan

> **Purpose:** Notes for agents working on `docs/architecture/index.md` so they don't have to re-scan the codebase from scratch. Written during the initial scaffolding session (2026-03-31). May drift from reality — treat as orientation, not ground truth.

---

## Repo Layout

The Nexus framework lives at `/workspace/nexus/`. Key directories:

```
/workspace/nexus/
  packages/               ← TypeScript packages (pnpm workspace)
  docs/
    architecture/         ← THIS IS WHERE YOU ARE
    reference/            ← API reference (core-api.md, schema.md, event-catalog.md, conversations.md)
    guides/               ← How-to guides (building-engines.md, building-tools.md)
    guild-metaphor.md     ← Conceptual vocabulary; read this first
    philosophy.md         ← Project "why"
```

The live guild workspace (where animas operate) is at `/workspace/shardworks/`.

The patron-side sanctum (experiments, session notes, Coco config) is at `/workspace/nexus-mk2/`.

---

## Packages

| Package | npm name | What it is |
|---------|----------|------------|
| `core` | `@shardworks/nexus-core` | Shared library — Books, config, path utilities, writ/anima/event functions, `tool()` and `engine()` SDK factories, `Rig` type |
| `arbor` | `@shardworks/nexus-arbor` (approx) | Guild runtime object — loads plugins (currently "rigs"), manages tool registry, owns Books database connection |
| `cli` | `@shardworks/nexus` | The `nsg` CLI binary |
| `nexus-clockworks` | `@shardworks/nexus-clockworks` | Clockworks as a rig — contributes clockworks tools and events/dispatches Books tables |
| `nexus-sessions` | `@shardworks/nexus-sessions` | Sessions as a rig — contributes session tools and sessions Book |
| `guild-starter-kit` | `@shardworks/guild-starter-kit` | Starter bundle — curricula, temperaments, migration snapshots |
| `claude-code-session-provider` | (local) | Session provider implementation for Claude Code / claude CLI |
| `stdlib` | `@shardworks/nexus-stdlib` | Standard tools, engines, relays |

---

## The Rig Terminology Collision

**This is the most important thing to understand before touching this doc.**

The word "rig" means two completely different things in this codebase:

| Context | Meaning |
|---------|---------|
| **Guild metaphor / target architecture** | The execution scaffold assembled to fulfill a commission — seeded at commission time, built out by Walker with engines, struck when work is done |
| **Current code** (`Rig` type in `core/src/rig.ts`, loaded by Arbor) | A package contributing tools, Books declarations, and other capabilities to the guild — basically what the target architecture calls a Kit or Apparatus |

The current code's `Rig` is what we're moving toward calling a **Kit** (or Apparatus, for packages with a lifecycle). This rename is in progress. When reading source code, mentally substitute "plugin" for `Rig`.

The architecture docs use "rig" exclusively in the metaphor sense (execution scaffold). The source code uses it in the plugin sense. Both are in the same repo. Don't mix them up.

---

## Architecture Docs Status

### Exists and reasonably current

| Doc | Status | Notes |
|-----|--------|-------|
| `architecture/plugins.md` | Good | Describes the Kit/Apparatus model with full type signatures. This is aspirational architecture, not fully implemented. |
| `architecture/clockworks.md` | Good | Detailed; covers events, standing orders, relays, runner phases, daemon. Generally matches current implementation. |
| `architecture/kit-components.md` | Good | Tools, engines, relays — artifact model, descriptors, role gating, installation. Generally accurate. |
| `architecture/rigging.md` | Forward-looking | Describes Walker/Formulary/Executor/Manifester/Summoner/Clerk as separate apparatus. This is the *target* design; currently much of this logic is either in core or not yet implemented. |
| `reference/schema.md` | Good | SQLite schema, ERD, entity ID prefixes. Reflects current database. |
| `reference/core-api.md` | Good | Function signatures for `@shardworks/nexus-core`. Generally accurate but some functions are in `legacy/1/` indicating in-flight migration. |
| `reference/event-catalog.md` | Not read | Should describe all framework events and payload shapes. |
| `guides/building-engines.md` | Good | How to write a clockwork engine. Code examples use `engine()` factory from nexus-core. Accurate for current implementation. |
| `guides/building-tools.md` | Not read | Parallel to building-engines.md for tools. |

### Outdated / moved

| Doc | Status | Notes |
|-----|--------|-------|
| `outdated-architecture/overview.md` (in nexus-mk2) | Outdated | Long overview doc from before the apparatus/kit fragmentation. Useful for historical context and some section content (instruction environment, data storage breakdown). Don't trust its package names or directory structures. |

### Exists in nexus-mk2 future/ but not yet written

| Doc | Where referenced | What it should cover |
|-----|-----------------|---------------------|
| `anima-composition.md` | kit-components.md | Curricula, temperaments, oaths — composition artifacts |
| `writs.md` | multiple places | Writ lifecycle, completion rollup, prompt templates, commission→mandate bridge |
| `engine-designs.md` | plugins.md, future/ | WalkerKit engine design specifications |
| `anima-lifecycle.md` | future/ | Anima states, instantiation, retirement |

---

## What's Implemented vs. Aspirational

The codebase is in active transition from a "rig-centric" model (current) toward the full "apparatus/kit" plugin model (target).

### Currently implemented (in actual packages)

- `Rig` type as the plugin interface (tools + books declarations)
- Arbor as the rig loader and runtime object
- Clockworks as a nexus-sessions-style rig (contributes tools + Books)
- Sessions as a rig (contributes tools + Books)
- `tool()` and `engine()` SDK factories in nexus-core
- SQLite Books database with schema migrations
- Standing orders, event queue, Clockworks daemon
- Writ lifecycle (create, activate, complete, fail, cancel)
- Anima instantiation, roster, role assignments
- Commission → mandate writ → dispatch flow
- Session funnel (manifest → MCP engine launch → session record)
- Session providers (pluggable; claude-code-session-provider exists)

### Target architecture (described in docs, not yet fully built)

- Formal `Plugin` type with explicit Kit/Apparatus discriminant
- `Apparatus` with `start`/`stop`/`health`/`supportKit`/`consumes`
- `GuildContext` with `ctx.plugin()`, `ctx.kits()`, `ctx.plugins()`
- Separate named apparatus: Stacks, Guildhall, Clerk, Manifester, Summoner, Formulary, Walker, Executor, Surveyor, Warden
- Walker-driven rig execution (the commission → rig → engine chain)
- Formulary (capability resolution from installed kits)
- `plugin:initialized` reactive consumption
- Startup validation with `requires` / `consumes` cross-referencing

---

## Key Files to Read

If you're working on a specific section of the architecture doc, start with:

| Section | Most relevant files |
|---------|-------------------|
| Plugin Architecture | `docs/architecture/plugins.md`, `packages/arbor/src/arbor.ts` |
| The Books | `docs/reference/schema.md`, `packages/core/src/book.ts`, `packages/arbor/src/db/` |
| Animas | `packages/core/src/legacy/1/anima.ts`, `guild-metaphor.md` (Anima section) |
| Work Model | `packages/core/src/legacy/1/writ.ts`, `docs/reference/schema.md` (writs table), `clockworks.md` |
| Kit Components | `docs/architecture/kit-components.md`, `packages/core/src/tool.ts` |
| Sessions | `packages/nexus-sessions/src/`, `packages/claude-code-session-provider/src/` (if exists), `docs/reference/conversations.md` |
| Clockworks | `docs/architecture/clockworks.md`, `packages/nexus-clockworks/src/` |
| Rigging | `docs/architecture/rigging.md` (aspirational), `packages/arbor/src/arbor.ts` (current) |

---

## guild.json Shape (Current)

The current `guild.json` top-level keys as of the scan:

```json
{
  "name": "...",
  "nexusVersion": "...",
  "defaultModel": "...",
  "rigs": { ... },          ← current name for installed plugins; moving to "plugins"
  "roles": { ... },
  "baseTools": [...],
  "clockworks": {
    "events": { ... },
    "standingOrders": [...]
  }
}
```

Note: the `plugins.md` architecture doc shows `"plugins": [...]` as a simple array of package names. The current implementation may differ — verify against `packages/core/src/guild-config.ts` before writing `guild.json` examples.

---

## Terminology Quick Reference

| Term in metaphor | Term in code (current) | Term in target architecture |
|-----------------|----------------------|----------------------------|
| Rig (execution scaffold) | (not yet implemented) | Rig |
| Kit / Apparatus | Rig (plugin package) | Kit / Apparatus |
| Guildhall | Guild root / home | Guildhall apparatus |
| The Books | nexus.db / SQLite tables | Stacks apparatus |
| Summon relay | built-in clockworks dispatch | summon relay (installed via nexus-stdlib) |
| Arbor | Arbor | Arbor |
| Walker | (not yet implemented) | Walker apparatus |
| Formulary | (not yet implemented) | Formulary apparatus |

---

## Session Notes

- **2026-03-31:** Initial scaffold session. Wrote §1–4 scaffold + "Standard Guild" bridge section. Created this context doc. Architecture doc is at `docs/architecture/index.md`. Companion detailed docs are already written for clockworks, plugins, kit-components, and rigging — they're good references even if partially aspirational.
