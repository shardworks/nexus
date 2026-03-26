# Tools, Engines, Curricula & Temperaments

This document describes the artifact model for the guild system — how tools, engines, curricula, and temperaments are structured, packaged, installed, and resolved. All four follow the same packaging pattern: a descriptor file, content, and a registration entry in `guild.json`. For the broader system architecture, see [overview.md](overview.md).

---

## What they are

**Tools** are instruments wielded by animas during work — operations that animas invoke to interact with guild systems, query information, record notes, and perform operations. A tool can optionally ship with an instruction document (`instructions.md`) that is delivered to the anima when manifested for a session.

Tools are accessible through multiple paths: animas invoke them as MCP tools during sessions; humans invoke them via the `nexus` CLI; engines import them programmatically. All paths execute the same logic with the same inputs and outputs — the tool author writes the logic once.

**Engines** are automated mechanical processes with no AI involvement — scripts, queue readers, and other deterministic processes built into the guild's infrastructure. Engines handle the repeatable, mechanical work: manifesting animas, setting up worktrees, running migrations. They do not have instruction documents because no anima wields them.

Two kinds of engines exist: **static engines** have bespoke APIs and are invoked by specific framework code; **clockwork engines** export a standard `engine()` handler and can be triggered by the Clockworks via standing orders. See [The Clockworks](clockworks.md) for the engine contract and factory details.

Both follow the same packaging model. Curricula and temperaments also follow this model — see [below](#curricula--temperaments).

---

## Tool architecture

### The handler model

Every tool is, at its core, a **handler with a defined contract** — inputs, outputs, and the logic between them. The framework provides access paths:

```
┌─────────────────────────────────────┐
│  TOOL (what the author writes)      │
│                                     │
│  handler — a script or module       │
│  instructions.md — anima guidance   │
└──────────────┬──────────────────────┘
               │
    ┌──────────┼──────────┐
    │          │          │
  MCP        CLI       import
  (animas)  (humans)  (engines)
    │          │          │
  same input → same code → same output
```

- **MCP** — The manifest engine configures an MCP server that exposes tools as typed, callable tools. The anima sees them as native tools alongside built-in tools like Read, Write, and Bash.
- **CLI** — The `nsg` CLI exposes tools as noun-verb subcommands (`nsg commission create`, `nsg tool install`, etc.).
- **Import** — Engines and other tools can import module-based handlers directly.

### Two kinds of tools

Tools come in two kinds, determined by the `kind` field in the descriptor (or inferred from the entry point):

#### `module` — a JavaScript/TypeScript module

The entry point exports a handler with a typed schema using the Nexus SDK:

```typescript
import { tool } from "@shardworks/nexus-core";
import { z } from "zod";

export default tool({
  description: "Look up an anima by name",
  params: {
    name: z.string().describe("Anima name"),
  },
  handler: async ({ name }, { home }) => {
    // look up anima using home to find the guild...
    return { found: true, status: "active" };
  },
});
```

The `tool()` factory wraps the params into a Zod object schema and returns a `ToolDefinition` — a typed object that the framework can introspect. The handler receives two arguments: validated params (typed from the Zod schemas) and a framework-injected context (`{ home }` — the guild root path).

For MCP, the Nexus MCP engine dynamically imports the module, reads `.params.shape` for the tool's input schema, and wraps `.handler` as the tool callback. For CLI, Commander options can be auto-generated from the Zod schema. For direct import, other code calls `.handler` as a function.

#### `script` — an executable script

The entry point is any executable — shell script, Python, compiled binary:

```bash
#!/usr/bin/env bash
# get-anima — look up an anima by name
GUILD_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
echo "$(sqlite3 "$GUILD_ROOT/.nexus/nexus.db" "SELECT * FROM animas WHERE name = '$1'" -json)"
```

Scripts receive arguments as CLI args and return results on stdout (plain text or JSON). The framework wraps them for MCP by shelling out to the script when the tool is called. For CLI, the `nexus` command delegates to the script directly.

This is the lowest-ceremony path — a tool can be a bash script with a one-line descriptor. No SDK, no TypeScript, no build step.

#### Kind inference

If `kind` is not specified in the descriptor, the framework infers it from the entry point:

| Entry point | Inferred kind |
|-------------|---------------|
| `.js`, `.mjs`, `.ts`, `.mts` | `module` |
| `.sh`, `.bash`, `.py`, or executable without extension | `script` |

An explicit `kind` always wins. Inference is a convenience, not magic — if the file extension is ambiguous, specify the kind.

### The MCP engine

Animas don't connect to individual MCP servers per tool. Instead, Nexus provides a single framework engine — the **MCP engine** — that runs as one stdio process per anima session. At session start, the manifest engine determines which tools the anima has access to (based on all of the anima's roles — see [role gating](#role-gating)), then launches the MCP engine configured with that set. The MCP engine loads each tool's handler (importing modules directly, wrapping scripts as shell-out calls) and registers them all as tools.

One process. All the anima's tools. Claude's runtime spawns it at session start and kills it at session end — no daemon management, no manual start/stop.

```
Session starts
  → manifest engine resolves tools for anima's roles
  → launches MCP engine with that tool set
  → Claude connects to MCP engine over stdio

Anima calls dispatch(...)
  → JSON-RPC over stdin to MCP engine
  → MCP engine calls dispatch handler
  → result back over stdout

Anima calls get_anima(...)
  → same process, same pipe

Session ends
  → Claude kills MCP engine process
```

Third-party MCP servers (GitHub, databases, external services) can be connected alongside the guild's MCP engine if needed. The manifest engine configures all of them as part of session setup.

### MCP as a standard protocol

[MCP (Model Context Protocol)](https://modelcontextprotocol.io/) is a standard for connecting AI agents to tools. An MCP server exposes typed, callable tools over a standardized protocol (JSON-RPC over stdio). The agent's runtime connects to the server, discovers its tools, and makes them available as native tool calls — typed parameters in, structured results out. No CLI argument parsing or stdout scraping by the agent.

Nexus uses MCP as the transport layer between animas and tools. The tool author doesn't need to know MCP exists — the framework handles the protocol. But because it's a standard, it also means:

- Third-party MCP servers work alongside guild tools with no wrapping
- Guild tools could be used by non-Nexus MCP clients if needed
- Schema validation happens at the protocol level — bad calls fail fast with clear errors

### Instructions: what MCP doesn't provide

MCP exposes three pieces of metadata about a tool: its **name**, a brief **description**, and the **parameter schema** (types, defaults, constraints). This is a reference card — enough to call the tool correctly. It is not enough to call the tool **wisely**.

A tool's `instructions.md` is an optional teaching document that is delivered to the anima as part of its composed identity (system prompt), not as MCP metadata. It provides what a reference card cannot:

- **When to use the tool** — "Always consult the Master Sage before dispatching to artificers"
- **When NOT to use it** — "Don't dispatch if the commission spec lacks acceptance criteria"
- **Workflow context** — "After dispatching, record the commission ID in your notes for the handoff"
- **Judgment guidance** — "Use priority:urgent sparingly — it preempts other work. Include justification in the spec"
- **Institutional conventions** — "Specs should follow the guild's spec format: problem statement, acceptance criteria, constraints"
- **Interaction with other tools** — "If dispatch returns a conflict, use get-anima to check the anima's current commission before retrying"

The MCP schema tells the anima what buttons a tool has. The instructions teach the **craft of using it** — when to reach for it, what judgment to apply, how it fits into the guild's workflows.

Not every tool needs instructions. A simple query tool (`anima-show`) may be fully described by its MCP schema and parameter descriptions. Instructions matter most for tools that require judgment: `commission-create`, `signal`, `anima-create` — tools where knowing the API isn't enough.

Instructions are also **institutional, not intrinsic**. The MCP schema is the tool's own contract — the same everywhere. Instructions reflect the guild's teaching about how to use the tool, and they compose with the rest of the anima's identity (codex, curriculum, temperament). The same tool installed in two different guilds could have different instructions reflecting different policies and workflows.

---

## The descriptor file

Every artifact has a descriptor at its root:

- **`nexus-tool.json`** for tools
- **`nexus-engine.json`** for engines

### Schema

Required fields marked with `*`:

```json
{
  "entry": "index.js",                    // * entry point
  "kind": "module",                       // "module" or "script" (inferred from entry if omitted)
  "instructions": "instructions.md",      // tools only — delivered to animas (optional)
  "version": "1.11.3",                    // upstream version (semver)
  "description": "Post commissions and trigger the manifest engine",
  "repository": "https://github.com/nexus/dispatch",
  "license": "MIT",
  "nexusVersion": ">=0.1.0"              // compatible Nexus version range
}
```

Only `entry` is required. All other fields are optional.

There is no `name` field — the **directory name is the tool's identity**. After installation, the directory name (`dispatch/`, `my-engine/`) is the canonical name. During installation from npm, the directory name is derived from the package name (strip scope: `@shardworks/dispatch` → `dispatch`) or specified with `--name`.

### Kind

The `kind` field tells the framework what shape the entry point is:

| Kind | Entry point | MCP engine behavior | CLI behavior |
|------|-------------|--------------------|-|
| `module` | JS/TS module exporting a Nexus tool | Imports handler, registers as typed tool | Auto-generates Commander options from Zod schema |
| `script` | Any executable | Wraps as shell-out call | Delegates directly |

If `kind` is omitted, it is inferred from the entry point's file extension (see [kind inference](#kind-inference)). An explicit `kind` always takes precedence.

### `package.json` fallback

If a `package.json` also exists in the package, the descriptor fields take precedence. Fields present only in `package.json` (e.g. `version`, `description`, `repository`) are used as fallbacks. This means:

- An npm package can omit duplicated fields from the descriptor and let `package.json` provide them
- A hand-built tool with no `package.json` puts everything in the descriptor
- Either way, the installer resolves from the same merged view

For `entry` specifically: if absent from the descriptor, the installer falls back to `package.json`'s `main` / `exports` / `bin`.

---

## On-disk layout

Each tool occupies a single directory named after the tool:

```
GUILD_ROOT/
  tools/
    commission-create/
      nexus-tool.json           →  { "entry": "handler.js", ... }
      instructions.md           →  (metadata only for npm-installed tools)
    tool-install/
    tool-remove/
    anima-create/
    my-tool/
      nexus-tool.json
      instructions.md
  engines/
    workshop-prepare/
      nexus-engine.json
    workshop-merge/
    worktree-setup/
    ledger-migrate/
  nexus/
    migrations/
      001-initial-schema.sql
```

All tools and engines share the same directory structure regardless of origin. Each tool directory contains a descriptor, and optionally instructions, handler code, and other files depending on how it was installed.

For **registry** and **git-url** installs, only metadata (descriptor + instructions) is copied to the tool directory — the runtime code lives in `node_modules/`, managed by npm. For **workshop** and **tarball** installs, the full package source is copied to the tool directory for durability (these tools are not tracked in `package.json`). For **link** installs, only metadata is in the directory — the runtime code is symlinked from the developer's local directory.

All provenance and routing metadata lives in `guild.json` — including the `package` field that tells the manifest engine to resolve the tool by npm package name rather than file path. Descriptors are pristine copies of what the tool author shipped.

---

## Role gating

Tools are gated by role — an anima only has access to tools permitted by its roles. An anima may hold **multiple roles** (e.g. both artificer and sage), and its available tools are the **union** of all tools permitted across all of its roles.

Tools are registered in `guild.json` and assigned to roles:

```json
{
  "baseTools": ["nexus-version"],
  "roles": {
    "steward": {
      "seats": 1,
      "tools": ["commission-create", "commission-list", "anima-create", "tool-install", "signal"],
      "instructions": "roles/steward.md"
    },
    "artificer": {
      "seats": null,
      "tools": ["commission-show", "complete-session", "fail-writ", "create-writ", "list-writs", "show-writ", "signal"],
      "instructions": "roles/artificer.md"
    }
  },
  "tools": {
    "commission-create": {
      "upstream": "@shardworks/nexus-stdlib",
      "package": "@shardworks/nexus-stdlib",
      "installedAt": "2026-03-25T12:00:00Z",
      "bundle": "@shardworks/guild-starter-kit@0.1.0"
    },
    "my-custom-tool": {
      "upstream": "my-custom-tool@0.3.0",
      "package": "my-custom-tool",
      "installedAt": "2026-03-22T09:30:00Z"
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `upstream` | npm package specifier the tool was installed from, or `null` for locally-built tools |
| `package` | npm package name for runtime resolution via `node_modules`. Omitted for script-only tools. |
| `installedAt` | ISO-8601 timestamp of installation |
| `bundle` | Which bundle delivered this artifact (if any) |

At manifest time, the manifest engine computes the tool set:

```
Anima "Valdris" has roles: [artificer, steward]

  nexus-version    — baseTools              → all animas     ✓
  commission-show  — roles: [artificer]     → artificer      ✓
  signal           — roles: [artificer, steward] → both match ✓
  commission-create — roles: [steward]      → steward matches ✓
  tool-install     — roles: [steward]       → steward matches ✓
  create-writ      — roles: [sage]          → no match       ✗

  Valdris gets: [nexus-version, commission-show, signal, commission-create, tool-install]
```

The MCP engine is launched with this resolved set. The anima sees exactly the tools its combined roles permit — no more, no less.

Engines do not have role gating — they are infrastructure, not tools wielded by animas. Their `guild.json` entries have no role assignments:

```json
{
  "engines": {
    "manifest": {
      "upstream": "@shardworks/engine-manifest@0.1.11",
      "package": "@shardworks/engine-manifest",
      "installedAt": "2026-03-23T12:00:00Z"
    },
    "mcp-server": {
      "upstream": "@shardworks/engine-mcp-server@0.1.11",
      "package": "@shardworks/engine-mcp-server",
      "installedAt": "2026-03-23T12:00:00Z"
    }
  }
}
```

The manifest engine resolves tool paths by name: `tools/{name}/`.

---

## Installation

### The `tool-install` tool

`tool-install` is a stdlib tool for installing new tools, engines, and bundles. It accepts a polymorphic **tool source** argument and classifies it into one of five install types:

| Source pattern | Type | Example |
|----------------|------|---------|
| `--link` flag + local dir | link | `nsg tool install ~/projects/my-tool --link` |
| `workshop:<name>#<ref>` | workshop | `nsg tool install workshop:forge#tool/fetch-jira@1.0` |
| Starts with `git+` | git-url | `nsg tool install git+https://github.com/someone/tool.git#v1.0` |
| Ends with `.tgz` or `.tar.gz` | tarball | `nsg tool install ./my-tool-1.0.0.tgz` |
| Everything else | registry | `nsg tool install some-tool@1.0`, `nsg tool install @scope/tool` |

Each type has different durability semantics — see [the building tools guide](../guides/building-tools.md) for full details on each install type and the rehydrate workflow.

The install process:

1. Classify the source and install via npm (or symlink for link mode)
2. Find and validate the descriptor (`nexus-tool.json`, `nexus-engine.json`, `nexus-curriculum.json`, or `nexus-temperament.json`)
3. Determine the tool name (from `--name`, or derived from package name)
4. Copy metadata or full source to the tool directory (depending on install type)
5. Register in `guild.json` (upstream, package name, timestamp, bundle provenance)
6. Commit to the guild

Both the CLI (`nsg tool install`) and the MCP tool (wielded by animas) share the same core logic.

### The `tool-remove` tool

`tool-remove` is the counterpart to `tool-install`. It deregisters a tool from `guild.json`, removes its directory, and cleans up `node_modules/`. Removal behavior depends on install type: registry/git-url tools are removed via `npm uninstall`; workshop/tarball tools are removed from `node_modules/` directly; linked tools have their symlink removed.

### Framework tools: workspace packages

Base tools and engines are separate packages in the Nexus monorepo — each one a complete artifact with its own descriptor, handler module, and (for tools) instructions document. They follow the same artifact shape as any guild-authored tool; they just happen to be maintained alongside the framework.

The monorepo is structured as a pnpm workspace:

```
packages/
  core/                          ← @shardworks/nexus-core — shared library (Books, config, paths, install logic)
  cli/                           ← @shardworks/nexus — the CLI operators run
  stdlib/                        ← @shardworks/nexus-stdlib — all standard tools and engines
  guild-starter-kit/             ← @shardworks/guild-starter-kit — bundle manifest + training content
```

All tools are defined using the `tool()` SDK factory in `@shardworks/nexus-stdlib`, which exports them as a collection package. Tool handlers import core functions from `@shardworks/nexus-core`. The CLI auto-generates noun-verb subcommands from tool definitions.

`nsg init` installs base tools and engines via the guild starter kit bundle, registering them in `guild.json` with bundle provenance. Tools are assigned to roles, not `baseTools`.

The `nsg` CLI exposes tools as noun-verb subcommands (`nsg commission create`, `nsg tool install`, etc.) — calling the same handler code. Humans use CLI subcommands; animas use MCP tools; both execute the same underlying logic.

This model means:
- **Collection package** — all stdlib tools are defined in one package, exported as an array for the manifest engine to resolve by name
- **Clean dependency graph** — stdlib → `@shardworks/nexus-core` ← CLI. No circular dependencies
- **Version coherence** — all tools share the framework version
- **Anima interface** — animas see the same kind of MCP tools whether they came from the framework or the guild

---

## Local development

During development, use `--link` to symlink a local tool directory into the guild:

```
nsg tool install ~/projects/my-tool --link --roles artificer
```

Changes to the handler are reflected immediately — no reinstall needed. When done iterating, reinstall via a durable method (registry, tarball, workshop).

The simplest possible guild tool is a shell script and a one-line descriptor:

```
my-tool/
  package.json            →  { "name": "my-tool", "version": "0.1.0" }
  nexus-tool.json         →  { "entry": "run.sh" }
  run.sh                  →  #!/usr/bin/env bash ...
```

No SDK, no TypeScript, no build step. The framework infers `kind: "script"` from the `.sh` extension, wraps it for MCP automatically, and the anima can call it as a typed tool.

When ready to share, `npm pack` creates a `.tgz` that any guild can install. Since the descriptor is the contract, sharing works regardless of whether the tool was originally built with npm in mind.

### Animas building tools

An anima commissioned to build a new tool works in a workshop worktree like any other commission. When the commission completes:

1. Leadership reviews the output
2. `nsg tool install workshop:forge#tool/my-tool@0.1.0` installs it into the guild from the workshop repo
3. The tool is now operational — registered in `guild.json`, full source stored in the tool directory, resolved by the manifest engine

The guildhall is never a workspace — artifacts flow in through deliberate install operations. Since `tool-install` is itself a tool, animas with appropriate access (stewards) can install tools directly — enabling the guild to extend its own toolkit autonomously.

---

## Curricula & Temperaments

Curricula and temperaments follow the same packaging model as tools and engines — a descriptor file, content, and registration in `guild.json`. The key difference: they are not executed, they are **read as text** and delivered to animas as part of their composition.

### Descriptors

- **`nexus-curriculum.json`** — for curricula
- **`nexus-temperament.json`** — for temperaments

Schema (required fields marked with `*`):

```json
{
  "content": "curriculum.md",    // * path to the content file
  "version": "2.0.0",            // upstream version (semver)
  "description": "Craft-focused builder — TDD, clean code, iterative delivery"
}
```

Only `content` is required — the path to the markdown file within the package. As with tools, the **directory name is identity** (no `name` field), and `version`/`description` fall back to `package.json` if present.

### On-disk layout

```
training/
  curricula/
    artificer-craft/
      nexus-curriculum.json
      curriculum.md
    guild-standards/
      nexus-curriculum.json
      curriculum.md
  temperaments/
    stoic/
      nexus-temperament.json
      temperament.md
    candid/
      nexus-temperament.json
      temperament.md
```

### guild.json registration

Curricula and temperaments have simpler registry entries than tools — no roles (they are composition, not access control):

```json
{
  "curricula": {
    "artificer-craft": {
      "upstream": "@shardworks/curriculum-artificer@2.0.0",
      "installedAt": "2026-03-23T12:00:00Z"
    },
    "guild-standards": {
      "upstream": null,
      "installedAt": "2026-03-23T10:00:00Z"
    }
  },
  "temperaments": {
    "stoic": {
      "upstream": null,
      "installedAt": "2026-03-23T10:00:00Z"
    }
  }
}
```

The registry answers "what training content is available in this guild." It does *not* assign training content to roles — that's the wrong layer. A curriculum and temperament are assigned to an individual **anima** at instantiation time (recorded in the Register). The `anima-create` tool picks from the available set.

### How they differ from tools

| | Tools/Engines | Curricula/Temperaments |
|---|---|---|
| Executed? | Yes — handler (module or script) | No — read as text |
| Access paths? | MCP (animas), CLI (humans), import (engines) | Manifest engine only |
| `roles` gating? | Yes (tools only) | No — assigned per-anima |
| `source` field? | Yes (nexus vs guild) | No |
| Instructions doc? | Optional (tools only) | N/A — they *are* the instructions |
| Installed by | `tool-install` | `tool-install` (same command) |
| Registered in | `guild.json` tools/engines | `guild.json` curricula/temperaments |
| Consumed by | Animas at runtime (MCP tools) | Manifest engine at assembly time |
