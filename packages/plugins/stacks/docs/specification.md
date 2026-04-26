# The Stacks — Specification & API Contract

Status: **Active**

---

## Design Goals

1. **NoSQL document store semantics.** Everything is in the entry shape. `{ id: string }` is the only framework-required field; everything else is the document. No framework-managed envelopes, timestamps, or versioning.

2. **Change data capture (CDC) is the only write side-channel.** All writes go through the Stacks API — no raw SQL escape hatches, no bypass. This is what makes CDC reliable: if the API is the only write path, the events are complete.

3. **Swappable persistence backend.** The `StacksBackend` interface is the only thing The Stacks depends on for storage. No SQLite types or imports leak into the public API or into plugin packages. The SQLite implementation ships as the default but is replaceable (e.g., an in-memory backend for tests).

4. **Good query coverage.** Explicit enumeration of supported and unsupported use cases in §7. Equality-only filters are insufficient; the first-class use cases drive operator selection.

---

## 1. Document Model

A **book** is a named collection of documents. All documents must include an `id: string` field. The framework puts nothing else in the envelope — no `_rev`, no `_createdAt`, no `_type`. Domain types own their own fields.

```typescript
// Every document stored in a book must satisfy this constraint.
type BookEntry = { id: string } & Record<string, unknown>
```

IDs are **author-generated**. Plugins own ID generation (ULIDs recommended). The Stacks has no opinion on ID format beyond requiring a non-empty string.

Documents are stored and retrieved as plain JSON objects. Nested objects are fully supported as document content. Field names in query predicates use dot-notation for nested access (`'parent.id'`, `'meta.tags'`).

---

## 2. Book Declaration (Kit Contribution)

Kits declare the books they own via a `books` contribution field. The Stacks reads this at startup and creates or reconciles the necessary indexes. Schema changes are **additive only** — new books and new indexes are always safe; nothing is ever dropped automatically.

```typescript
// In a kit export
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
/**
 * Schema declaration for a single book.
 *
 * `indexes` is a list of fields or field tuples to index for efficient
 * querying. Each entry is either:
 *
 * - A `string` — creates a single-field index (e.g. `'status'`)
 * - A `string[]` — creates a compound index on multiple fields
 *   (e.g. `['status', 'createdAt']`), useful when queries filter on
 *   one field and sort by another.
 *
 * Field names use plain notation ('status') or dot-notation for nested
 * fields ('parent.id'). The Stacks translates internally.
 */
interface BookSchema {
  indexes?: (string | string[])[]
}
```

> **Index policy:** Only declared indexes are guaranteed to be efficient. Querying on a non-indexed field works but may be slow (full table scan). The Stacks does not enforce that queries only use declared indexes, but tools should be designed around declared index fields.

---

## 3. The `StacksApi` Interface (`provides`)

The Stacks exposes its runtime API via its `provides` object, accessed via `guild().apparatus<StacksApi>('stacks')`.

```typescript
interface StacksApi {
  /**
   * Get a writable Book handle for the given owner and book name.
   *
   * `ownerId` is the plugin id of the declaring kit (e.g. 'nexus-ledger').
   * Kits use their own plugin id — this is the write boundary.
   *
   * **Trust-based boundary:** The `ownerId` parameter is not validated
   * against the caller's identity at runtime. Any plugin *can* obtain a
   * write handle for another plugin's book by passing its ownerId. The
   * `readBook()` method exists to make intent legible in code and enforce
   * the boundary at the TypeScript type level. Runtime enforcement (e.g.
   * injecting caller identity via context) may be added in a future
   * version if the trust model proves insufficient.
   */
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>

  /**
   * Get a read-only Book handle scoped to another plugin's book.
   *
   * The returned handle exposes `get`, `find`, `list`, and `count` only.
   * Cross-plugin writes are not supported — they go through the owning
   * plugin's tools.
   */
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>

  /**
   * Register a CDC handler for a book.
   *
   * Must be called during startup (apparatus `start()` or equivalent kit
   * init hook) before any writes occur.
   *
   * The `failOnError` option determines when the handler runs relative to
   * the transaction commit — see §6.2 for the two-phase execution model.
   */
  watch<T extends BookEntry>(
    ownerId: string,
    bookName: string,
    handler: ChangeHandler<T>,
    options?: WatchOptions,
  ): void

  /**
   * Execute a function within an explicit transaction.
   *
   * All writes inside `fn` are atomic — they all commit or all roll back.
   * Reads inside the transaction see uncommitted writes from the same
   * transaction (read-your-writes). CDC events are buffered during the
   * transaction and fired (coalesced per-document) after commit.
   *
   * If `fn` throws, the transaction rolls back and no CDC events fire.
   *
   * See §6.4 for transaction semantics, including implicit transactions
   * and interaction with CDC handlers.
   */
  transaction<R>(fn: (tx: TransactionContext) => Promise<R>): Promise<R>
}

/**
 * Context passed to the `transaction()` callback.
 *
 * Provides the same book access methods as `StacksApi`, but all reads
 * and writes operate within the transaction boundary.
 */
interface TransactionContext {
  book<T extends BookEntry>(ownerId: string, name: string): Book<T>
  readBook<T extends BookEntry>(ownerId: string, name: string): ReadOnlyBook<T>
}
```

---

## 4. `Book<T>` — Write and Read API

```typescript
interface Book<T extends BookEntry> extends ReadOnlyBook<T> {
  /**
   * Upsert a document. Creates if `entry.id` is new; replaces the stored
   * document entirely if it already exists.
   *
   * Fires a `create` or `update` CDC event after the write completes.
   */
  put(entry: T): Promise<void>

  /**
   * Partially update a document.
   *
   * Merges the given fields into the existing document at the top level.
   * Fields not mentioned are left unchanged. If the document does not exist,
   * throws — `patch()` implies "I know this exists and I'm changing it."
   * Returns the full document after the merge (not just the patched fields).
   *
   * Fires an `update` CDC event with the pre-patch document as `prev`.
   *
   * Note: deep-merge (nested field update) is out of scope for v1.
   * To update a nested object, use `put()` with the full document.
   */
  patch(id: string, fields: Partial<Omit<T, 'id'>>): Promise<T>

  /**
   * Delete a document by id.
   *
   * Silent no-op if the document does not exist — delete is idempotent.
   * Fires a `delete` CDC event (with `prev`) only if the document existed.
   */
  delete(id: string): Promise<void>
}

interface ReadOnlyBook<T extends BookEntry> {
  /** Get a document by id. Returns null if not found. */
  get(id: string): Promise<T | null>

  /** Find documents matching a query. Results are `T[]`, no envelope. */
  find(query: BookQuery<T>): Promise<T[]>

  /** List all documents, optionally sorted and paginated. */
  list(options?: ListOptions): Promise<T[]>

  /** Count documents matching an optional predicate. Does not fetch payloads. */
  count(where?: WhereClause<T> | { or: WhereClause<T>[] }): Promise<number>
}
```

---

## 5. Query Language

### 5.1 Predicate operators

Where conditions are expressed as an array of tuples — `[field, operator, value?]`. All conditions within a single `WhereClause` are **AND**-ed. OR is supported at the query level via the `{ or: [...] }` form — see §5.4.

```typescript
/**
 * Field names are plain strings, not `keyof T`. This is intentional:
 * dot-notation paths ('parent.id') don't satisfy `keyof T` unless T
 * literally declares a key named 'parent.id'. Runtime validation via
 * SAFE_FIELD_RE (see "Field names" below) is the real safety net;
 * the type system permits any string to avoid forcing casts on every
 * nested-field query.
 */
type WhereCondition =
  | [string, '=' | '!=', Scalar]
  | [string, '>' | '>=' | '<' | '<=', number | string]
  | [string, 'LIKE', string]       // % and _ wildcards
  | [string, 'IN', Scalar[]]
  | [string, 'IS NULL' | 'IS NOT NULL']

type Scalar = string | number | boolean | null

type WhereClause = WhereCondition[]
```

**`LIKE` semantics:** Standard SQL LIKE — `%` matches any sequence of characters, `_` matches exactly one character. Case-sensitivity is backend-defined (SQLite is case-insensitive for ASCII by default).

**`IN` semantics:** Matches if the field value is a member of the provided list. Empty `IN` list always returns no results (does not error).

**Field names:** Plain names (`'status'`) or dot-notation for nested fields (`'parent.id'`). Field names are validated against an allowlist before interpolation — any name containing characters outside `[A-Za-z0-9_.-]` throws immediately.

### 5.2 Sorting

Multi-field ordering is supported. Each entry is `[field, direction]`.

```typescript
type OrderEntry = [string, 'asc' | 'desc']
type OrderBy = OrderEntry | OrderEntry[]   // shorthand: single tuple for single-field sort
```

### 5.3 Pagination

```typescript
type Pagination =
  | { limit: number; offset?: number }
  | { limit?: never; offset?: never }   // no pagination — all results

// offset requires limit; omitting both is explicit (enforced by type)
```

### 5.4 `BookQuery` (combined)

```typescript
/**
 * The `where` field accepts two forms:
 *
 * - `WhereClause` (an array) — all conditions are AND'd. This is the
 *   common case and the only form most queries need.
 *
 * - `{ or: WhereClause[] }` — each element is an AND-clause; results
 *   are the union of all clauses. Duplicates (by `id`) are removed.
 *
 * @example AND: { where: [['status', '=', 'active'], ['animaId', '=', 'vera']] }
 * @example OR:  { where: { or: [
 *   [['status', '=', 'active']],
 *   [['animaId', '=', 'vera']],
 * ]}}
 */
type BookQuery = {
  where?:   WhereClause | { or: WhereClause[] }
  orderBy?: OrderBy
} & Pagination

type ListOptions = {
  orderBy?: OrderBy
} & Pagination
```

**OR implementation strategy:** The backend interface (`InternalQuery`) remains AND-only. The Stacks apparatus handles OR by running each branch as a separate backend query, deduplicating by `id`, re-sorting, and applying pagination to the merged result set. This is correct for all dataset sizes in v1. A future backend optimization could translate `{ or: [...] }` to native SQL `OR` for a single-query execution path — the public API is the same either way.

---

## 6. Change Data Capture (CDC)

### 6.1 Event shapes

```typescript
type ChangeEvent<T extends BookEntry> =
  | CreateEvent<T>
  | UpdateEvent<T>
  | DeleteEvent<T>

interface CreateEvent<T> {
  type:    'create'
  ownerId: string    // plugin id of the book's owner
  book:    string    // book name
  entry:   T         // the created document
}

interface UpdateEvent<T> {
  type:    'update'
  ownerId: string
  book:    string
  entry:   T         // the document after the write
  prev:    T         // the document before the write (always provided)
}

interface DeleteEvent<T> {
  type:    'delete'
  ownerId: string
  book:    string
  id:      string    // the deleted document's id
  prev:    T         // the document before deletion (always provided)
}
```

**`prev` policy:** `prev` is always populated for `update` and `delete` events. This requires one pre-read per write when handlers are registered, but cascade use cases (e.g. "propagate cancellation to child writs") depend on `prev` being available without making handlers awkward. The pre-read cost is acceptable given CDC is infrastructure-level behavior.

**When no handlers are registered:** The pre-read is skipped. The Stacks tracks registration per `(ownerId, bookName)` — zero handlers = no overhead.

### 6.2 Handler registration and two-phase execution

```typescript
/**
 * CDC handler function. Receives the change event only — no context
 * parameter. Handlers access guild infrastructure via the `guild()`
 * singleton (from `@shardworks/nexus-core`), same as all other plugin
 * code. Transaction binding is transparent via `AsyncLocalStorage` —
 * see "Transaction binding" below.
 */
type ChangeHandler<T extends BookEntry> = (
  event: ChangeEvent<T>,
) => Promise<void> | void

interface WatchOptions {
  /**
   * Controls when the handler runs relative to the transaction commit.
   *
   * true  (default) — Phase 1: runs INSIDE the transaction. Handler
   *   writes join the same transaction. If the handler throws, the
   *   entire transaction (including the triggering write) rolls back.
   *
   * false — Phase 2: runs AFTER the transaction commits. The data is
   *   already persisted. If the handler throws, the error is logged
   *   as a warning but the committed data is not affected.
   *
   * @default true
   */
  failOnError?: boolean
}
```

CDC handlers execute in **two phases**, determined by `failOnError`:

**Phase 1 — Cascade handlers (`failOnError: true`, the default)**

Run *inside* the transaction, before it commits. Any writes the handler makes through the Stacks API join the same atomic unit (see "Transaction binding" below). If the handler throws, the entire transaction rolls back: the triggering write, the handler's writes, and all nested cascade writes are undone. No CDC events are emitted externally.

This is the correct phase for cascade operations: status propagation, referential integrity enforcement, any logic where the handler's writes must succeed or fail together with the trigger.

**Phase 2 — Notification handlers (`failOnError: false`)**

Run *after* the transaction commits. The data is already persisted. The handler receives coalesced CDC events (one per document — see §6.4). If the handler throws, the error is logged as a warning but has no effect on the committed data.

This is the correct phase for external notification: Clockworks event emission, telemetry, audit logging — anything where a handler failure must not block or undo writes.

**Choosing a phase:** Use Phase 1 when your handler's writes must succeed or fail atomically with the trigger — cascade status propagation, referential integrity, any logic where partial completion is a corrupt state. Use Phase 2 for notification, dispatch, and external system synchronization — Clockworks event emission, telemetry, audit logging. **If your Phase 1 handler produces effects outside the Stacks (sends a message, calls an external API), it probably belongs in Phase 2.** Transaction rollback cannot undo non-database side effects; a Phase 1 handler with external effects creates a false sense of atomicity.

**Registration window:** `watch()` must be called during guild startup — from an apparatus's `start()` method. The Stacks seals the CDC registry when arbor fires the `phase:started` event, after every apparatus has finished starting. Calling `watch()` after the seal is a programming error and throws. Startup-time writes (e.g. idempotent data migrations in an apparatus's `start()`) do not seal the registry, so a dependent apparatus that starts later in the topological order can still register watchers.

**Handler ordering:** Within each phase, handlers fire in registration order. All Phase 1 handlers complete before the transaction commits. All Phase 2 handlers fire after the commit. If apparatus A registers before apparatus B (i.e. A comes first in topological startup order), A's handler fires first within its phase.

**Transaction binding:** Handlers access the Stacks through the normal `guild().apparatus<StacksApi>('stacks')` path — the same singleton accessor used by all plugin code. Transaction binding is transparent, managed by the Stacks apparatus via `AsyncLocalStorage`:

1. Before invoking a Phase 1 handler, the Stacks sets the active `BackendTransaction` in an `AsyncLocalStorage` context.
2. Any `Book` operation (`put`, `patch`, `delete`, `get`, `find`, `count`) executed within that async context automatically routes through the active transaction.
3. When the handler (and all nested cascade handlers) completes, the async context is cleared.

Phase 2 handlers run outside any transaction context — their book operations are independent. The same `AsyncLocalStorage` mechanism also serves `stacks.transaction()`: the explicit transaction is set in async-local storage before calling the user's callback, so all book operations inside see it.

This means handler code is identical to normal plugin code — no special API, no transaction-aware handles. The transaction context is ambient.

**All book operations inside a Phase 1 handler must be `await`-ed.** A non-awaited write (fire-and-forget) inherits the `AsyncLocalStorage` transaction context and will attempt to join the active transaction — but the transaction may commit or roll back before the detached write completes, producing undefined behavior. This is not a race condition the framework can detect or prevent; it is a contract that handler authors must follow.

### 6.3 CDC and cascades

CDC is the correct hook point for cascade operations (e.g. cancelling child writs when a parent is cancelled). Cascade handlers (`failOnError: true`) execute inside the write's transaction, so their writes are atomic with the triggering write. All writes succeed together or fail together.

Cascade writes go through the normal write path, which means they invoke their own Phase 1 handlers in turn. A parent cancellation that triggers 5 child cancellations, each of which triggers grandchild updates, all execute within one transaction.

#### Cascade depth limiting

The Stacks enforces a maximum cascade depth to prevent infinite recursion from accidental cycles (e.g., A's handler updates B, B's handler updates A). A depth counter in the transaction context is incremented each time a Phase 1 handler triggers a nested write. If the counter exceeds `MAX_CASCADE_DEPTH` (default: 16), the write throws and the entire transaction rolls back.

This is a safety net, not a design constraint — legitimate cascade trees are unlikely to exceed single-digit depth. If a handler hits the limit, it indicates a cycle or a design problem in the cascade graph, not a need to raise the limit.

`MAX_CASCADE_DEPTH` is a hardcoded constant (16). Making it configurable via guild.json is deferred — there is no current use case that requires a different value.

#### Phase-2 cross-transaction re-entry depth limiting

The Phase-1 cascade-depth bound caps handler nesting *within* a single transaction. Phase 2 handlers run *after* commit and each post-commit write opens its own fresh transaction, which resets the Phase-1 counter — so the Phase-1 bound cannot detect a Phase-2 chain that re-enters Phase-2 across transaction boundaries (handler A writes book B, B's Phase-2 handler writes book A, repeat). The Stacks enforces a separate **Phase-2 re-entry depth** that counts post-commit hops in such a chain.

A hop is one invocation of `firePhase2`. The depth counter increments at the firePhase2 boundary and decrements when that hop returns. Before opening any new transaction, the substrate gate-checks the current depth: if a write attempts to open a transaction while the chain is already at the limit, the write is rejected at entry — before the backend transaction is opened — so the write does not commit. The error surfaces past the Phase-2 catch-and-log block to the original `runTransaction` caller.

The default limit is `MAX_PHASE2_REENTRY_DEPTH` (16) — symmetric with the Phase-1 cascade bound and well above the deepest legitimate Phase-2 self-write chain in the framework today (Lattice's pulse dispatcher reaches depth 2 before its in-handler state-machine guard terminates the chain). The Phase-1 and Phase-2 bounds are intentionally orthogonal: they measure different dimensions (handler nesting within a transaction vs. post-commit hops across transactions), and sharing a single budget would false-positive deep cascade graphs.

The error literal mentions **"Phase-2 re-entry depth"** — distinct from the Phase-1 cascade-depth wording so log filtering and the conformance regex can route operators to the correct remediation path. Phase-1 trips usually mean "break a cascade cycle"; Phase-2 trips usually mean "introduce a state-machine guard, or move the write off a watched book."

When a Phase-2 chain trips this bound, **the partial-commit semantics of the chain are preserved**: hops 1..N-1 each committed their own transaction durably and those writes remain. Hop N's write is the one that was rejected by the gate check, so it never commits. This is intentional — Phase 2 commits are independent per hop, and quietly buffering Phase-2 writes into a single rollback unit would change the durability contract.

`MAX_PHASE2_REENTRY_DEPTH` is a hardcoded constant (16), mirroring the Phase-1 precedent. Making it configurable via guild.json is deferred for the same reason — there is no current use case that requires a different value.

**Guideline for handler authors.** The Phase-2 re-entry bound is a *safety net*, not a design constraint. The preferred way to write a Phase-2 handler is to write to a **non-watched book** so no chain can form. If a handler must self-write to its own watched book (for example, a dispatcher that updates its own work item to record delivery state), the handler **owns termination**: it must implement an in-handler state-machine guard so the chain stops calling itself within a small, bounded number of hops. The canonical example is Lattice's pulse dispatcher (`packages/plugins/lattice/src/lattice.ts`), which transitions a pulse from `pending` to a terminal `delivered`/`failed` state and ignores updates that arrive in any non-`pending` state — so the chain terminates at depth 2 by construction. Authors should treat the substrate bound as a CPU-pin guard, not as license to write chains that approach 16 hops.

#### Example: transactional writ status cascade

A parent writ is cancelled. The cascade handler cancels all non-terminal children. All changes commit atomically — if any child update fails, the parent cancellation is also rolled back.

```typescript
// In nexus-ledger apparatus start()
const stacks = guild().apparatus<StacksApi>('stacks')

stacks.watch<Writ>('nexus-ledger', 'writs', async (event) => {
  // Only respond to phase changes to 'cancelled'
  if (event.type !== 'update') return
  if (event.entry.phase !== 'cancelled' || event.prev.phase === 'cancelled') return

  // Normal guild() access — the Stacks transparently routes these
  // operations through the active transaction via AsyncLocalStorage.
  const stacks = guild().apparatus<StacksApi>('stacks')
  const writs = stacks.book<Writ>('nexus-ledger', 'writs')

  const children = await writs.find({
    where: [['parent.id', '=', event.entry.id]],
  })

  for (const child of children) {
    if (child.phase !== 'completed' && child.phase !== 'cancelled') {
      // This put() joins the open transaction. It also invokes Phase 1
      // handlers for this child — including this same cascade handler
      // recursively for grandchildren. All within one transaction.
      await writs.put({ ...child, phase: 'cancelled' })
    }
  }
})
// failOnError defaults to true — if any child update fails, the entire
// transaction (parent + all descendants) rolls back. Nothing is persisted.
```

**What happens at runtime — success path:**

```
Caller: writs.put({ ...parentWrit, status: 'cancelled' })

  1. BEGIN TRANSACTION (implicit)

  2. Write parent to backend (uncommitted)
     Backend returns prev (parent's old state with status: 'active')

  3. Buffer CDC event: { type: 'update', entry: parent, prev: ... }

  4. Invoke Phase 1 handlers (inside the transaction):

     Cascade handler runs:
     ├─ find children → reads from same transaction
     ├─ writs.put(child1 with status: 'cancelled')
     │  → write to backend (uncommitted, same transaction)
     │  → buffer CDC event for child1
     │  → invoke Phase 1 handlers for child1
     │    └─ cascade handler runs again (grandchildren check) → no grandchildren found
     ├─ writs.put(child2 with status: 'cancelled')
     │  → same as child1
     └─ writs.put(child3 with status: 'cancelled')
        → same as child1

  5. All Phase 1 handlers complete successfully.

  6. COMMIT TRANSACTION
     → parent + child1 + child2 + child3 atomically persisted

  7. Coalesce buffered CDC events (one per document):
     → parent:  { type: 'update', prev: pre-transaction state, entry: final state }
     → child1:  { type: 'update', prev: pre-transaction state, entry: final state }
     → child2:  { type: 'update', prev: pre-transaction state, entry: final state }
     → child3:  { type: 'update', prev: pre-transaction state, entry: final state }

  8. Fire Phase 2 handlers with coalesced events
     → Clockworks emits book.nexus-ledger.writs.updated for each
     → Other notification handlers run

  9. put() returns to caller. Done.
```

**What happens at runtime — failure path:**

```
  ... steps 1–3 same as above ...

  4. Invoke Phase 1 handlers (inside the transaction):

     Cascade handler runs:
     ├─ writs.put(child1) → succeeds (uncommitted)
     ├─ writs.put(child2) → succeeds (uncommitted)
     └─ writs.put(child3) → Phase 1 handler for child3 THROWS

  5. Error propagates. Handler has failOnError: true.
     → ROLLBACK TRANSACTION
     → parent write:  undone
     → child1 write:  undone
     → child2 write:  undone
     → child3 write:  never completed
     → All buffered CDC events: discarded

  6. No Phase 2 handlers fire. Nothing happened.

  7. put() rejects with the error. Caller sees the failure.
```

### 6.4 Transaction model

Every write operation participates in a transaction. There are two ways transactions are created:

**Implicit transactions.** Every `put()`, `patch()`, or `delete()` call that is not already inside a transaction opens an implicit one. The implicit transaction spans the write itself plus all Phase 1 CDC handlers (and their cascade writes, recursively). It commits after all Phase 1 handlers succeed, or rolls back if any throw. From the caller's perspective, the write either fully succeeded (including all cascades) or fully failed.

**Explicit transactions.** Callers use `stacks.transaction()` to group multiple writes into a single atomic unit:

```typescript
const stacks = guild().apparatus<StacksApi>('stacks')

await stacks.transaction(async (tx) => {
  const writs = tx.book<Writ>('nexus-ledger', 'writs')

  // Create a mandate and its child tasks atomically
  await writs.put(mandate)
  await writs.put(task1)
  await writs.put(task2)

  // Reads inside the transaction see uncommitted writes
  const count = await writs.count([['parent.id', '=', mandate.id]])
  // count === 2, even though nothing is committed yet
})
// COMMIT happens here — mandate + task1 + task2 atomically persisted
// Phase 2 CDC events fire here (coalesced: one create event per document)
```

When a write inside an explicit transaction triggers Phase 1 CDC handlers, those handlers' writes join the same explicit transaction. The commit is deferred until the `transaction()` callback completes.

If the callback throws (or any Phase 1 handler within it throws), the entire transaction rolls back and no CDC events fire.

#### CDC event coalescing

During a transaction (implicit or explicit), CDC events are buffered — not fired. On commit, events are **coalesced per-document**: multiple mutations to the same document within one transaction produce a single CDC event. The coalescing rules:

| Mutations within transaction | Coalesced event | `prev` | `entry` |
|-----|-----|-----|-----|
| create | `create` | — | final state |
| create → update | `create` | — | final state |
| create → update → update | `create` | — | final state |
| create → delete | *(no event)* | — | — |
| update | `update` | pre-transaction state | final state |
| update → update | `update` | pre-transaction state | final state |
| update → delete | `delete` | pre-transaction state | — |
| delete | `delete` | pre-transaction state | — |

External observers (Phase 2 handlers) see exactly one event per document, reflecting the net effect of the transaction. They never see intermediate states.

#### Reads inside transactions

Reads within a transaction see uncommitted writes from the same transaction (read-your-writes). This applies to both the caller's reads and reads inside Phase 1 CDC handlers:

```typescript
// Inside a Phase 1 handler triggered by writs.put(parent):
const children = await writs.find({
  where: [['parent.id', '=', parent.id]],
})
// This query runs against the transaction's uncommitted state.
// If earlier writes in this transaction created children, they appear here.
```

#### Backend transaction support

The `StacksBackend` interface includes transaction primitives. See §8.

---

## 7. Use Case Coverage

Explicit enumeration of all conceivable use cases. The "status" column is the decision for v1 of this apparatus.

### Writes

| Use case | Status | Notes |
|----------|--------|-------|
| Insert new document | ✅ `put()` | Fires `create` CDC event |
| Update existing document (full replace) | ✅ `put()` | Fires `update` CDC event |
| Partial field update | ✅ `patch()` | Top-level fields only; fires `update` CDC event |
| Delete by id | ✅ `delete()` | Fires `delete` CDC event if document existed |
| Upsert (insert or replace, caller doesn't care) | ✅ `put()` | `put()` is always upsert |
| Deep-merge nested field update | ❌ Out of scope v1 | Use `put()` with full document for now |
| Batch insert / bulk upsert | ❌ Out of scope v1 | Call `put()` in a loop |
| Bulk delete by query | ❌ Out of scope v1 | Query then delete in a loop |
| Atomic multi-document writes | ✅ `transaction()` | Explicit transactions; also implicit for cascades (see §6.4) |
| Read-modify-write safety | ✅ `transaction()` | Read and conditional write in one atomic unit — see note below |
| Conditional update (CAS / optimistic locking) | ❌ Out of scope | Use `transaction()` for read-modify-write instead |
| Soft delete | ❌ User-space concern | Add your own `deletedAt` field; use `IS NULL` filter |
| Raw SQL write | ❌ Permanently out of scope | CDC contract depends on this |

> **⚠️ Read-modify-write without a transaction is a silent-clobber risk.** A `get()` → modify → `put()` sequence without wrapping in `transaction()` will silently overwrite any changes made between the read and the write — including changes from cascade handlers or other plugins. This is especially relevant in Nexus because LLM-driven agents (Anima) may read a document, deliberate (taking time), and then put the result back, easily clobbering an intervening status change. **Always wrap read-modify-write in `transaction()`:**
>
> ```typescript
> await stacks.transaction(async (tx) => {
>   const writs = tx.book<Writ>('nexus-ledger', 'writs')
>   const writ = await writs.get(id)
>   if (writ && writ.phase === 'active') {
>     await writs.put({ ...writ, phase: 'paused' })
>   }
> })
> ```

### Reads

| Use case | Status | Notes |
|----------|--------|-------|
| Get by id | ✅ `get()` | |
| Check existence | ✅ `get()` ≠ null | Or `count(where) > 0` |
| Get multiple by ids | ✅ `find([['id', 'IN', ids]])` | Use `IN` operator |
| List all | ✅ `list()` | |
| List with pagination | ✅ `limit` / `offset` | |
| Filter by equality | ✅ `=` | |
| Filter by inequality | ✅ `!=` | |
| Filter by null / not-null | ✅ `IS NULL` / `IS NOT NULL` | |
| Filter by range | ✅ `>`, `<`, `>=`, `<=` | Numeric or string comparison |
| Filter by pattern match | ✅ `LIKE` | `%` and `_` wildcards |
| Filter by set membership | ✅ `IN` | |
| Multiple conditions (AND) | ✅ Default — all conditions AND'd | |
| OR conditions | ✅ `{ or: [...] }` | Each branch is AND'd internally; results are unioned and deduplicated |
| Sort by single field | ✅ `orderBy` | |
| Sort by multiple fields | ✅ `orderBy` as array | |
| Count | ✅ `count()` | Efficient — no payload fetch |
| Aggregate (SUM, AVG, MIN, MAX) | ❌ Out of scope | Compute in application code after `list()` |
| GROUP BY | ❌ Out of scope | |
| Full-text search | ❌ Out of scope | |
| Geospatial queries | ❌ Out of scope | |
| JOIN / cross-book query | ❌ Out of scope | Query each book, join in application code |
| Raw SQL read | ❌ Out of scope v1 | May revisit if needed; would be SELECT-only |

### CDC / Change Tracking

| Use case | Status | Notes |
|----------|--------|-------|
| Notify on create | ✅ `type: 'create'` | |
| Notify on update (with prev value) | ✅ `type: 'update'`, `prev` always provided | |
| Notify on delete (with prev value) | ✅ `type: 'delete'`, `prev` always provided | |
| Notify on any change | ✅ Handle all three event types in one handler | |
| Conditional CDC (only fire if a specific field changed) | ❌ Handler-space concern | Check `event.prev.field !== event.entry.field` yourself |
| Declarative `watches` on kit export | ❌ Deferred | Imperative `watch()` in apparatus `start()` covers the use case |
| Async CDC (non-blocking, queued) | ❌ Out of scope for Stacks | Clockworks handles async dispatch at a higher level |
| CDC ordering guarantees across handlers | ✅ Registration order | Deterministic; depends on plugin load order |
| CDC for batch operations | ❌ Out of scope v1 | Fires once per document when batch ops ship |

### Cross-Plugin Access

| Use case | Status | Notes |
|----------|--------|-------|
| Read from own books | ✅ `stacks.book(myId, 'name')` | Full read/write |
| Read from another plugin's books | ✅ `stacks.readBook(otherId, 'name')` | Read-only by type |
| Write to another plugin's books | ❌ Out of scope | Use the owning plugin's tools |

---

## 8. Backend Interface

The `StacksBackend` interface is the only persistence contract. All SQLite-specific types stay behind this interface — `better-sqlite3`, raw SQL strings, and JSONPath expressions are implementation details of the SQLite adapter, not visible to the apparatus or to plugins.

> **Async vs. sync signatures.** The signatures below use `Promise` return types as the general contract — a future backend (e.g. libSQL over HTTP, a networked store) may require asynchronous I/O. The current `better-sqlite3` implementation is fully synchronous: all methods return plain values, not promises. Both shapes satisfy the interface; callers should `await` regardless so they remain backend-agnostic.

```typescript
/**
 * Persistence abstraction for The Stacks.
 *
 * The default implementation uses SQLite (better-sqlite3). Alternative
 * implementations (e.g. in-memory for tests, libSQL for edge deployments)
 * implement this interface.
 *
 * The apparatus never depends on the concrete adapter type — only this interface.
 */
interface StacksBackend {
  // ── Lifecycle ──────────────────────────────────────────────────────────
  open(options: BackendOptions): Promise<void>
  close(): Promise<void>

  // ── Schema ─────────────────────────────────────────────────────────────
  /**
   * Ensure a book's backing store exists with the given indexes.
   * Additive only — never drops tables or indexes.
   */
  ensureBook(ref: BookRef, schema: BookSchema): Promise<void>

  // ── Transactions ───────────────────────────────────────────────────────
  /**
   * Begin a new transaction. Returns a handle whose read/write methods
   * operate within the transaction boundary.
   *
   * The caller is responsible for calling commit() or rollback(). The
   * Stacks apparatus wraps this in try/catch to guarantee cleanup.
   *
   * SQLite backend: maps to BEGIN/COMMIT/ROLLBACK.
   * In-memory backend: snapshot on begin, restore on rollback.
   */
  beginTransaction(): Promise<BackendTransaction>
}

/**
 * A transaction handle. All read/write methods operate within the
 * transaction boundary. Reads see uncommitted writes from this
 * transaction (read-your-writes).
 */
interface BackendTransaction {
  // ── Writes ─────────────────────────────────────────────────────────────
  /**
   * Upsert a document. Returns { created: true } if the document was new,
   * { created: false } if it replaced an existing one.
   *
   * `prev` is only populated when `withPrev: true` is passed — this controls
   * whether the backend performs a pre-read (needed for CDC `prev` values).
   */
  put(ref: BookRef, entry: BookEntry, opts?: { withPrev: boolean }): Promise<PutResult>

  /**
   * Partially update a document. Returns the full document after update,
   * plus the pre-patch document as `prev`. Throws if the document does not exist.
   */
  patch(ref: BookRef, id: string, fields: Record<string, unknown>): Promise<PatchResult>

  /**
   * Delete a document by id. Returns `{ found: true, prev }` if the document
   * existed, `{ found: false }` if it did not.
   *
   * `prev` is only populated when `withPrev: true` — same rationale as `put`.
   */
  delete(ref: BookRef, id: string, opts?: { withPrev: boolean }): Promise<DeleteResult>

  // ── Reads ──────────────────────────────────────────────────────────────
  get(ref: BookRef, id: string): Promise<BookEntry | null>
  find(ref: BookRef, query: InternalQuery): Promise<BookEntry[]>

  /**
   * Count documents matching a query. Uses `CountQuery` rather than bare
   * `InternalCondition[]` for consistency with the `InternalQuery` wrapper
   * pattern. Pagination fields (limit/offset) are not meaningful for counts
   * and are excluded from `CountQuery` to avoid ambiguity.
   */
  count(ref: BookRef, query: CountQuery): Promise<number>

  // ── Lifecycle ──────────────────────────────────────────────────────────
  commit(): Promise<void>
  rollback(): Promise<void>
}

interface BackendOptions {
  /** Absolute path to the guild root. Backend determines file location internally. */
  home: string
}

interface BookRef {
  ownerId: string   // e.g. 'nexus-ledger'
  book:    string   // e.g. 'writs'
}

interface PutResult {
  created: boolean
  prev?:   BookEntry   // populated only when withPrev: true and !created
}

/**
 * The apparatus layer translates PatchResult to the public API's return
 * type: `Book<T>.patch()` returns `Promise<T>` (just the updated document).
 * The `prev` field is consumed internally for CDC event construction and
 * is not surfaced to callers.
 */
interface PatchResult {
  entry: BookEntry   // document after patch
  prev:  BookEntry   // document before patch
}

interface DeleteResult {
  found: boolean
  prev?: BookEntry   // populated only when withPrev: true and found: true
}

/**
 * The backend's internal query type. Operators are an explicit enum,
 * not raw SQL. Each backend translates to its native query mechanism.
 */
interface InternalQuery {
  where?:   InternalCondition[]
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>
  limit?:   number
  offset?:  number
}

type InternalCondition =
  | { field: string; op: 'eq' | 'neq'; value: Scalar }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { field: string; op: 'like'; value: string }
  | { field: string; op: 'in'; values: Scalar[] }
  | { field: string; op: 'isNull' | 'isNotNull' }

/** Narrowed query type for count() — conditions only, no pagination. */
interface CountQuery {
  where?: InternalCondition[]
}
```

---

## 9. Open Questions — Resolved

**Q: Should `prev` always be provided for `update` and `delete` events?**
Yes. Cascade use cases require `prev` (e.g. "only propagate if status changed from X to Y"). Conditional pre-read when handlers are registered is the right tradeoff — the cost is one extra SELECT per write to a watched book, paid only when handlers are registered. Skip entirely when no handlers registered.

**Q: Error semantics for CDC handlers?**
Default: `failOnError: true`. A handler error rejects the write and propagates to the caller. This is safer for cascade integrity — a broken cascade is worse than a failed write. Handlers that must not block writes (e.g. Clockworks event emission) opt out with `{ failOnError: false }` at registration time. Errors in `failOnError: false` handlers are logged as warnings.

**Q: Declarative `watches` field on kit export?**
Deferred. The imperative `watch()` call in apparatus `start()` covers all use cases. Sugar can come later.

**Q: Can a plugin watch its own books?**
Yes. There is no restriction — `watch('nexus-ledger', 'writs', ...)` works whether called by nexus-ledger or by a third party.

**Q: Multiple watchers on the same book?**
Yes, supported. Fire in registration order (topological apparatus start order).

**Q: How does a tool handler know its own plugin id to scope its books?**
Each plugin hardcodes its own id as a constant (e.g. `const PLUGIN_ID = 'nexus-ledger'`). The id is stable — it derives from the package name. The framework does not inject it; the plugin owns it.

**Q: Are transactions in scope?**
Yes. Cascade integrity requires it — a cascade handler that cancels 5 children must succeed or fail atomically with the triggering write. Every write implicitly opens a transaction that spans the write and all its Phase 1 CDC handlers. Explicit `transaction()` is available for grouping multiple caller-initiated writes. See §6.4.

**Q: When do CDC events fire relative to the transaction?**
Two phases. Phase 1 handlers (`failOnError: true`) run inside the transaction, before commit — their writes join the same atomic unit. Phase 2 handlers (`failOnError: false`) run after commit — they receive coalesced events and cannot affect persisted data. See §6.2.

**Q: What happens when a document is modified multiple times in one transaction?**
Events are coalesced per-document. External observers see one event reflecting the net effect. A create-then-update coalesces to a single `create` with the final state. A create-then-delete produces no event at all. See §6.4 coalescing table.

**Q: `autoMigrate` setting — where does it live?**
In the `stacks` plugin configuration section of `guild.json` (e.g. `"stacks": { "autoMigrate": true }`). This is Stacks-owned configuration, not a framework-level setting. Per the guild config spec in the [architecture index](../index.md), all remaining top-level keys are plugin configuration sections.

**Q: How are persistence backends swapped?**
For v1, The Stacks ships with SQLite built in — `StacksBackend` is an internal implementation detail, not a public extension point. To use a different persistence backend, install a different apparatus that provides `StacksApi` (e.g. swap `@shardworks/stacks` for `@acme/stacks-turso` in the plugins list). The public contract is `StacksApi`; any apparatus that satisfies it is a valid replacement.

A future version could adopt a sub-apparatus pattern where The Stacks depends on a backend apparatus (e.g. `stacks-sqlite` starts first, provides a `StacksBackend`, then `stacks` consumes it via `guild().apparatus()`). This is the same provider pattern used by session providers (`claude-code-apparatus`). Deferred until there's a concrete second backend.

The in-memory `StacksBackend` for tests ships inside `@shardworks/stacks` as a test utility export — not as a separate package.

**Q: How do CDC handlers access guild infrastructure?**
Via the `guild()` singleton from `@shardworks/nexus-core` — same as all other plugin code. Handlers receive only the change event, no context parameter. Transaction binding is transparent via `AsyncLocalStorage`: Phase 1 handlers run inside an async context where all Stacks operations automatically join the active transaction. Phase 2 handlers run outside any transaction context. See §6.2.

**Q: Registration timing enforcement**
The Stacks tracks a `locked` flag on the CDC registry. Arbor fires `phase:started` after every apparatus `start()` completes; the Stacks subscribes to that event and calls `sealCdc()`, which flips the flag. Any later `watch()` call throws. Note: earlier drafts sealed the registry on first write, but that ordering broke dependent apparatuses — an upstream apparatus doing a startup migration locked out downstream apparatuses that had not yet run their `start()`.

**Q: Cascade cycle detection?**
Handled via cascade depth limiting (§6.3). A counter in the transaction context is incremented on each nested Phase 1 handler invocation. If it exceeds `MAX_CASCADE_DEPTH` (hardcoded at 16), the write throws and the entire transaction rolls back. This catches accidental cycles without requiring graph analysis.

**Q: What about Phase-2 chains that re-enter Phase 2 across transaction boundaries?**
Handled via the **Phase-2 re-entry depth bound** (§6.3). The Phase-1 cascade-depth counter resets when each Phase-2 handler opens its own post-commit transaction, so it cannot detect a chain that loops across transactions (a Phase-2 handler whose write triggers another Phase-2 hop, indefinitely). A separate counter tracks `firePhase2` hops at the substrate level; if a write attempts to open a new transaction while the chain has already reached `MAX_PHASE2_REENTRY_DEPTH` (hardcoded at 16) hops, the gate check rejects the write before it commits. The error message mentions **"Phase-2 re-entry depth"** — distinct from the Phase-1 wording — so log filtering and conformance assertions can route to the right remediation path. Hops 1..N-1 commit durably (Phase 2 commits are independent per hop); only hop N's write is rejected. This is a safety net beneath the spec's preferred design — write to a non-watched book, or guard the self-write with an in-handler state machine (see Lattice's pulse dispatcher for the canonical example).