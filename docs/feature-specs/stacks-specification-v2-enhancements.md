# The Stacks — Merged Spec Findings

Consolidated from two independent reviews of `docs/architecture/apparatus/stacks.md`.

---

## A. Must/Should Change for v1

> These items were all implemented.

---

## B. Deferrable Improvements

Good ideas that aren't blocking for v1. Track for future versions.

### B1. Bulk write operations (`putMany()`, bulk delete)

Inserting 100 documents = 100 individual `put()` calls, 100 pre-reads for CDC, 100 handler invocations. Inside a `transaction()` this is atomic but slow. A `putMany()` that batches pre-reads and fires coalesced CDC events would be a significant performance win for data seeding and batch operations.

### B2. Compound index declarations

> This was implemented in v1.

### B3. `exists()` / `any()` convenience method

`get(id) !== null` fetches the full payload; `count(where) > 0` scans all matches. A dedicated `exists(id)` with `LIMIT 1` would be trivially cheap. Low priority but easy to add.

### B4. Cursor-based pagination

Offset pagination requires scanning and discarding rows, degrading on large result sets. Keyset pagination (on `id` or the sort field) would be more robust. Fine to defer — Nexus datasets are small for now.

### B5. Aggregation primitives

Every summary query requires fetching all documents and computing in-memory. A `distinct(field)` or `groupCount(field)` would cover the 80% case without breaking the abstraction. Defer until a book grows large enough to make `list()` + reduce painful.

### B6. OR query support

> NOTE: The API was stubbed for this in v1, although the implementation uses applciation-side filtering and so has degraded performance.

Currently: "run two queries, merge in application code." This pushes deduplication, re-sorting, and re-pagination to every callsite that needs OR. Acceptable for v1 — revisit if OR queries prove common.

### B7. Deep-merge `patch()`

Already noted as out of scope for v1 in the spec. Nested objects are "fully supported as document content," so the gap will surface, but `put()` with full document is a workable escape hatch.

### B8. Streaming / cursor reads for large result sets

`find()` returns `T[]` — entire result set in memory. No async iterator or cursor option. Fine while datasets are small. Add when a book exceeds low thousands of documents.

### B9. Watcher cleanup (`unwatch()`)

No mechanism to deregister handlers. For production (process lifecycle = watcher lifecycle) this is fine. For hot-reload during development, stale handlers could accumulate. Low priority.

### B10. Create→delete coalescing side-effect orphaning

If a Phase 1 handler creates a document and a later Phase 1 handler deletes it in the same transaction, Phase 2 observers see no event — logically correct (net effect is nothing). But if the first handler triggered non-database side effects, those effects are orphaned. Worth noting in the spec as a known consequence; no design change needed.

### B11. Phase 2 notification durability

If the process exits between commit and Phase 2 handler execution, notifications are lost. For Clockworks event emission, this means a write can commit without its corresponding event firing. Acceptable if Clockworks can poll or recover, but worth documenting as a known gap.

### B12. Consider Kysely or Drizzle inside the SQLite backend

Use a typed query builder instead of hand-written SQL string construction in the `StacksBackend` implementation. This is an implementation detail, not an architectural change — doesn't affect the public API or the spec. Evaluate during implementation.

---

## Addendum: Alternatives Landscape

The CRUD and query portions of the Stacks spec are commodity. The differentiating requirement is **transactional CDC** — specifically Phase 1 cascade handlers whose writes are atomic with the triggering write. No off-the-shelf offering provides this.

| Alternative | Doc store | ACID txns | Transactional CDC | No envelope | Embeddable | Verdict |
|---|---|---|---|---|---|---|
| **RxDB** | Yes | Partial | No (post-commit only) | No (`_rev`, schema versions) | Yes | Fights design goals; schema versioning contradicts no-migrations; you'd still build the cascade layer |
| **PouchDB** | Yes | Partial | No (changes feed is post-commit) | No (`_rev`) | Yes (LevelDB) | Wrong concurrency model; revision tracking is overhead for single-writer; envelope requirement conflicts with spec |
| **LokiJS / SylvieJS** | Yes | No | No | Yes | Yes (in-memory) | No transactions = no cascade atomicity; in-memory-first = durability risk; project effectively unmaintained |
| **Fireproof** | Yes | Partial | No | No (CRDT metadata) | Yes | CRDT model solves distributed problem Nexus doesn't have; immutable ledger = unbounded storage growth |
| **Raw SQLite** | Storage only | Yes | Build it yourself | Yes | Yes | Converges with the custom approach — you'd build the same abstraction; this *is* the Stacks backend |
| **Kysely / Drizzle** | Query layer | Via SQLite | Build it yourself | Yes | Via SQLite | Useful *inside* the SQLite backend implementation, not a replacement for the Stacks architecture |

**The gap every alternative shares:** None offers CDC handlers that execute *inside* the write transaction with their writes joining the same atomic unit. Every alternative's change notification is post-commit, which means cascade integrity requires either (a) eventual consistency + reconciliation jobs, or (b) inlining all cascade logic at the write site. Both are strictly worse for the Nexus use case than the two-phase model.

**Recommendation:** Build the Stacks as specified with the A-category fixes applied. The total implementation is ~800-1200 lines. The unique value — transactional cascade CDC — doesn't exist off the shelf, and the alternatives that come closest bring envelope requirements and concurrency models that conflict with the design goals.
