# The Fabricator — API Contract

Status: **Draft — MVP**

Package: `@shardworks/fabricator-apparatus` · Plugin id: `fabricator`

> **⚠️ MVP scope.** The first implementation is a hardcoded engine design registry with a single lookup method. No kit scanning, no capability resolution, no need-based queries, no chain composition. The Fabricator earns those features when dynamic rig extension arrives. For now, the value is in the seam — the Walker depends on `FabricatorApi`, not on its own internal registry.

---

## Purpose

The Fabricator is the guild's capability catalog. It holds engine design specifications and serves them to the Walker on demand. When the Walker needs to run an engine, it asks the Fabricator for the design by ID — the Fabricator resolves it, the Walker runs it.

The Fabricator does **not** execute engines. It does not touch rigs, manage sessions, or interact with the Clerk. It is a pure query service: designs in, designs out.

Future: the Fabricator grows into the guild's general capability resolution system — answering "what engine chain can satisfy this declared need?" from installed kits, supporting Sage queries for commission decomposition, and potentially holding tool designs alongside engine designs (see `.scratch/todo/unify-capability-registries.md` in the sanctum).

---

## Dependencies

```
requires: []
```

The MVP Fabricator has no apparatus dependencies. It holds a hardcoded set of engine designs. When kit-contributed engines arrive, it will gain `consumes: ['engines']` to scan kit contributions at startup.

---

## Kit Interface

The MVP Fabricator does not consume kit contributions. Engine designs are registered programmatically at startup by the Walker apparatus (which passes its five engine designs to the Fabricator during initialization).

Future: kits will contribute engine designs via an `engines` field, and the Fabricator will scan them at startup — the same pattern the Instrumentarium uses for tools.

```typescript
// Future: kit contribution (not MVP)
export default {
  kit: {
    requires: ['fabricator'],
    engines: {
      deploy: deployEngine,
      lint:   lintEngine,
    },
  },
} satisfies Plugin
```

---

## Support Kit

The MVP Fabricator has no support kit. No books, no tools. It is a pure in-memory registry.

---

## `FabricatorApi` Interface (`provides`)

```typescript
interface FabricatorApi {
  /**
   * Look up an engine design by ID.
   * Returns the design if registered, undefined otherwise.
   */
  getEngineDesign(id: string): EngineDesign | undefined

  /**
   * Register an engine design. Overwrites any existing design with the same ID.
   * Used by apparatus (e.g. the Walker) to register their engine designs at startup.
   */
  registerEngineDesign(id: string, design: EngineDesign): void
}
```

The `EngineDesign` interface is defined in the Walker spec — the Fabricator holds designs but does not define their shape. The Walker (or whichever apparatus contributes engines) owns the engine contract.

---

## Configuration

The MVP Fabricator reads no configuration. No `guild.json` entry needed.

---

## Future: Capability Resolution

When dynamic rig extension arrives, the Fabricator's API grows:

```typescript
interface FabricatorApi {
  // ... existing methods ...

  /**
   * Resolve a declared need to an engine chain.
   * Searches installed engine designs for those that satisfy the need,
   * composes them into an ordered chain, and returns the chain for the
   * Walker to graft onto the rig.
   */
  resolve(need: string, context?: ResolutionContext): EngineChain | null
}
```

The Fabricator is also the Sage's entry point: planning animas query it to introspect what the guild can build before decomposing a commission into writs. A standalone Fabricator (rather than capability resolution buried inside the Walker) is what makes this possible — it's a shared service both the Walker and the Sage can call.

---

## Implementation Notes

- The MVP implementation is ~30 lines: a `Map<string, EngineDesign>`, a `get`, and a `set`. Ship it as a standalone package (`@shardworks/fabricator-apparatus`) to establish the dependency boundary, even though the code is trivial.
- The Walker registers its five engine designs with the Fabricator during `plugin:initialized`. The Fabricator doesn't know or care that they came from the Walker.
- When kit-contributed engines arrive, `registerEngineDesign` may become internal-only, replaced by automatic scanning of kit `engines` contributions — same lifecycle the Instrumentarium uses for tools.
