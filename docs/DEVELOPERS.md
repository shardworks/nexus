# Nexus Developer Guide

This document is for agents and humans building the Nexus framework — creating packages, implementing apparatus, authoring kits, and contributing to the monorepo. It covers project setup, build workflow, package conventions, and documentation standards.

For the conceptual vocabulary, read [The Guild Metaphor](guild-metaphor.md). For the system architecture, read [Architecture](architecture/index.md).

---

## Project Setup

Nexus is a pnpm workspace monorepo. All packages live under `packages/`.

### Prerequisites

- **Node.js 24.x** (see `engines` in root `package.json`)
- **pnpm 10.x** (see `packageManager` in root `package.json`)

### Install and Build

```sh
pnpm install
pnpm build        # tsc across all packages
pnpm test         # node --test across all packages
pnpm typecheck    # tsc --noEmit across all packages
```

### Running the CLI locally

```sh
# V2 CLI (current)
pnpm nsg <command>

# V1 CLI (legacy, transitional)
pnpm nsg1 <command>
```

Both use Node's `--experimental-transform-types` to run TypeScript directly — no build step required for development iteration.

### Package-level commands

Each package has its own `build`, `test`, and `typecheck` scripts:

```sh
cd packages/stacks
pnpm test          # run tests for this package only
pnpm typecheck     # type-check this package only
```

---

## Package Conventions

### Naming

Packages in the `@shardworks/` scope follow a naming convention that determines their plugin id (the short name used in `guild.json`, `requires` arrays, and `guild().apparatus()` calls):

1. Strip `@shardworks/` scope
2. Strip trailing `-(plugin|apparatus|kit)` suffix

| npm package | Plugin id |
|---|---|
| `@shardworks/stacks` | `stacks` |
| `@shardworks/tools-apparatus` | `tools` |
| `@shardworks/nexus-core` | `nexus-core` |
| `@shardworks/nexus-stdlib` | `nexus-stdlib` |

Choose package names so the derived plugin id is short, clear, and reads naturally in configuration.

### Module format

All packages are ESM (`"type": "module"` in `package.json`). TypeScript sources use `.ts` extensions; import paths use `.ts` in source (rewritten by `rewriteRelativeImportExtensions` during build) or `.js` for published output.

### Exports

Every package declares explicit `exports` in `package.json`. For development, exports point at source TypeScript (`./src/index.ts`). For publishing, `publishConfig.exports` points at built output (`./dist/index.js` with `.d.ts` types).

```json
{
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      }
    }
  }
}
```

Additional entry points (e.g. `./testing` for test utilities) follow the same pattern.

### Dependencies

- **Workspace dependencies** use `"workspace:*"` — e.g. `"@shardworks/nexus-core": "workspace:*"`
- **Apparatus packages** depend on `@shardworks/nexus-core` for types, `guild()`, and SDK factories
- **Kit packages** depend only on `@shardworks/nexus-core` — never on apparatus packages directly. Kit code accesses apparatus APIs at runtime via `guild().apparatus()`, not at import time.

### Tests

Tests use Node's built-in test runner (`node --test`). Test files are colocated with source as `*.test.ts`. No external test framework is required.

```sh
pnpm test   # from package root, or monorepo root for all packages
```

---

## Creating a New Package

1. Create a directory under `packages/`:
   ```sh
   mkdir packages/my-apparatus
   ```

2. Add `package.json` with workspace conventions:
   ```json
   {
     "name": "@shardworks/my-apparatus",
     "version": "0.0.0",
     "type": "module",
     "exports": { ".": "./src/index.ts" },
     "scripts": {
       "build": "tsc",
       "test": "node --disable-warning=ExperimentalWarning --experimental-transform-types --test 'src/**/*.test.ts'",
       "typecheck": "tsc --noEmit"
     },
     "dependencies": {
       "@shardworks/nexus-core": "workspace:*"
     }
   }
   ```

3. Add `tsconfig.json` extending the root config:
   ```json
   {
     "extends": "../../tsconfig.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src"
     },
     "include": ["src"]
   }
   ```

4. Create `src/index.ts` with the package's public API.

5. Write a **README.md** (see [README Standards](#readme-standards) below).

6. Run `pnpm install` from the monorepo root to link the new package into the workspace.

---

## Documentation Layers

The project maintains three layers of documentation for different audiences:

| Layer | Audience | Purpose | Location |
|---|---|---|---|
| **Architecture specs** | Implementers | Full system design — internal mechanics, lifecycle, error contracts, backend interfaces, migration notes, open questions | `docs/architecture/apparatus/{name}.md` |
| **Package READMEs** | Consumers (other packages, kit authors) | How to use this package — API surface, configuration, examples | `packages/{name}/README.md` |
| **Architecture index** | Architects (understanding the whole system) | Narrative overview — how pieces relate, what flows where, why | `docs/architecture/index.md` |

These layers overlap intentionally. The README is a curated subset of the architecture spec, written for a reader who wants to *use* the package, not *build* it. The architecture spec is the source of truth during design; the README becomes the source of truth for consumers once the package ships.

### When each is written

- **Architecture specs** are written during design, before implementation begins. They serve as commission specs for implementing agents.
- **READMEs** are written during implementation, as part of the build. The implementing agent extracts consumer-facing content from the architecture spec into the README.
- **Architecture index** is maintained continuously as the system evolves.

---

## README Standards

Every published package must include a `README.md`. The README is the consumer-facing documentation — the first thing another developer (human or agent) reads when they depend on your package.

### Structure

Follow this structure, omitting sections that don't apply:

```markdown
# `@shardworks/{package-name}`

{One paragraph: what this package does, who it's for, and where it sits
in the dependency graph.}

---

## Installation

{How to depend on this package. For workspace packages, this is typically
just adding it to `dependencies` with `workspace:*`.}

## API

{The `provides` interface (for apparatus) or the default export shape
(for kits). Full TypeScript signatures with JSDoc. Include usage examples
showing real-world calls, not just type signatures.}

## Configuration

{Plugin configuration in `guild.json`, if any. Show the JSON structure
and explain each field with defaults.}

## Kit Interface *(apparatus only, optional)*

{For apparatus that consume kit contributions (those declaring
`consumes`): document the contribution schema that kit authors use.
E.g. the Stacks documents the `books` field shape; the Instrumentarium
documents the `tools` field shape. This tells kit authors "here's how
to contribute to this apparatus."}

## Kit Contributions *(kits only, optional)*

{For kit packages: document what the kit contributes (tools, books,
engines, relays), which apparatus it `requires`, and which it
`recommends`. This tells consumers "here's what this kit brings to
the guild."}

## Support Kit *(apparatus only, optional)*

{For apparatus with a supportKit: document the tools, books, or other
contributions the apparatus itself provides to the guild. This is the
apparatus's own kit-style output — e.g. the Animator's session-list
tool, the Parlour's conversations book.}

## Exports

{Secondary entry points beyond the main export, if any. E.g. a
`./testing` export for test utilities.}
```

### What belongs in the README vs. the architecture spec

**In the README:**
- Purpose and positioning (one paragraph)
- The `provides` API with usage examples
- Configuration schema and defaults
- Kit interface — the contribution schema kit authors use (apparatus only, if it consumes contributions)
- Kit contributions — what the package contributes and what it requires (kits only)
- Support kit contents — tools, books, etc. the apparatus provides to the guild (apparatus only)
- Secondary exports

**Not in the README (lives in the architecture spec):**
- Internal lifecycle diagrams and step-by-step flows
- Error handling contracts (unless they directly affect caller behavior)
- Backend interfaces and internal abstractions
- CDC mechanics, cascade rules, coalescing behavior
- Implementation notes, migration guidance
- Future sections, open questions, design alternatives

### Style

- **Lead with usage.** Show how to call the API before explaining what it does internally.
- **Use real examples.** Don't just show type signatures — show a tool handler calling `guild().apparatus<StacksApi>('stacks')` and doing something with the result.
- **Be precise about types.** Include full TypeScript interfaces. Consumers will read the README to understand what they can pass and what they get back.
- **Keep it current.** The README must match the shipped code. If the API changes, the README changes in the same commit. Stale documentation is worse than no documentation.

### Examples of good existing READMEs

- `packages/arbor/README.md` — thorough API reference with tables, clear separation of runtime API from plugin loading internals
- `packages/core/README.md` — SDK-first, shows `tool()` usage immediately, organizes by capability

---

## Commit Practices

- **Commit early and often.** Small, atomic commits. Don't accumulate large changesets — this is a multi-agent environment where conflicts are a real risk.
- **Self-document for other agents.** Write commit messages assuming your primary reader is another agent continuing the work. Be precise and concise.
- **Minimize conflict surface.** Prefer adding new files over modifying shared ones. Keep changes to shared files narrow. Commit and merge promptly.

---

## Architecture Specs

Architecture specs live in `docs/architecture/apparatus/` and follow the [apparatus template](architecture/apparatus/_template.md). They are design documents written before implementation — the implementing agent reads the spec as its primary commission input.

An architecture spec should contain everything needed to build the package:
- Full TypeScript interfaces for the `provides` API and all supporting types
- Behavioral sections (lifecycle flows, error handling, algorithms)
- Configuration schema
- Kit contribution and support kit declarations
- Open questions and future evolution
- Implementation notes (migration concerns, known gotchas, dependencies on other work)

When commissioning an apparatus build, the spec *is* the commission. The implementing agent reads the spec, builds the package, writes the README (extracting consumer content from the spec), and delivers a working package with tests.
