# The Fabricator — API Contract

Status: **Draft — MVP**

Package: `@shardworks/fabricator-apparatus` · Plugin id: `fabricator`

> **⚠️ MVP scope.** The first implementation is an engine design registry with kit scanning and a single lookup method. No capability resolution, no need-based queries, no chain composition. The Fabricator earns those features when dynamic rig extension arrives.

---

## Purpose

The Fabricator is the guild's capability catalog. It holds engine design specifications and serves them to the Spider on demand. When the Spider needs to run an engine, it asks the Fabricator for the design by ID — the Fabricator resolves it, the Spider runs it.

The Fabricator does **not** execute engines. It does not touch rigs, manage sessions, or interact with the Clerk. It is a pure query service: designs in, designs out.

---

## Dependencies

```
requires: []
consumes: ['engines']    — scans kit and supportKit contributions for engine designs
```

---

## Engine Design Contract

The `@shardworks/fabricator-apparatus` package is the canonical home for the `EngineDesign` interface. Kit authors and apparatus that contribute engines import from this package:

```typescript
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus'
```

### `EngineDesign`

```typescript
interface EngineDesign {
  /** Unique identifier for this engine design (e.g. 'draft', 'implement', 'review'). */
  id: string

  /**
   * Execute this engine.
   *
   * Returns 'completed' with yields (synchronous work done inline), or
   * 'launched' with a sessionId (async work the Spider polls for).
   * The Spider inspects the result shape — no need to declare the kind up front.
   *
   * @param givens — the engine's declared inputs, assembled by the Spider.
   *   A mix of values from the givensSpec (set at rig spawn time, e.g. role,
   *   buildCommand, writ) and upstream yields (resolved from completed engines,
   *   e.g. draft worktree path). The engine doesn't know or care about
   *   provenance — all values arrive the same way.
   *
   * @param context — minimal execution context. The engine id and an escape hatch
   *   (`upstream`) containing all upstream yields keyed by engine id.
   *
   * Engines pull their own apparatus dependencies via guild().apparatus(...) —
   * same pattern as tool handlers.
   */
  run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult>
}
```

### `EngineRunContext`

```typescript
interface EngineRunContext {
  /** Simple string identity for this engine instance (e.g. 'draft', 'implement'). */
  engineId: string
  /** All upstream yields, keyed by engine id. Escape hatch for engines that need to inspect the full upstream chain. */
  upstream: Record<string, unknown>
}
```

### `EngineRunResult`

```typescript
type EngineRunResult =
  | { status: 'completed'; yields: unknown }    // clockwork: done, here are the yields
  | { status: 'launched'; sessionId: string }    // quick: session launched, Spider will poll
```

---

## Kit Contribution

Kits contribute engine designs via an `engines` field:

```typescript
export default {
  kit: {
    requires: ['fabricator'],
    engines: {
      draft:     draftEngine,
      implement: implementEngine,
      review:    reviewEngine,
    },
  },
} satisfies Plugin
```

Each value is an `EngineDesign`. The Fabricator scans these contributions reactively via `plugin:initialized` at startup — the same pattern the Instrumentarium uses for tools. See the [Instrumentarium spec](instrumentarium.md) for the reference implementation of kit-contribution scanning.

---

## Support Kit

None. No books, no tools. The Fabricator is a pure in-memory registry.

---

## `FabricatorApi` Interface (`provides`)

```typescript
interface FabricatorApi {
  /**
   * Look up an engine design by ID.
   * Returns the design if registered, undefined otherwise.
   */
  getEngineDesign(id: string): EngineDesign | undefined
}
```

---

## Configuration

None. No `guild.json` entry needed.

---

## Implementation Notes

- The implementation is small: a `Map<string, EngineDesign>` populated by scanning kit contributions at startup, and a single `get` method. Ship it as a standalone package (`@shardworks/fabricator-apparatus`) to establish the dependency boundary and to own the `EngineDesign` type exports.
- The Instrumentarium's kit-scanning lifecycle is the model to follow — reactive consumption of `plugin:initialized` events, collecting contributions into an internal registry.

---

## Future

The Fabricator is deliberately thin. Its planned evolution:

**Capability resolution.** When dynamic rig extension arrives, the API grows:

```typescript
interface FabricatorApi {
  // ... existing methods ...

  /**
   * Resolve a declared need to an engine chain.
   * Searches installed engine designs for those that satisfy the need,
   * composes them into an ordered chain, and returns the chain for the
   * Spider to graft onto the rig.
   */
  resolve(need: string, context?: ResolutionContext): EngineChain | null
}
```

The Fabricator is also the Sage's entry point: planning animas query it to introspect what the guild can build before decomposing a commission into writs. A standalone Fabricator (rather than capability resolution buried inside the Spider) is what makes this possible — it's a shared service both the Spider and the Sage can call.

**Unified capability catalog.** The Fabricator may absorb tool designs from the Instrumentarium, becoming the single answer to "what can this guild do?" regardless of whether the answer is an engine or a tool.
