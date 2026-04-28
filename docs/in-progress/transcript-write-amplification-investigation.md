# Investigation: per-NDJSON-message transcript write amplification

**Status:** investigation only — no code change is authorized by this writeup.
**Origin:** S6 of the claude-code follow-on refactor brief.
**Recommendation (TL;DR):** **Defer.** The current shape is spec-compliant and the trade-offs against a query-time aggregator are not yet sharp enough to authorize a redesign. Re-open if a concrete operator complaint or measurement shows up.

## Problem statement

`packages/plugins/claude-code/src/runtime.ts` — the babysitter's stdout listener (in `babysitter.ts`'s steady-state phase) calls `writeTranscript(db, sessionId, acc.transcript)` after every NDJSON message that mutates the accumulator. `writeTranscript` serializes the **entire** transcript-so-far as JSON and issues `INSERT OR REPLACE INTO books_animator_transcripts (id, content) VALUES (?, ?)`.

```ts
// runtime.ts: schema and statement
CREATE TABLE IF NOT EXISTS books_animator_transcripts (
  id      TEXT PRIMARY KEY,
  content TEXT NOT NULL  -- JSON: { id: sessionId, messages: TranscriptMessage[] }
)
INSERT OR REPLACE INTO books_animator_transcripts (id, content) VALUES (?, ?)
```

For an N-message session, this is **O(N²) bytes written, O(N²) JSON serialization time**:

- Message 1 arrives → JSON-stringify a 1-element array, write.
- Message 2 arrives → JSON-stringify a 2-element array, write.
- …
- Message N arrives → JSON-stringify the full N-element array, write.

Cumulative bytes ≈ `(N × (N+1) / 2) × avg_message_size`. SQLite WAL absorbs most of this without page churn for moderate N, but the cost is real and superlinear.

## Constraint from the architecture spec

`docs/architecture/detached-sessions.md` § Transcript availability is binding:

> The update cadence must make "real time" meaningful: at minimum, on every meaningful unit of anima output (per-message or per-content-block, not per-session).

The current implementation satisfies this — readers see fresh transcript content within a single message of arrival. Any redesign must preserve per-message visibility; an end-of-session-only flush is not on the table.

## Reader inventory and contract

Each reader of `books_animator_transcripts` (or its `TranscriptDoc` wrapper API) carries a contract a redesign must preserve.

| # | Reader | Site | Contract |
|---|--------|------|----------|
| 1 | `Animator.recordSession` | `packages/plugins/animator/src/animator.ts:856` | Reads via `stacks.book<TranscriptDoc>('animator', 'transcripts')`. Expects a single `TranscriptDoc = { id: string; messages: TranscriptMessage[] }` — the whole transcript reified as one in-memory object. |
| 2 | `session-record-handler` | `packages/plugins/animator/src/session-record-handler.ts:127` | Same `TranscriptDoc` API, same single-doc shape. Used on duplicate-terminal-report and detached-mode write paths. |
| 3 | `TranscriptDoc` type definition | `packages/plugins/animator/src/types.ts:593–600` | `interface TranscriptDoc { id: string; messages: TranscriptMessage[] }`. The full-array shape is the public contract. |
| 4 | Oculus dashboard transcript routes | `packages/plugins/animator/src/oculus-routes.ts:139–211` | Three sites: `/api/animator/session-transcript` (line 140) and two SSE streaming routes (170, 210). Each reads `TranscriptEntry { id, messages: Record<string, unknown>[] }` — the same multi-message single-row shape. |
| 5 | Animator test fixtures | `packages/plugins/animator/src/animator.test.ts` and `tools/session-lifecycle.test.ts:84` | Read via `stacks.readBook<TranscriptDoc>('animator', 'transcripts').get(sessionId)`. One row per session. |
| 6 | claude-code runtime test fixtures | `packages/plugins/claude-code/src/runtime.test.ts` | Direct SQLite `SELECT * FROM books_animator_transcripts WHERE id = ?`. Asserts exactly one row, parses `content` as JSON. Pinned to the single-row schema. |

Every reader expects a **single row per session, a JSON blob containing all messages**. There is no reader today that wants a per-message stream from this table — the streaming-style consumers (Oculus SSE) re-derive a stream from whole-doc reads.

## Trade-off analysis

### Option A: keep the current shape (the do-nothing baseline)

- **Cost:** O(N²) write amplification on the writer; O(1) on every reader.
- **Per-row size cap:** SQLite text columns have no practical cap below billions of bytes; sessions with thousands of messages are well within bounds.
- **Reader impact:** zero. Every reader reads one row.
- **Operator impact:** unmeasured. No incident, no operator complaint, no traceable performance regression has named this site.
- **Spec compliance:** satisfies "per-message visibility" by construction.

### Option B: append-only schema, query-time aggregator on read

A redesign would shift `books_animator_transcripts` from `{id, content}` to something like:

```sql
CREATE TABLE books_animator_transcripts (
  id        TEXT NOT NULL,    -- session id
  seq       INTEGER NOT NULL, -- message index, monotonic
  message   TEXT NOT NULL,    -- single TranscriptMessage as JSON
  PRIMARY KEY (id, seq)
)
```

The writer becomes a single `INSERT` per message — O(1) per message, O(N) cumulative — instead of an O(N) full rewrite per message.

But every reader on the inventory above expects a single `TranscriptDoc { id, messages[] }`. A query-time aggregator (`SELECT message FROM ... WHERE id = ? ORDER BY seq` then JSON-array-wrap) becomes a **public-contract change** the size of the `TranscriptDoc` reader surface:

- The `TranscriptDoc` API on `stacks.book` would need a custom assembler — the current Stacks Book assumes one row → one doc, not N rows → one doc. Either Stacks grows a "compound row" abstraction (a meaningful new public surface), or every reader bypasses the Book API and SQLs directly against the new schema.
- Three Oculus routes would need their reader rewritten or a shared aggregator helper.
- Two test fixtures plus the claude-code runtime test would need their assertions rewritten.

The win is real (writer amortized O(1) per message) but the reader-contract surface cost is broad. The work is not the schema migration — it is the contract migration on six reader sites.

### Option C: hybrid — keep `{id, content}`, batch the writer

A middle path: the writer still produces a single-row JSON blob, but coalesces multiple incoming messages into one write. E.g. write at most every K messages or every T milliseconds, whichever comes first.

- **Cost:** O((N/K)²) write amplification — strict improvement on Option A by a constant factor of K².
- **Reader impact:** zero. The on-disk shape is unchanged.
- **Spec impact:** "per-message visibility" softens to "per-K-message visibility." For K small (e.g. 1–4) and T small (e.g. 100ms), the spec's "real time" intent is preserved; for K or T larger, it is not.
- **Operator impact:** the same as Option A, but cheaper.

This option does not require any reader-contract change. Its risk is the cadence-vs-spec balance.

## Why "defer" is the right answer for now

The brief's Decision D12 is investigation-only and explicitly avoids authorizing implementation. Three independent observations support deferral:

1. **No measurement.** No production incident, log, or operator complaint has named this write site. The "O(N²)" framing is a structural argument, not an empirical one. Sessions in the wild are bounded by the model context window — a few hundred messages, maybe up to a thousand on long-running petitions. At those Ns, on a WAL-mode SQLite, the absolute wall-clock cost is small.

2. **Reader-contract surface is broad.** Every alternative that improves the writer at superlinear scale (Option B) costs broad reader-contract migration. Every alternative that does not (Option C) is a minor, easily-reversible local change. Spending the implementation budget on a broad migration before the small local change has been tried — let alone measured against — is poor sequencing.

3. **The current shape is spec-compliant.** § Transcript availability mandates per-message visibility; the current implementation provides it. A future reader (e.g. a streaming-style debugger that wants new messages without re-reading the whole transcript) would shift the calculus, but no such reader exists today.

## Recommendation

**Defer the redesign. Authorize no follow-on commission against this site at this time.**

If a future signal changes the calculus — operator complaint, measured slowness, a streaming-style consumer that wants per-message rows — re-open this investigation with the new evidence. At that point, prefer Option C (writer-side batching with a small cadence cap that preserves per-message visibility) before considering Option B (full schema migration with broad reader-contract impact). Option B is on the table only if a reader emerges that genuinely cannot use the single-row blob.

## Out of scope

- This investigation does not modify `books_animator_transcripts`, the `TranscriptDoc` API, the Oculus routes, or any reader's contract.
- It does not modify `writeTranscript`'s call cadence in the babysitter's steady-state phase.
- A future commission, if dispatched, would have its own brief and its own decision record.
