# The Stacks — Conformance Test Specification (v6)

Status: **Active** — defines the test cases any `StacksBackend` implementation must pass

---

## Guiding Principle

The `StacksBackend` interface is the swappable contract. This test suite is backend-agnostic — it runs against the `StacksApi` surface using whatever backend is configured. A backend that passes every test in this document is a conforming implementation. A backend that fails any test is not safe to use in production.

Tests are organized by risk tier:

- **Tier 1 — Data integrity.** Failures here mean data loss or corruption. These are the non-negotiable tests.
- **Tier 2 — Behavioral correctness.** Failures here mean the CDC contract is violated. Cascade logic will malfunction.
- **Tier 3 — Query correctness.** Failures here mean queries return wrong results. Plugins will misbehave.
- **Tier 4 — Edge cases and ergonomics.** Failures here mean surprising behavior in uncommon scenarios.

---

## Tier 1 — Data Integrity

These tests verify that data is not lost, corrupted, or silently mishandled. Every backend must pass all of these.

### 1.1 Basic CRUD round-trip

```
put({ id: 'a', name: 'Alice' })
get('a') → { id: 'a', name: 'Alice' }
```

Verify the document survives serialization/deserialization exactly. No added fields, no dropped fields, no type coercion.

### 1.2 Put is full-replace, not merge

```
put({ id: 'a', name: 'Alice', role: 'admin' })
put({ id: 'a', name: 'Alice' })
get('a') → { id: 'a', name: 'Alice' }
```

The `role` field must be gone. A backend that merges on put instead of replacing is non-conforming.

### 1.3 Document field type preservation

```
put({ id: 'a', count: 0, flag: false, label: '', items: null })
get('a') → { id: 'a', count: 0, flag: false, label: '', items: null }
```

Verify that falsy values survive round-trip. `0` must not become `null`. `false` must not become `0`. `''` must not become `null`. `null` must not become `undefined` or be omitted.

### 1.4 Nested object preservation

```
put({ id: 'a', meta: { tags: ['x', 'y'], nested: { deep: true } } })
get('a') → exact structural match including nested arrays and objects
```

### 1.5 Delete removes the document

```
put({ id: 'a', name: 'Alice' })
delete('a')
get('a') → null
```

### 1.6 Delete is idempotent

```
delete('nonexistent-id') → no error thrown
```

### 1.7 Patch applies top-level fields only

```
put({ id: 'a', name: 'Alice', role: 'admin', score: 10 })
patch('a', { score: 20 })
get('a') → { id: 'a', name: 'Alice', role: 'admin', score: 20 }
```

Unmentioned fields (`name`, `role`) must be untouched. Only `score` changes.

### 1.8 Patch throws on missing document

```
patch('nonexistent', { name: 'Bob' }) → throws
```

Must throw, not silently create. This distinguishes patch from put.

### 1.9 Patch returns the updated document

```
put({ id: 'a', name: 'Alice', score: 10 })
result = patch('a', { score: 20 })
result → { id: 'a', name: 'Alice', score: 20 }
```

### 1.10 Put with identical document is a no-op write (but still valid)

```
put({ id: 'a', name: 'Alice' })
put({ id: 'a', name: 'Alice' })
get('a') → { id: 'a', name: 'Alice' }
```

The second put must succeed and the document must be correct. CDC behavior for this case is tested in 2.6a.

### 1.11 Patch with `id` in fields does not change document identity

```
put({ id: 'a', name: 'Alice' })
patch('a', { id: 'b', name: 'Bob' })
get('a') → { id: 'a', name: 'Bob' }
get('b') → null
```

The `id` field in the patch payload must be silently ignored. The document's identity must not change. A backend that naively merges `{ id: 'b' }` into the stored document would allow document identity mutation, which is a data integrity violation.

The spec's type signature (`Partial<Omit<T, 'id'>>`) prevents this at compile time, but runtime callers (JavaScript, `as any`) can bypass the type. Backends must enforce id immutability regardless of the caller's type safety.

---

## Tier 2 — CDC Behavioral Correctness

These tests verify the change data capture contract. Failures here mean cascade handlers and notification handlers will malfunction.

### 2.1 Put (new document) fires `create` event

```
watch('owner', 'book', handler)
put({ id: 'a', name: 'Alice' })
handler received → { type: 'create', entry: { id: 'a', name: 'Alice' } }
```

### 2.2 Put (existing document) fires `update` event with `prev`

```
put({ id: 'a', name: 'Alice' })
watch('owner', 'book', handler)
put({ id: 'a', name: 'Bob' })
handler received → {
  type: 'update',
  entry: { id: 'a', name: 'Bob' },
  prev:  { id: 'a', name: 'Alice' }
}
```

`prev` must reflect the state *before* the write.

### 2.3 Patch fires `update` event with `prev`

```
put({ id: 'a', name: 'Alice', score: 10 })
watch('owner', 'book', handler)
patch('a', { score: 20 })
handler received → {
  type: 'update',
  entry: { id: 'a', name: 'Alice', score: 20 },
  prev:  { id: 'a', name: 'Alice', score: 10 }
}
```

### 2.4 Delete fires `delete` event with `prev`

```
put({ id: 'a', name: 'Alice' })
watch('owner', 'book', handler)
delete('a')
handler received → {
  type: 'delete',
  id: 'a',
  prev: { id: 'a', name: 'Alice' }
}
```

### 2.5 Delete of nonexistent document fires no event

```
watch('owner', 'book', handler)
delete('nonexistent')
handler received → nothing
```

### 2.6 No events fire when no handlers are registered

```
// No watch() calls
put({ id: 'a', name: 'Alice' })
// Verify no pre-read was performed (backend-level assertion if possible)
```

This tests the optimization: skip the pre-read when no handlers are registered.

### 2.6a Put with identical document fires `update` event

```
put({ id: 'a', name: 'Alice' })
watch('owner', 'book', handler)
put({ id: 'a', name: 'Alice' })   // identical content
handler received → {
  type: 'update',
  entry: { id: 'a', name: 'Alice' },
  prev:  { id: 'a', name: 'Alice' }
}
```

The Stacks does not perform content comparison — a put to an existing document always fires an `update` event regardless of whether the content changed. Handlers that care about actual changes should compare `prev` and `entry` fields themselves.

### 2.6b CDC events include `ownerId` and `book` fields

```
watch('my-plugin', 'tasks', handler)
put to ('my-plugin', 'tasks'): { id: 'a', title: 'test' }
handler received → {
  type: 'create',
  ownerId: 'my-plugin',
  book: 'tasks',
  entry: { id: 'a', title: 'test' }
}
```

Verify that `ownerId` and `book` are correctly populated on all three event types (`create`, `update`, `delete`). These fields are essential for handlers that observe multiple books or for Phase 2 handlers that dispatch based on event source.

### 2.7 Phase 1 handler error rolls back the triggering write

```
watch('owner', 'book', handler, { failOnError: true })
handler = async (event) => { throw new Error('cascade failed') }

put({ id: 'a', name: 'Alice' }) → rejects with error
get('a') → null
```

The document must not exist after a Phase 1 handler failure.

### 2.8 Phase 2 handler error does not roll back the write

```
watch('owner', 'book', handler, { failOnError: false })
handler = async (event) => { throw new Error('notification failed') }

put({ id: 'a', name: 'Alice' }) → resolves successfully
get('a') → { id: 'a', name: 'Alice' }
```

The document must persist despite the Phase 2 handler error.

### 2.9 Phase 1 handlers fire before Phase 2 handlers

```
const order = []
watch('owner', 'book', () => order.push('phase1'), { failOnError: true })
watch('owner', 'book', () => order.push('phase2'), { failOnError: false })

put({ id: 'a', name: 'Alice' })
order → ['phase1', 'phase2']
```

### 2.10 Multiple handlers fire in registration order within each phase

```
const order = []
watch('owner', 'book', () => order.push('p1-first'),  { failOnError: true })
watch('owner', 'book', () => order.push('p1-second'), { failOnError: true })
watch('owner', 'book', () => order.push('p2-first'),  { failOnError: false })
watch('owner', 'book', () => order.push('p2-second'), { failOnError: false })

put({ id: 'a', name: 'Alice' })
order → ['p1-first', 'p1-second', 'p2-first', 'p2-second']
```

### 2.11 Phase 1 handler writes are atomic with the trigger

```
watch('owner', 'books-a', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  const booksB = stacks.book('owner', 'books-b')
  await booksB.put({ id: 'derived', source: event.entry.id })
}, { failOnError: true })

put to books-a: { id: 'a', name: 'Alice' }

get from books-a: 'a' → exists
get from books-b: 'derived' → exists
```

Both documents must exist. If either write fails, neither should persist. Phase 1 handlers access books through the `guild()` singleton; transaction binding is transparent via `AsyncLocalStorage`.

### 2.12 Phase 1 handler failure rolls back handler's writes AND trigger

```
watch('owner', 'books-a', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  const booksB = stacks.book('owner', 'books-b')
  await booksB.put({ id: 'derived', source: event.entry.id })
  throw new Error('cascade failed')
}, { failOnError: true })

put to books-a: { id: 'a', name: 'Alice' } → rejects

get from books-a: 'a' → null
get from books-b: 'derived' → null
```

Both the trigger write and the handler's write must be rolled back.

### 2.12a Phase 2 handler writes are NOT atomic with the trigger

```
watch('owner', 'books-a', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  const booksB = stacks.book('owner', 'books-b')
  await booksB.put({ id: 'derived', source: event.entry.id })
  throw new Error('phase 2 error')
}, { failOnError: false })

put to books-a: { id: 'a', name: 'Alice' } → succeeds

get from books-a: 'a' → exists
get from books-b: 'derived' → exists
```

Phase 2 handlers run outside the transaction context — book operations commit independently. A Phase 2 handler error does not roll back either the trigger or the handler's own prior writes. Note: the handler must `await` the put before throwing — the write commits when the `put()` promise resolves, not when the handler returns.

### 2.13 Cascade handler triggers recursive Phase 1 handlers

```
// Handler on books-a writes to books-b
// Handler on books-b writes to books-c
watch('owner', 'books-a', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  await stacks.book('owner', 'books-b').put({ id: 'b1', from: 'a' })
}, { failOnError: true })

watch('owner', 'books-b', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  await stacks.book('owner', 'books-c').put({ id: 'c1', from: 'b' })
}, { failOnError: true })

put to books-a: { id: 'a1' }

get from books-a: 'a1' → exists
get from books-b: 'b1' → exists
get from books-c: 'c1' → exists
```

All three writes commit atomically.

### 2.13a Legitimate deep cascade succeeds within depth limit

```
// Chain of 5 books: a → b → c → d → e
watch('owner', 'books-a', async (event) => {
  await guild().apparatus<StacksApi>('stacks').book('owner', 'books-b').put({ id: 'b1', from: 'a' })
}, { failOnError: true })
watch('owner', 'books-b', async (event) => {
  await guild().apparatus<StacksApi>('stacks').book('owner', 'books-c').put({ id: 'c1', from: 'b' })
}, { failOnError: true })
watch('owner', 'books-c', async (event) => {
  await guild().apparatus<StacksApi>('stacks').book('owner', 'books-d').put({ id: 'd1', from: 'c' })
}, { failOnError: true })
watch('owner', 'books-d', async (event) => {
  await guild().apparatus<StacksApi>('stacks').book('owner', 'books-e').put({ id: 'e1', from: 'd' })
}, { failOnError: true })

put to books-a: { id: 'a1' }

get from books-a: 'a1' → exists
get from books-b: 'b1' → exists
get from books-c: 'c1' → exists
get from books-d: 'd1' → exists
get from books-e: 'e1' → exists
```

A cascade depth of 5 is well within the default limit (16). The depth counter must not incorrectly reject valid cascade chains.

### 2.14 Recursive cascade failure rolls back entire chain

```
// Same setup as 2.13, but the books-b handler throws
watch('owner', 'books-b', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  await stacks.book('owner', 'books-c').put({ id: 'c1', from: 'b' })
  throw new Error('deep cascade failed')
}, { failOnError: true })

put to books-a: { id: 'a1' } → rejects

get from books-a: 'a1' → null
get from books-b: 'b1' → null
get from books-c: 'c1' → null
```

The entire chain — trigger, first cascade, and second cascade — must all roll back.

### 2.14a Cascade depth limiting prevents infinite recursion

```
// Pre-seed a document so the put triggers an update (not a create)
put({ id: 'a', counter: 0 })

// Handler fires on every write and immediately writes again → infinite loop
watch('owner', 'book', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')
  const book = stacks.book('owner', 'book')
  await book.put({ ...event.entry, counter: (event.entry.counter ?? 0) + 1 })
}, { failOnError: true })

put({ id: 'a', counter: 1 }) → should throw with max-depth error, not stack overflow
get('a') → { id: 'a', counter: 0 }  (original state preserved — transaction rolled back)
```

The Stacks must enforce a maximum cascade depth (configurable, default 16). When the limit is reached, the current transaction rolls back and the originating write rejects with a descriptive error. Without this safeguard, a self-referencing or mutually-referencing cascade will stack overflow the process.

Note: the handler fires on *every* event type (create, update, delete) — there is no `event.type` guard. The pre-seeded document ensures the triggering put is an update, but the handler also fires on its own cascade writes (which are also updates to the same book). This creates the infinite recursion that the depth limiter must catch.

This is a **required** test, not optional. Cascade depth limiting is a safety invariant.

### 2.14a-phase2 Phase-2 cross-transaction re-entry depth limiting prevents infinite chains

```
// Pre-seed a document so the put triggers an update (not a create)
put({ id: 'a', counter: 0 })

// Phase-2 handler self-cycles: each post-commit hop opens a fresh
// transaction that triggers the next hop. The Phase-1 cascade-depth
// counter resets at every hop, so the Phase-2 bound is the only thing
// that can terminate the chain.
watch('owner', 'book', async (event) => {
  if (event.type === 'delete') return
  const stacks = guild().apparatus<StacksApi>('stacks')
  const book = stacks.book('owner', 'book')
  await book.put({ ...event.entry, counter: (event.entry.counter ?? 0) + 1 })
}, { failOnError: false })

put({ id: 'a', counter: 1 })
  → should reject with an error mentioning "Phase-2 re-entry depth"
  (NOT the Phase-1 cascade-depth wording — distinct error literal per D8)

get('a') → counter advanced past the seed, but stopped at the substrate
  bound (e.g., counter === MAX_PHASE2_REENTRY_DEPTH) — hops 1..N-1
  committed durably; hop N's write was rejected at the gate check
  before its transaction was opened (D10 partial-commit)
```

Sibling to **2.14a**. The Phase-1 cascade bound caps handler nesting *within* a transaction; this test exercises the orthogonal **Phase-2 re-entry depth bound** that caps post-commit hops *across* transactions. The two bounds are intentionally separate — a single handler chain that writes back to its own watched book through Phase 2 can re-enter Phase 2 indefinitely, and the per-transaction Phase-1 counter resets at every hop.

The error literal must mention **"Phase-2 re-entry depth"** and must not collide with the Phase-1 cascade-depth wording — distinct messages let log filtering and operators route to the correct remediation path (Phase 1 → break the cycle; Phase 2 → introduce a state-machine guard or move off a watched book).

The partial-commit assertion is load-bearing: Phase-2 commits are independent per hop, and the test's pre-seeded counter advances past its initial value because each hop's write does commit before the next hop is rejected. A future implementation that quietly buffers Phase-2 writes into a single rollback unit would break this assertion — and would change the durability contract.

This is a **required** test, not optional. The Phase-2 re-entry bound is a safety invariant — without it, a handler that accidentally self-writes through Phase 2 will pin the CPU rather than failing loud.

### 2.14b Transaction context survives across await boundaries in Phase 1 handlers

```
watch('owner', 'books-a', async (event) => {
  const stacks = guild().apparatus<StacksApi>('stacks')

  // First await — write to books-b
  const booksB = stacks.book('owner', 'books-b')
  await booksB.put({ id: 'b1', from: 'a' })

  // Second await — read back from books-b (must see uncommitted write)
  const result = await booksB.get('b1')
  assert(result !== null, 'read-your-writes must work across awaits')

  // Third await — write to books-c
  const booksC = stacks.book('owner', 'books-c')
  await booksC.put({ id: 'c1', from: 'a', confirmed: result!.id })
}, { failOnError: true })

put to books-a: { id: 'a1' }

get from books-a: 'a1' → exists
get from books-b: 'b1' → exists
get from books-c: 'c1' → exists (with confirmed: 'b1')
```

The `AsyncLocalStorage` transaction context must survive across multiple `await` points within a single Phase 1 handler. Each book operation — even those obtained from separate `guild().apparatus()` or `stacks.book()` calls after an `await` — must route through the same active transaction. This is inherent to how `AsyncLocalStorage` works in Node.js, but it is the mechanism the entire cascade model depends on.

**Note on non-awaited writes:** A non-awaited (fire-and-forget) book operation inside a Phase 1 handler also inherits the `AsyncLocalStorage` context and will attempt to join the active transaction — but the transaction may commit or roll back before the detached operation completes, producing undefined behavior. The spec (§6.2) documents this as a contract: all book operations inside Phase 1 handlers must be `await`-ed. This is not testable as a conformance case (the race condition is timing-dependent), but handler authors must be aware of it.

This is a **required** test. A failure here means the fundamental transaction propagation mechanism is broken.

### Coalescing tests

The following tests verify event coalescing during transactions. All 8 rows of the spec's coalescing table (§6.4) must be covered. Phase 2 handlers (`failOnError: false`) are used because coalescing applies to the events that Phase 2 observers receive — Phase 1 handlers fire per-write within the transaction.

### 2.15 Coalescing: create alone (inside explicit transaction)

```
const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })
})

events.length → 1
events[0].type → 'create'
events[0].entry → { id: 'a', name: 'Alice' }
```

Baseline: a single create inside a transaction produces one `create` event.

### 2.16 Coalescing: create → update produces `create` with final state

```
const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })
  await book.put({ id: 'a', name: 'Bob' })
})

events.length → 1
events[0].type → 'create'
events[0].entry.name → 'Bob'
// No prev field on create events
```

### 2.17 Coalescing: create → update → update produces `create` with final state

```
const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', status: 'draft' })
  await book.put({ id: 'a', status: 'active' })
  await book.put({ id: 'a', status: 'completed' })
})

events.length → 1
events[0].type → 'create'
events[0].entry.status → 'completed'
```

Phase 2 must see exactly one `create` event with the final state, not three events.

### 2.18 Coalescing: create → delete produces no event

```
const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })
  await book.delete('a')
})

events.length → 0
```

### 2.19 Coalescing: update (single) produces `update` with pre-transaction `prev`

```
put({ id: 'a', name: 'Alice' })

const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Bob' })
})

events.length → 1
events[0].type → 'update'
events[0].prev.name → 'Alice'
events[0].entry.name → 'Bob'
```

### 2.20 Coalescing: update → update produces single `update` with pre-transaction `prev`

```
put({ id: 'a', name: 'Alice' })

const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Bob' })
  await book.put({ id: 'a', name: 'Charlie' })
})

events.length → 1
events[0].type → 'update'
events[0].prev.name → 'Alice'      // pre-transaction
events[0].entry.name → 'Charlie'   // final
```

### 2.21 Coalescing: update → delete produces `delete` with pre-transaction `prev`

```
put({ id: 'a', name: 'Alice' })

const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Bob' })    // intermediate state
  await book.delete('a')
})

events.length → 1
events[0].type → 'delete'
events[0].prev.name → 'Alice'   // pre-transaction state, not 'Bob'
```

### 2.22 Coalescing: delete (single, existing doc) produces `delete` with pre-transaction `prev`

```
put({ id: 'a', name: 'Alice' })

const events = []
watch('owner', 'book', (e) => events.push(e), { failOnError: false })

transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.delete('a')
})

events.length → 1
events[0].type → 'delete'
events[0].prev.name → 'Alice'
```

### Coalescing coverage matrix

All 8 rows of the spec's coalescing table are now covered:

| Sequence | Expected event | Test |
|---|---|---|
| create | `create` (final) | 2.15 |
| create → update | `create` (final) | 2.16 |
| create → update → update | `create` (final) | 2.17 |
| create → delete | no event | 2.18 |
| update | `update` (prev=pre-tx, entry=final) | 2.19 |
| update → update | `update` (prev=pre-tx, entry=final) | 2.20 |
| update → delete | `delete` (prev=pre-tx) | 2.21 |
| delete | `delete` (prev=pre-tx) | 2.22 |

---

## Tier 2.5 — Transaction Semantics

These sit between CDC correctness and query correctness. They verify that the transaction model works as specified.

### 2.23 Explicit transaction: all writes are atomic

```
transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })
  await book.put({ id: 'b', name: 'Bob' })
  await book.put({ id: 'c', name: 'Charlie' })
})

get('a') → exists
get('b') → exists
get('c') → exists
```

### 2.24 Explicit transaction: error rolls back all writes

```
try {
  transaction(async (tx) => {
    const book = tx.book('owner', 'book')
    await book.put({ id: 'a', name: 'Alice' })
    await book.put({ id: 'b', name: 'Bob' })
    throw new Error('abort')
  })
} catch (e) { /* expected */ }

get('a') → null
get('b') → null
```

### 2.25 Read-your-writes inside a transaction

```
transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })

  const result = await book.get('a')
  result → { id: 'a', name: 'Alice' }

  const found = await book.find({ where: [['name', '=', 'Alice']] })
  found.length → 1

  const count = await book.count([['name', '=', 'Alice']])
  count → 1
})
```

Uncommitted writes must be visible to reads within the same transaction.

### 2.25a OR queries see uncommitted writes inside a transaction

```
transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', status: 'active', role: 'admin' })
  await book.put({ id: 'b', status: 'draft',  role: 'user' })

  const found = await book.find({ where: { or: [
    [['status', '=', 'active']],
    [['role', '=', 'user']],
  ] } })
  found.length → 2

  const n = await book.count({ or: [
    [['status', '=', 'active']],
    [['role', '=', 'user']],
  ] })
  n → 2
})
```

OR queries inside a transaction must see uncommitted writes from the same transaction. Since the apparatus-level OR implementation runs multiple backend queries per branch, each branch must execute against the same transaction handle. This is a real correctness risk — if any branch runs outside the transaction, it will miss uncommitted writes.

### 2.26 Uncommitted writes are not visible outside the transaction

This test requires concurrency support to verify properly. For single-connection SQLite it's inherently satisfied (serialized access). For multi-connection backends (Postgres), this is critical:

```
// Start transaction A, write, do NOT commit yet
// In a separate context, read the same key
// The uncommitted write must not be visible
```

For SQLite backends, document that this is satisfied by the single-connection model. For future Postgres backends, this test becomes essential.

### 2.27 Implicit transaction spans write + Phase 1 handlers

```
// This is the same as 2.11/2.12 but framed from the implicit transaction perspective.
// A single put() outside an explicit transaction must create an implicit
// transaction that includes the write and all Phase 1 cascade handlers.

// No explicit transaction() call:
put({ id: 'a', name: 'Alice' })
// All Phase 1 handler writes are atomic with this put
```

### 2.28 Nested explicit transactions (if supported) or error on nesting

Decide and test one of:
- Nested `transaction()` calls are flattened into the outer transaction
- Nested `transaction()` calls throw immediately

Either behavior is acceptable but must be documented and tested.

### 2.29 Transaction return value is propagated

```
const result = await stacks.transaction(async (tx) => {
  const book = tx.book('owner', 'book')
  await book.put({ id: 'a', name: 'Alice' })
  return 42
})

result → 42
```

The return value of the `transaction()` callback must be propagated to the caller. This matters for callers that compute results atomically (e.g., create a document and return its ID).

---

## Tier 3 — Query Correctness

These tests verify that the query language returns correct results.

### 3.1 Equality filter

```
put({ id: 'a', status: 'active' })
put({ id: 'b', status: 'cancelled' })

find({ where: [['status', '=', 'active']] }) → [{ id: 'a', ... }]
```

### 3.2 Inequality filter

```
find({ where: [['status', '!=', 'active']] }) → [{ id: 'b', ... }]
```

### 3.3 Range operators with numbers

```
put({ id: 'a', score: 10 })
put({ id: 'b', score: 20 })
put({ id: 'c', score: 30 })

find({ where: [['score', '>', 15]] }) → [b, c]
find({ where: [['score', '>=', 20]] }) → [b, c]
find({ where: [['score', '<', 20]] }) → [a]
find({ where: [['score', '<=', 20]] }) → [a, b]
```

### 3.4 Range operators with strings (lexicographic)

```
put({ id: 'a', name: 'Alice' })
put({ id: 'b', name: 'Bob' })
put({ id: 'c', name: 'Charlie' })

find({ where: [['name', '>', 'Bob']] }) → [Charlie]
find({ where: [['name', '>=', 'Bob']] }) → [Bob, Charlie]
```

### 3.5 LIKE operator

```
put({ id: 'a', name: 'Alice' })
put({ id: 'b', name: 'Alison' })
put({ id: 'c', name: 'Bob' })

find({ where: [['name', 'LIKE', 'Ali%']] }) → [Alice, Alison]
find({ where: [['name', 'LIKE', '_ob']] }) → [Bob]
```

### 3.6 IN operator

```
put({ id: 'a', status: 'active' })
put({ id: 'b', status: 'draft' })
put({ id: 'c', status: 'cancelled' })

find({ where: [['status', 'IN', ['active', 'cancelled']]] }) → [a, c]
```

### 3.7 Empty IN list returns no results

```
find({ where: [['status', 'IN', []]] }) → []
```

Must not error. Must return empty.

### 3.8 IS NULL / IS NOT NULL

```
put({ id: 'a', label: null })
put({ id: 'b', label: 'tagged' })

find({ where: [['label', 'IS NULL']] }) → [a]
find({ where: [['label', 'IS NOT NULL']] }) → [b]
```

### 3.9 IS NULL for missing fields

```
put({ id: 'a', name: 'Alice' })   // no 'label' field at all

find({ where: [['label', 'IS NULL']] }) → [a]
```

A field that was never set must behave as null for IS NULL queries. This is a critical backend conformance point — some backends distinguish between "field is null" and "field is absent."

### 3.9a IS NOT NULL excludes documents with absent fields

```
put({ id: 'a', name: 'Alice' })         // no 'label' field
put({ id: 'b', label: 'tagged' })
put({ id: 'c', label: null })

find({ where: [['label', 'IS NOT NULL']] }) → [b]
```

Documents where the field was never set (id `a`) and documents where the field is explicitly `null` (id `c`) must both be excluded from `IS NOT NULL` results. Only documents with a non-null value for the field should match.

### 3.10 Multiple conditions are AND-ed

```
put({ id: 'a', status: 'active', score: 30 })
put({ id: 'b', status: 'active', score: 10 })
put({ id: 'c', status: 'draft',  score: 30 })

find({ where: [['status', '=', 'active'], ['score', '>', 20]] }) → [a]
```

### 3.11 Dot-notation for nested fields

```
put({ id: 'a', parent: { id: 'p1' } })
put({ id: 'b', parent: { id: 'p2' } })

find({ where: [['parent.id', '=', 'p1']] }) → [a]
```

### OR query tests

The following tests verify `{ or: [...] }` query support. When `where` is `{ or: [clause1, clause2, ...] }`, each clause is an AND-clause (array of conditions), results are unioned across clauses, deduplicated by `id`, then sorted and paginated.

### 3.12 OR with non-overlapping branches returns the union

```
put({ id: 'a', status: 'active', role: 'admin' })
put({ id: 'b', status: 'draft',  role: 'user' })
put({ id: 'c', status: 'cancelled', role: 'admin' })

find({ where: { or: [
  [['status', '=', 'active']],
  [['status', '=', 'cancelled']],
] } }) → [a, c]
```

Each OR branch is an independent AND-clause. The results are the union of both branches.

### 3.13 OR with overlapping branches deduplicates by id

```
put({ id: 'a', status: 'active', role: 'admin' })
put({ id: 'b', status: 'draft',  role: 'admin' })
put({ id: 'c', status: 'active', role: 'user' })

find({ where: { or: [
  [['status', '=', 'active']],
  [['role', '=', 'admin']],
] } }) → [a, b, c]
```

Document `a` matches both branches but must appear only once in the results.

### 3.14 OR results respect orderBy and pagination

```
put({ id: 'a', status: 'active', score: 30 })
put({ id: 'b', status: 'draft',  score: 10 })
put({ id: 'c', status: 'active', score: 20 })
put({ id: 'd', status: 'draft',  score: 40 })

find({
  where: { or: [
    [['status', '=', 'active']],
    [['status', '=', 'draft']],
  ] },
  orderBy: ['score', 'asc'],
  limit: 2,
  offset: 1,
}) → [c, a]   // scores: 10(b), 20(c), 30(a), 40(d) → offset 1, limit 2
```

Sorting and pagination are applied to the merged, deduplicated result set — not to individual branches.

### 3.15 OR with empty branches array returns no results

```
put({ id: 'a', status: 'active' })

find({ where: { or: [] } }) → []
```

Must not error. Must return empty. Note the distinction from 3.16: `{ or: [] }` has *no branches* — there is nothing to match. This is analogous to an empty `IN` list (3.7).

### 3.16 OR with one empty branch matches all documents

```
put({ id: 'a', status: 'active' })
put({ id: 'b', status: 'draft' })
put({ id: 'c', status: 'cancelled' })

find({ where: { or: [
  [['status', '=', 'active']],
  [],
] } }) → [a, b, c]
```

An empty AND-clause (a branch with no conditions) matches all documents — no conditions means no filter. This means `{ or: [[], ...anything] }` is equivalent to an unfiltered query. This is logically consistent: `{ or: [] }` (no branches) returns nothing; `{ or: [[]] }` (one branch, no conditions) returns everything.

Note the asymmetry with 3.15: "no branches" vs "a branch with no conditions" are semantically different. `{ or: [] }` = "match none of these zero alternatives" = nothing. `{ or: [[]] }` = "match this one alternative which has no constraints" = everything.

### 3.17 count() with OR predicate returns deduplicated count

```
put({ id: 'a', status: 'active', role: 'admin' })
put({ id: 'b', status: 'draft',  role: 'admin' })
put({ id: 'c', status: 'active', role: 'user' })

count({ or: [
  [['status', '=', 'active']],
  [['role', '=', 'admin']],
] }) → 3
```

Document `a` matches both branches but must be counted only once. The deduplicated count is 3, not 4.

**Implementation note:** Since deduplication requires knowing which documents overlap, the apparatus cannot simply sum per-branch counts from `BackendTransaction.count()`. It must either run the OR as multiple `find()` calls (fetching IDs to deduplicate) or use an alternative strategy. This means `count()` with an OR predicate does *not* benefit from the "no payload fetch" optimization that AND-only `count()` provides. This performance trade-off is acceptable for v1 — OR queries are expected to be uncommon and datasets small. Document this in the apparatus implementation.

### 3.17a OR with dot-notation and range operators

```
put({ id: 'a', parent: { id: 'p1' }, score: 10 })
put({ id: 'b', parent: { id: 'p2' }, score: 50 })
put({ id: 'c', parent: { id: 'p1' }, score: 90 })

find({ where: { or: [
  [['parent.id', '=', 'p2']],
  [['score', '>', 80]],
] } }) → [b, c]
```

OR branches use the same query path as AND clauses. Dot-notation, range operators, LIKE, IN, and null checks must all work within OR branches.

### 3.17b OR with orderBy on a field absent from some documents

```
put({ id: 'a', status: 'active', score: 30 })
put({ id: 'b', status: 'draft' })               // no 'score' field
put({ id: 'c', status: 'active', score: 10 })

find({
  where: { or: [
    [['status', '=', 'active']],
    [['status', '=', 'draft']],
  ] },
  orderBy: ['score', 'asc'],
}) → order must be deterministic; documents with missing 'score' sort consistently
```

When `orderBy` references a field that some documents lack, the sort behavior for missing fields must be consistent across backends. The typical convention is that `null`/absent sorts before all values in ascending order (or after all values in descending order), but the specific choice is backend-defined. The key requirement is that the ordering is **stable and deterministic**, not that it matches a specific convention.

### 3.18 Sort ascending and descending

```
put({ id: 'a', score: 30 })
put({ id: 'b', score: 10 })
put({ id: 'c', score: 20 })

find({ orderBy: ['score', 'asc'] }) → [b, c, a]
find({ orderBy: ['score', 'desc'] }) → [a, c, b]
```

### 3.19 Multi-field sort

```
put({ id: 'a', status: 'active', score: 20 })
put({ id: 'b', status: 'active', score: 10 })
put({ id: 'c', status: 'draft',  score: 30 })

find({ orderBy: [['status', 'asc'], ['score', 'desc']] }) → [a, b, c]
```

### 3.20 Pagination: limit

```
put 5 documents
find({ limit: 2 }) → exactly 2 results
```

### 3.21 Pagination: limit + offset

```
put({ id: 'a', score: 10 })
put({ id: 'b', score: 20 })
put({ id: 'c', score: 30 })

find({ orderBy: ['score', 'asc'], limit: 2, offset: 1 }) → [b, c]
```

### 3.22 Count without predicate

```
put 3 documents
count() → 3
```

### 3.23 Count with predicate

```
put({ id: 'a', status: 'active' })
put({ id: 'b', status: 'draft' })
put({ id: 'c', status: 'active' })

count([['status', '=', 'active']]) → 2
```

### 3.24 List returns all documents

```
put 3 documents
list() → 3 documents
```

### 3.25 List respects orderBy and pagination

```
list({ orderBy: ['id', 'asc'], limit: 2 }) → first 2 by id
```

### 3.26 Field name validation rejects dangerous input

```
find({ where: [['status; DROP TABLE--', '=', 'x']] }) → throws immediately
find({ where: [['name"', '=', 'x']] }) → throws immediately
find({ where: [['valid.field', '=', 'x']] }) → does not throw
find({ where: [['under_score', '=', 'x']] }) → does not throw
```

Characters outside `[A-Za-z0-9_.-]` must be rejected before reaching the query engine.

---

## Tier 4 — Edge Cases and Ergonomics

### 4.1 Cross-plugin read isolation

```
// Plugin A owns 'tasks'
const writeHandle = stacks.book<Task>('plugin-a', 'tasks')
const readHandle  = stacks.readBook<Task>('plugin-a', 'tasks')

writeHandle.put({ id: 'a', title: 'test' })
readHandle.get('a') → { id: 'a', title: 'test' }

// readHandle must NOT expose put, patch, or delete
// (This is a compile-time check, but runtime verification is also good)
```

### 4.2 Books are isolated by owner + name

```
stacks.book('plugin-a', 'items').put({ id: 'x', name: 'A-item' })
stacks.book('plugin-b', 'items').put({ id: 'x', name: 'B-item' })

stacks.book('plugin-a', 'items').get('x') → { id: 'x', name: 'A-item' }
stacks.book('plugin-b', 'items').get('x') → { id: 'x', name: 'B-item' }
```

Same book name under different owners must be completely independent.

### 4.3 Watch registration after CDC seal throws

```
put({ id: 'a', name: 'Alice' })
watch('owner', 'book', handler)   // OK — writes no longer seal
sealCdc()                          // arbor fires phase:started
watch('owner', 'book', handler) → throws
```

Per the spec, watch must be called during startup. The Stacks seals the
CDC registry when arbor fires `phase:started`, after every apparatus has
finished starting — not on the first write. This lets an apparatus run
startup-time writes (e.g. idempotent migrations) without locking out a
dependent apparatus that registers watchers later in the topological
order.

### 4.4 Large document round-trip

```
// Create a document with a large nested structure (e.g. 100KB of JSON)
put({ id: 'big', data: generateLargeNestedObject() })
get('big') → exact structural match
```

Verify no truncation or serialization limits.

### 4.5 Special characters in string values

```
put({ id: 'a', name: "O'Brien", note: 'Line1\nLine2', data: '{"json":"in a string"}' })
get('a') → exact match including quotes, newlines, embedded JSON strings
```

### 4.6 Boolean and numeric type fidelity in queries

```
put({ id: 'a', active: true, count: 0 })
put({ id: 'b', active: false, count: 1 })

find({ where: [['active', '=', true]] }) → [a] only
find({ where: [['active', '=', false]] }) → [b] only
find({ where: [['count', '=', 0]] }) → [a] only
```

This is a critical SQLite conformance test. SQLite stores booleans as integers (0/1). The backend must ensure that `true` matches `true`, not `1`, and `false` matches `false`, not `0` — or at minimum, the behavior must be consistent and documented.

### 4.7 Concurrent implicit transactions (future backends)

For SQLite with single-connection better-sqlite3 this is N/A (serialized). For async backends, verify:

```
// Two concurrent put() calls to different documents
// Both must succeed, neither must block indefinitely
Promise.all([
  book.put({ id: 'a', name: 'Alice' }),
  book.put({ id: 'b', name: 'Bob' }),
])
get('a') → exists
get('b') → exists
```

### 4.8 Empty book operations

```
// Fresh book, no documents written
get('nonexistent') → null
find({ where: [['status', '=', 'active']] }) → []
list() → []
count() → 0
```

### 4.9 Index creation is additive

```
ensureBook(ref, { indexes: ['status'] })
// Write some data
ensureBook(ref, { indexes: ['status', 'createdAt'] })
// 'status' index must still work
// 'createdAt' index must now work
// No data loss
```

### 4.9a ensureBook is idempotent

```
ensureBook(ref, { indexes: ['status', 'createdAt'] })
put({ id: 'a', status: 'active', createdAt: '2025-01-01' })
ensureBook(ref, { indexes: ['status', 'createdAt'] })   // same schema again
get('a') → { id: 'a', status: 'active', createdAt: '2025-01-01' }
```

Calling `ensureBook()` with the same schema must be a no-op. No data loss, no errors, no index duplication. This is important for apparatus restart scenarios where `start()` is called again with the same book declarations.

### 4.9b Compound index declaration

```
ensureBook(ref, { indexes: [['status', 'createdAt']] })
put({ id: 'a', status: 'active', createdAt: '2025-01-01' })
put({ id: 'b', status: 'draft',  createdAt: '2025-01-02' })
put({ id: 'c', status: 'active', createdAt: '2025-01-03' })

find({ where: [['status', '=', 'active']], orderBy: ['createdAt', 'asc'] }) → [a, c]
```

A `string[]` entry in the `indexes` array creates a compound multi-column index. Queries filtering and sorting on the compound's fields must return correct results.

### 4.9c Compound and single-field indexes coexist

```
ensureBook(ref, { indexes: ['status', ['status', 'createdAt']] })
put({ id: 'a', status: 'active', createdAt: '2025-01-01' })
put({ id: 'b', status: 'draft',  createdAt: '2025-01-02' })

// Single-field index query
find({ where: [['status', '=', 'active']] }) → [a]

// Compound index query
find({ where: [['status', '=', 'active']], orderBy: ['createdAt', 'asc'] }) → [a]
```

Single-field and compound indexes in the same `indexes` array must both be created and functional. No conflict or data loss.

### 4.9d Additive compound indexes preserve data

```
ensureBook(ref, { indexes: ['status'] })
put({ id: 'a', status: 'active', createdAt: '2025-01-01' })

ensureBook(ref, { indexes: ['status', ['status', 'createdAt']] })
get('a') → { id: 'a', status: 'active', createdAt: '2025-01-01' }

find({ where: [['status', '=', 'active']], orderBy: ['createdAt', 'asc'] }) → [a]
```

Adding a compound index to an existing book with data must not cause data loss. The new compound index must be usable immediately after `ensureBook()`.

### 4.9e Compound index with dot-notation fields

```
ensureBook(ref, { indexes: [['status', 'parent.id']] })
put({ id: 'a', status: 'active', parent: { id: 'p1' } })
put({ id: 'b', status: 'active', parent: { id: 'p2' } })
put({ id: 'c', status: 'draft',  parent: { id: 'p1' } })

find({ where: [['status', '=', 'active'], ['parent.id', '=', 'p1']] }) → [a]
```

A compound index can include dot-notation fields. The combination of compound indexing and nested field access must produce correct query results.

### 4.10 *(Removed in v6)*

Previously tested that `HandlerContext` was scoped to the observing plugin. With the `guild()` singleton model, handlers no longer receive a context parameter — they access infrastructure via the process-level `guild()` accessor, same as all other plugin code. Plugins know their own identity via hardcoded constants. The property this test was protecting is now guaranteed by the simpler architecture.

### 4.11 Result ordering without `orderBy` is stable

```
put({ id: 'c', name: 'Charlie' })
put({ id: 'a', name: 'Alice' })
put({ id: 'b', name: 'Bob' })

result1 = find({ where: [['name', 'IS NOT NULL']] })
result2 = find({ where: [['name', 'IS NOT NULL']] })
result1.map(d => d.id) → same as result2.map(d => d.id)
```

When no `orderBy` is specified, the result order is backend-defined but must be **stable** — the same query against the same data must return results in the same order. This does not mean the order is *predictable* (insertion order is not guaranteed), only that it is *deterministic*.

Plugin code should not depend on unordered result ordering, but tests that assert on result sets should not be flaky due to nondeterministic ordering.

---

## Implementation Notes

### Test harness structure

Each tier should be runnable independently. The recommended structure:

```
packages/plugins/stacks/src/
  conformance/
    suite.ts                    # Parametric suite — exports registration functions
    tier1-data-integrity.ts     # Tier 1 test definitions
    tier2-cdc.ts                # Tier 2 test definitions
    tier2.5-transactions.ts     # Tier 2.5 test definitions
    tier3-queries.ts            # Tier 3 test definitions
    tier4-edge-cases.ts         # Tier 4 test definitions
    helpers.ts                  # Shared utilities (event collectors, fixtures, seeding)
  conformance.memory.test.ts    # Runs suite against MemoryBackend
  conformance.sqlite.test.ts    # Runs suite against SqliteBackend (not yet implemented)
```

The `helpers.ts` module should accept a `StacksBackend` factory function, so the same suite runs against SQLite, in-memory, or any future backend:

```typescript
export function createTestStacks(backendFactory: () => StacksBackend): {
  stacks: StacksApi;
  backend: StacksBackend;
  sealCdc(): void;
} {
  // Each test gets a fresh backend instance
  // Books are created fresh per test
  // No state leaks between tests
}
```

### What to test at the backend level vs. the apparatus level

Most tests in this document target the `StacksApi` surface — the apparatus layer that wraps the backend. This is correct because conformance is defined at the API boundary, not the storage boundary.

However, a few tests benefit from backend-level assertions:

- **2.6 (no pre-read when no handlers registered):** Requires instrumenting the backend to verify that `put()` was called with `withPrev: false`.
- **2.26 (isolation of uncommitted writes):** Requires concurrent access, only meaningful for multi-connection backends.
- **4.9 (additive indexes):** May require inspecting backend schema state.
- **4.9b–4.9e (compound indexes):** Efficiency verification (e.g., `EXPLAIN QUERY PLAN` in SQLite) is backend-specific. Correctness is tested at the API level; efficiency is a backend-specific supplementary concern.
- **BackendTransaction.count() signature:** The `count()` method accepts `where?: InternalCondition[]` (conditions only, no pagination fields). This is enforced by the TypeScript type system at the backend level. Backend implementations should verify their `count()` does not accept or depend on `limit`/`offset` fields.

For these, consider a small set of backend-specific tests that supplement the conformance suite.

### Test data seeding pattern

Tests that need pre-existing data before registering watchers no longer face the historical timing challenge, since writes no longer seal the CDC registry — only an explicit `sealCdc()` (or arbor's `phase:started` event in production) does. Tests can still use the backend-level seed helper when they want to set up state without going through `StacksApi`:

```typescript
function seedDocument(
  backend: StacksBackend,
  ref: BookRef,
  entry: BookEntry,
): void {
  const tx = backend.beginTransaction();
  tx.put(ref, entry);
  tx.commit();
}
```

This is consistent with the conformance layering — backend-level seeding doesn't go through the CDC path, so there's no lock conflict and no spurious CDC events during setup.

### CDC testing pattern

Most CDC tests follow the same pattern:

1. Set up books and seed data (via backend if needed)
2. Register watchers with event collectors
3. Perform writes through `StacksApi`
4. Assert on collected events (type, count, field values, ordering)

Extract this into a helper:

```typescript
function collectEvents<T extends BookEntry>(
  stacks: StacksApi,
  ownerId: string,
  bookName: string,
  options?: WatchOptions,
): ChangeEvent<T>[]
```

### SQLite-specific conformance notes

Several tests have SQLite-specific implications worth noting:

- **4.6 (Boolean/numeric type fidelity):** SQLite stores booleans as integers. The `SqliteBackend` must handle `true`/`false` ↔ `1`/`0` translation correctly. The `MemoryBackend` preserves JavaScript values natively. This test is likely to pass trivially on `MemoryBackend` and require explicit handling in `SqliteBackend`.

- **3.9 / 3.9a (IS NULL for missing fields):** In SQLite with `json_extract()`, a missing field returns `NULL`, which naturally matches `IS NULL`. The `MemoryBackend` returns `undefined` for absent fields, and `value == null` catches both. Both backends should pass, but for different internal reasons.

- **1.3 (Falsy value preservation):** SQLite's type affinity can coerce values. The JSON-blob storage model avoids this because `json_extract` returns the JSON-native type, but backends using non-JSON column types must handle this carefully.

- **4.9b–4.9e (Compound indexes):** SQLite creates compound indexes via `CREATE INDEX ... ON table(col1, col2)`. The `MemoryBackend` does not use indexes (full scan), so compound index tests verify correctness only — not performance. Backend-specific tests can verify index usage via `EXPLAIN QUERY PLAN`.

### OR query implementation notes

OR queries are implemented at the apparatus level in v1 — the backend's `InternalQuery` remains AND-only. The apparatus runs one backend query per OR branch, then merges, deduplicates by `id`, sorts, and paginates the combined result set in memory.

This means:

- **Correctness is testable at the API level** — all OR tests in Tier 3 target `StacksApi`.
- **Performance degrades with many branches or large result sets** — each branch is a separate backend query. Acceptable for v1; backend-level OR support can be added later as an optimization.
- **Deduplication uses document `id`** — if the same document appears in multiple branches, it appears once in the result with the state from whichever branch returned it (all branches read from the same committed state, so the document state is identical regardless).
- **`count()` with OR cannot use the backend's efficient count path** — deduplication requires knowing which IDs overlap, so the apparatus must fetch documents (or at minimum IDs) to count correctly. This is a known performance trade-off for v1. See test 3.17 implementation note.
- **Inside transactions, all OR branches must run against the same transaction handle** — see test 2.25a. The apparatus must not open separate backend transactions for individual branches when executing within an explicit `transaction()` scope.
