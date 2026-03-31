# Books Apparatus

> **Placeholder** — this document captures intent and open questions for the Books apparatus design. It is not yet a complete spec. Fill in as the apparatus takes shape.

---

## What Books Is

Books is the guild's persistent document store. It provides named collections ("books") of JSON documents, backed by SQLite, with queryable indexes.

In Mk 2.0 and early Mk 2.1, Books was a core Arbor feature — the `books` field on a `Rig` manifest declared schema, and Arbor itself owned the database connection, table reconciliation, and the `book()` / `rigBook()` APIs on `RigContext`. This is being moved out of Arbor core and into a first-party apparatus.

The motivation: Arbor's job is plugin loading and lifecycle management, not database semantics. Books is infrastructure with its own lifecycle (open connection, run migrations, close on shutdown). It belongs in an apparatus that can be installed, replaced, or extended independently.

---

## As a Plugin

Books is an apparatus. It contributes a runtime API via `provides` and has a lifecycle:

```typescript
export default {
  apparatus: {
    provides: booksApi,

    start: (ctx) => {
      // open database connection
      // run pending migrations (if autoMigrate enabled)
      // scan loaded kits for book declarations and reconcile schemas
      booksApi.init(...)
    },

    stop: () => {
      booksApi.close()
    },

    consumes: ["books"],    // scans kit contributions for book schema declarations
  },
} satisfies Plugin
```

Kits that need persistent storage declare `requires: ["nexus-books"]` and contribute their schema via a `books` contribution field, consumed reactively by the Books apparatus at startup.

---

## Kit Contribution: Book Schema Declarations

> **Open question:** what is the exact shape of a book schema declaration in a kit? The current implementation uses `books?: Record<string, BookOptions>` on `Rig`, where `BookOptions` holds an `indexes` array. The apparatus model would have kits contribute this under a `books` key, consumed by the Books apparatus.

Current `BookOptions` shape (from Arbor):

```typescript
interface BookOptions {
  indexes?: string[]   // field names to index (plain or dot-notation for nested)
}
```

A kit contributing book schemas:

```typescript
export default {
  kit: {
    requires: ["nexus-books"],
    books: {
      writs:   { indexes: ["status", "createdAt", "parent.id"] },
      sessions: { indexes: ["writId", "startedAt"] },
    },
  },
} satisfies Plugin
```

The Books apparatus scans for `books` contributions reactively via `plugin:initialized` and reconciles schemas at startup (additive only — no destructive migrations).

---

## Runtime API (`provides`)

> **Open question:** what does `BooksApi` look like? It needs to provide at minimum the `book()` and `rigBook()` capabilities currently on `RigContext`. The exact interface shape is TBD.

Sketch:

```typescript
interface BooksApi {
  /** Get a writable book handle scoped to the given owner and name. */
  book<T extends { id: string }>(ownerId: string, name: string): Book<T>

  /** Get a read-only book handle scoped to a different owner. */
  readBook<T extends { id: string }>(ownerId: string, name: string): ReadOnlyBook<T>
}
```

Handler usage (via HandlerContext):

```typescript
const books = ctx.apparatus<BooksApi>("nexus-books")
const writs = books.book<Writ>("nexus-ledger", "writs")
await writs.put({ id: ulid(), status: "ready", ... })
```

---

## Migration from `RigContext`

`RigContext` currently has `book()` and `rigBook()` convenience methods that wrap the database directly. These will be superseded by `HandlerContext.apparatus<BooksApi>("nexus-books")`. The migration path for existing tool handlers is mechanical:

```typescript
// Before (RigContext)
const writs = ctx.book<Writ>("writs")

// After (HandlerContext)
const books = ctx.apparatus<BooksApi>("nexus-books")
const writs = books.book<Writ>(myPluginId, "writs")
```

`RigContext` itself is superseded by `HandlerContext` as part of the broader plugin model update. See [plugins.md](../plugins.md#handlercontext).

---

## Open Questions

- **BooksApi exact shape** — `book()` / `readBook()` parameters, naming
- **`ownerId` resolution** — how does a tool handler know its plugin id to scope its books? Does the framework inject it, or does the kit declare it?
- **autoMigrate** — currently a `GuildSettings` flag in `guild.json`. Does this move to Books apparatus config, or stay in guild settings?
- **Cross-apparatus reads** — `rigBook()` (now `readBook()`) is deliberately read-only for cross-kit access. Should this be enforced in the type, or by convention?
- **Database location** — currently `<guild-root>/.nexus/books.db`. No reason to change this, but worth confirming the Books apparatus owns this path.
