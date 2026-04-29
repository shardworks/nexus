# The Stacks — API Contract

Status: **Draft — under review**

Package: `@shardworks/stacks` · Plugin id: `stacks`

---

## Purpose

The Stacks is the guild's persistence layer — a JSON document store backed by SQLite, with change data capture (CDC) as its primary integration mechanism. Every piece of guild state that needs to survive process restarts lives here: writs, sessions, anima records, event logs.

The Stacks owns the write path exclusively. There is no raw SQL escape hatch, no bypass. This is what makes CDC reliable — if the API is the only write path, the event stream is complete. The Stacks does not know what the documents mean; it stores them, indexes them, watches them, and stays out of the way.

---

## Dependencies

```
requires: []
consumes: ['books']    — scans kit contributions for book declarations
```

The Stacks has no apparatus dependencies — it is the foundation layer that everything else builds on.

---

## Kit Interface

When The Stacks is installed, kits gain the ability to declare a `books` field — a record of named book declarations with index schemas. The Stacks reads these at startup and creates or reconciles the backing tables. Startup-time schema reconciliation is additive only — new books and new indexes are always safe; kit contributions cannot remove a book, and nothing is ever dropped implicitly from kit declarations alone. Whole-book retirement is a separate, explicit imperative path: `StacksApi.dropBook(ownerId, bookName)` is the sanctioned way to retire a book at runtime, and it is never invoked implicitly from kit declarations.

```typescript
// Example: a kit declaring two books
export default {
  kit: {
    requires: ['stacks'],
    books: {
      writs:    { indexes: ['status', 'createdAt', 'parent.id', ['status', 'createdAt']] },
      sessions: { indexes: ['writId', 'startedAt', 'animaId'] },
    },
  },
} satisfies Plugin
```

```typescript
interface BookSchema {
  /**
   * Fields or field tuples to index for efficient querying.
   * - A `string` creates a single-field index (e.g. `'status'`)
   * - A `string[]` creates a compound index (e.g. `['status', 'createdAt']`)
   *
   * Dot-notation for nested fields ('parent.id') is supported.
   */
  indexes?: (string | string[])[]
}
```

> **Index policy:** Only declared indexes are guaranteed to be efficient. Querying on a non-indexed field works but may scan the full table.

---

## `StacksApi` Interface (`provides`)

```typescript
interface StacksApi {
  /**
   * Get a writable Book handle for the given owner and book name.
   *
   * `ownerId` is the plugin id of the declaring kit — this is the write
   * boundary. Trust-based: not validated at runtime against the caller's
   * identity. `readBook()` enforces the boundary at the type level.
   */
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>

  /**
   * Get a read-only Book handle scoped to another plugin's book.
   * Exposes `get`, `find`, `list`, and `count` only.
   */
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>

  /**
   * Register a CDC handler for a book.
   *
   * Must be called during startup before any writes occur.
   * The `failOnError` option controls execution phase — see
   * "Change Data Capture" below.
   */
  watch<T extends BookEntry>(
    ownerId: string,
    bookName: string,
    handler: ChangeHandler<T>,
    options?: WatchOptions,
  ): void

  /**
   * Execute a function within an atomic transaction.
   *
   * All writes inside `fn` commit or roll back together. Reads see
   * uncommitted writes (read-your-writes). CDC events are buffered
   * and fired (coalesced per-document) after commit.
   */
  transaction<R>(fn: (tx: TransactionContext) => Promise<R>): Promise<R>

  /**
   * Imperatively retire a book — drops its underlying storage and
   * fires a single Phase 2 (post-commit) `delete-book` CDC event.
   *
   * - Idempotent: silent no-op when the book does not exist.
   * - Single book-level event: never fires per-row deletes.
   * - Refuses to run inside an active `transaction(...)` (DDL is
   *   hard-separated from DML).
   * - CDC watchers stay registered; they lie dormant since no further
   *   row writes can fire them.
   *
   * Kit contributions never invoke `dropBook` implicitly. Operators
   * retire a book by calling it from a plugin's `start()`.
   */
  dropBook(ownerId: string, bookName: string): Promise<void>
}

interface TransactionContext {
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>
}
```

---

## Configuration

```json
{
  "stacks": {
    "autoMigrate": true,
    "maxCascadeDepth": 16
  }
}
```

- **`autoMigrate`** — whether to apply database migrations automatically on startup.
- **`maxCascadeDepth`** — maximum CDC cascade depth before the transaction is aborted (default: 16).

---

## Document Model

A **book** is a named collection of documents. Every document must include an `id: string` field. The framework puts nothing else in the envelope — no `_rev`, no `_createdAt`, no `_type`. Domain types own their own fields.

```typescript
type BookEntry = { id: string } & Record<string, unknown>
```

IDs are author-generated. Plugins own ID generation (ULIDs recommended). The Stacks has no opinion on format beyond requiring a non-empty string. Documents are stored as plain JSON objects; nested objects are fully supported. Field names in query predicates use dot-notation for nested access (`'parent.id'`).

---

## Read and Write API

```typescript
interface Book<T extends BookEntry> extends ReadOnlyBook<T> {
  /** Upsert a document. Fires a `create` or `update` CDC event. */
  put(entry: T): Promise<void>

  /**
   * Partially update a document (top-level field merge).
   * Throws if the document does not exist. Returns the full document after merge.
   * Fires an `update` CDC event with the pre-patch document as `prev`.
   */
  patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<T>

  /** Delete by id. Silent no-op if the document does not exist. */
  delete(id: string): Promise<void>
}

interface ReadOnlyBook<T extends BookEntry> {
  get(id: string): Promise<T | null>
  find(query: BookQuery<T>): Promise<T[]>
  list(options?: ListOptions): Promise<T[]>
  count(where?: WhereClause<T> | { or: WhereClause<T>[] }): Promise<number>
}
```

---

## Query Language

Where conditions are expressed as tuples — `[field, operator, value?]`. All conditions within a single `WhereClause` are AND-ed.

```typescript
type WhereCondition<T> =
  | [string, '=' | '!=', Scalar]
  | [string, '>' | '>=' | '<' | '<=', number | string]
  | [string, 'LIKE', string]       // % and _ wildcards
  | [string, 'IN', Scalar[]]
  | [string, 'IS NULL' | 'IS NOT NULL']

type Scalar = string | number | boolean | null
type WhereClause<T> = WhereCondition<T>[]
```

**OR support:** The `where` field accepts `{ or: WhereClause<T>[] }` — each element is an AND-clause; results are unioned and deduplicated by `id`.

**Sorting:** Multi-field ordering via `orderBy: [field, 'asc' | 'desc']` or an array of such tuples.

**Pagination:** `{ limit: number; offset?: number }`. Offset requires limit.

```typescript
type BookQuery<T extends BookEntry> = {
  where?:   WhereClause<T> | { or: WhereClause<T>[] }
  orderBy?: OrderBy
} & Pagination
```

---

## Change Data Capture

All writes go through the Stacks API — this is the guarantee that makes CDC complete. CDC handlers fire on every write to a watched book.

### Event shapes

```typescript
type ChangeEvent<T extends BookEntry> =
  | CreateEvent<T>
  | UpdateEvent<T>
  | DeleteEvent<T>
  | BookDeleteEvent

interface CreateEvent<T> {
  type: 'create'; ownerId: string; book: string; entry: T
}
interface UpdateEvent<T> {
  type: 'update'; ownerId: string; book: string; entry: T; prev: T
}
interface DeleteEvent<T> {
  type: 'delete'; ownerId: string; book: string; id: string; prev: T
}
interface BookDeleteEvent {
  type: 'delete-book'; ownerId: string; book: string
}
```

`prev` is always populated for `update` and `delete` events. The pre-read cost is only paid when handlers are registered for the book.

The `delete-book` variant fires once per `dropBook(...)` call regardless of how many rows the dropped book held. Per-row delete events on drop would explode for populated books and conflict with the substrate's coalescing model. Payload is intentionally minimal — only `{ type, ownerId, book }`. Delivery is Phase 2 only (post-commit notification): a book-drop is irreversible from the caller's perspective, so a Phase 1 handler that throws would create a confusing "drop sometimes" contract. Watchers registered for a dropped book observe this single event; the registry is sealed at `phase:started`, so dropping a book never auto-unregisters the watcher (the dormant watcher is harmless because no further row writes can fire it).

### Two-phase execution

```typescript
type ChangeHandler<T extends BookEntry> = (event: ChangeEvent<T>) => Promise<void> | void

interface WatchOptions {
  /**
   * true  (default) — Phase 1: runs INSIDE the transaction. Handler writes
   *   join the same atomic unit. If the handler throws, everything rolls back.
   * false — Phase 2: runs AFTER commit. Data is persisted. Handler failures
   *   are logged as warnings.
   */
  failOnError?: boolean
}
```

**Phase 1 — Cascade** (`failOnError: true`, the default). Runs inside the transaction, before commit. The handler's writes join the same atomic unit. If the handler throws, everything rolls back — the triggering write, the handler's writes, and all nested cascades. This is the correct phase for referential integrity (e.g. cancelling child writs when a parent is cancelled).

**Phase 2 — Notification** (`failOnError: false`). Runs after the transaction commits. Data is already persisted. This is the correct phase for Clockworks event emission, telemetry, and audit logging. If your Phase 1 handler produces effects outside the Stacks, it probably belongs in Phase 2 — transaction rollback cannot undo non-database side effects.

### Transaction binding

Handlers access the Stacks through the normal `guild().apparatus<StacksApi>('stacks')` path. Transaction binding is transparent via `AsyncLocalStorage` — Phase 1 handlers automatically route their book operations through the active transaction. No special API, no transaction-aware handles. The transaction context is ambient.

**All book operations inside a Phase 1 handler must be `await`-ed.** A non-awaited write inherits the transaction context but may execute after commit or rollback, producing undefined behavior.

### Cascade depth limiting

The substrate enforces **two independent depth bounds** to catch handler chains that would otherwise pin the CPU. They measure orthogonal dimensions and use distinct error literals so log filtering and operators can route to the correct remediation path.

**Phase-1 cascade depth (`MAX_CASCADE_DEPTH`, default 16).** A counter in the *transaction context* increments each time a Phase 1 handler triggers a nested write *within* the same transaction. Exceeding the limit throws and rolls back the entire transaction. Catches cycles like "A's handler updates B, B's handler updates A" that would otherwise recurse forever inside one atomic unit.

**Phase-2 cross-transaction re-entry depth (`MAX_PHASE2_REENTRY_DEPTH`, default 16).** A separate counter on the substrate tracks the number of `firePhase2` hops in a single chain. Phase 2 handlers run *after* commit, and each handler write opens its own fresh transaction — which resets the Phase-1 counter — so the Phase-1 bound cannot detect a Phase-2 chain that re-enters Phase 2 across transaction boundaries. The substrate gate-checks this counter when a write attempts to open a new transaction inside a Phase-2 chain: if the chain has already reached the limit, the write is rejected at entry and never commits. The error message mentions **"Phase-2 re-entry depth"** — distinct from the Phase-1 wording per the spec's D8.

**Partial-commit semantics on a Phase-2 trip.** Phase-2 commits are independent per hop: hops 1..N-1 each committed their own transaction durably and those writes remain. Only hop N's write — the one that would have launched a hop past the limit — is rejected. The error surfaces past the Phase-2 catch-and-log block to the original `runTransaction` caller. A future implementation must preserve this partial-commit shape; quietly buffering Phase-2 writes into a single rollback unit would change the durability contract.

Both limits are hardcoded constants in the Stacks core. The vestigial `maxCascadeDepth` configuration row above is a documentation artifact — neither bound is wired into `guild.json` today.

### CDC event coalescing

Within a transaction, multiple writes to the same document produce a single CDC event reflecting the net change:

| Mutations | Coalesced event |
|---|---|
| create | `create` (final state) |
| create → update(s) | `create` (final state) |
| create → delete | *(no event)* |
| update(s) | `update` (pre-transaction → final) |
| update → delete | `delete` (pre-transaction state) |
| delete | `delete` (pre-transaction state) |

Phase 2 handlers see exactly one event per document. They never see intermediate states.

> **⚠️ Downstream-emitter contract.** Phase 2 today delivers each
> coalesced post-commit event to its registered watchers **exactly
> once per transaction**. Downstream pulse emitters rely on this to
> keep their own observable output idempotent without a cross-process
> dedupe store. The [Sentinel](./sentinel.md#idempotency-under-replay)
> is the current example: it uses the triggering writ's `updatedAt` as
> a dedupe identity inside `pulse.context` so that a *same-transition*
> replay still de-duplicates, but that fallback is defence-in-depth on
> top of the exactly-once invariant — not a substitute for it. Any
> future relaxation of Phase 2 delivery semantics (at-least-once
> delivery, durable outbox, cross-process worker distribution, etc.)
> **must** audit every registered downstream emitter for idempotency
> before the relaxation lands. The list today is short (the Reckoner);
> it will grow, and the audit step grows with it.

---

## Transaction Model

Every write participates in a transaction. There are two ways they're created:

**Implicit.** Every `put()`, `patch()`, or `delete()` outside a transaction opens one implicitly. It spans the write plus all Phase 1 handlers (and their cascades). Commits after all Phase 1 handlers succeed; rolls back if any throw.

**Explicit.** `stacks.transaction()` groups multiple writes into a single atomic unit. Phase 1 handlers within an explicit transaction join the same transaction. Commit is deferred until the callback completes.

Reads within a transaction see uncommitted writes from the same transaction (read-your-writes).

---

## Backend Interface

The Stacks depends on a `StacksBackend` interface, not SQLite directly. The default implementation uses SQLite via `better-sqlite3`; alternative backends implement the same interface. No SQLite types leak into the public API.

```typescript
interface StacksBackend {
  open(options: BackendOptions): Promise<void>
  close(): Promise<void>
  ensureBook(ref: BookRef, schema: BookSchema): Promise<void>
  beginTransaction(): Promise<BackendTransaction>
}

interface BackendTransaction {
  put(ref: BookRef, entry: BookEntry, opts?: { withPrev: boolean }): Promise<PutResult>
  patch(ref: BookRef, id: string, fields: Record<string, unknown>): Promise<PatchResult>
  delete(ref: BookRef, id: string, opts?: { withPrev: boolean }): Promise<DeleteResult>
  get(ref: BookRef, id: string): Promise<BookEntry | null>
  find(ref: BookRef, query: InternalQuery): Promise<BookEntry[]>
  count(ref: BookRef, where?: InternalCondition[]): Promise<number>
  commit(): Promise<void>
  rollback(): Promise<void>
}
```

For v1, the backend is an internal implementation detail — not a public extension point. To use a different persistence backend, install a different apparatus that provides `StacksApi`. The in-memory backend for tests ships inside `@shardworks/stacks` as a test utility export.

---

## Implementation Notes

- **Migration from existing code.** The existing `arbor/src/db/` (`BookStore`, `sqlite-adapter`, `reconcile-books`) moves into `@shardworks/stacks` as the SQLite backend. `Arbor.getDatabase()` (already `@deprecated`) is removed when The Stacks ships. The `core/src/book.ts` types are superseded by this spec's types. Direct database access in `clockworks` and `animator` is replaced with `guild().apparatus<StacksApi>('stacks')` calls.
- **Plugin id ownership.** Each plugin hardcodes its own id as a constant (e.g. `const PLUGIN_ID = 'nexus-ledger'`). The framework does not inject it.

See [the full Stacks specification](../../../packages/stacks/docs/stacks.md) for complete type signatures, use case coverage matrix, resolved design questions, and the detailed cascade walkthrough.
