# Tool preference: prefer `code-lookup` for cross-reference queries

You have access to a `code-lookup` tool that answers structured queries against a precomputed reverse usage index of the monorepo's exported symbols. Use it instead of Grep whenever your query is "where is symbol X defined?" or "where is symbol X used?" or "what does package P export?"

## Three modes

- **`mode: "symbol"`** with `name: <symbolName>` — returns the definition site(s) for the named symbol: package, kind, file, line, signature, JSDoc, and a reference count. Multiple records come back when the same name is exported by multiple packages.

- **`mode: "usages"`** with `name: <symbolName>` — returns every reference site for the symbol, grouped by defining site. Each reference has a file, line, kind (`call` / `import` / `type-reference` / `extends` / `implements` / `instantiation` / `jsx` / `decorator` / `typeof` / `re-export` / `reference`), and `isCrossPackage` / `inTest` flags so you can filter.

- **`mode: "package"`** with `name: <packageName>` — returns the full export surface of a package: every exported symbol with its kind, signature, and JSDoc.

## When to prefer `code-lookup` over Grep

Reach for `code-lookup` when your intent is structural:

- "Find every place `WritDoc` is referenced." → `code-lookup mode=usages name=WritDoc`
- "What does `@shardworks/clerk-apparatus` export?" → `code-lookup mode=package name=@shardworks/clerk-apparatus`
- "Where is `ensureBook` defined and what does it look like?" → `code-lookup mode=symbol name=ensureBook`

Reach for Grep when your intent is textual:

- Multi-word phrases or comments
- String literals
- Regex over file bodies
- Searches for tokens that are not exported TypeScript symbols (e.g. CLI flag strings, configuration keys)

## What the tool returns

Definition records and reference entries come back as JSON with file paths fully resolved — no need to dereference IDs or look up tables. The index covers exported symbols across all monorepo packages; symbols local to a single file (not exported) are not indexed.

If a symbol or package returns an empty result, it is not present in the index. That is a useful signal: either the name is wrong, or the binding is not exported from any package.
