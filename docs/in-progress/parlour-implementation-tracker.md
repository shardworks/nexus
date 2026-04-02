# Parlour Implementation Tracker

Spec: `/workspace/nexus/docs/architecture/apparatus/parlour.md`
Package: `@shardworks/parlour` · Plugin id: `parlour`
Target location: `/workspace/nexus/packages/plugins/parlour/`

---

## Readiness Verdict

**Mostly ready, with two significant gaps.** The core conversation lifecycle (create, take turn, end, list, show) is well-specified and the dependency APIs exist. The two blockers are the inter-turn context assembly (depends on session artifacts that don't exist yet) and an API mismatch between the spec and the actual Animator.

---

## Dependency Status

| Dependency | Status | Notes |
|---|---|---|
| **The Stacks** | ✅ Implemented | Query API, books, indexes — all available. Cross-book reads work via `find()`. |
| **The Animator** | ✅ Implemented | `animate()` and `summon()` both work. Streaming via `streaming: true` flag. |
| **The Loom** | ✅ Implemented | `weave()` returns `AnimaWeave` with system prompt + tools. |

---

## Spec-to-Implementation Gap Analysis

### 🔴 Blockers

#### 1. Inter-Turn Context Assembly — No Session Artifacts

The spec's inter-turn context for convene conversations requires extracting the assistant's text response from session transcripts:

> "Read the session record artifact (if available) → Extract the assistant's text response from the transcript"

**Problem:** The Animator MVP does not write session record artifacts to disk (see Animator spec § Future: Session Record Artifacts). The Stacks session record contains telemetry (cost, duration, exit code) but **no transcript text**. There is no way to extract "what participant B said" from a session record.

**The spec acknowledges this** — it includes a fallback: `[participant]: [response not available]`. But this makes convene conversations nearly useless since participants can't see what others said.

**Options:**
1. **MVP with fallback only** — implement the placeholder. Convene works structurally but participants are blind to each other. Consult still works fine (human messages are passed directly).
2. **Add response capture to Animator** — have the Animator capture the final text response from the provider and store it on the session record (a small `responseText` field). This is a modest Animator enhancement, not a full artifact system.
3. **Streaming capture** — the Parlour already receives `SessionChunk` items when streaming. It could concatenate `text` chunks and store the assembled response itself.

**Recommendation:** Option 2 or 3. Option 3 is self-contained (no Animator changes) but only works when streaming is enabled. Option 2 is cleaner.

#### 2. API Mismatch: `animate()` vs `animateStreaming()`

The Parlour spec references two separate Animator methods:

> `animate() or animateStreaming()`

**Reality:** The Animator has a single `animate()` method with a `streaming: boolean` flag on the request. There is no `animateStreaming()`. The return shape is always `{ chunks, result }`.

**Impact:** Low — this is a spec wording issue, not a design problem. The Parlour just calls `animate({ ..., streaming: true })` instead of `animateStreaming()`. The `takeTurnStreaming()` method maps cleanly to this.

**Action:** Fix the spec reference. No code impact.

---

### 🟡 Open Questions (Need Decisions Before Implementation)

#### 3. Human Turn Counting

> "Do human turns count toward the turn limit?"

This affects consult conversations. The spec flags this explicitly as an open question. A decision is needed before implementing `takeTurn()` for human participants.

**Recommendation:** Count only anima turns. A `turnLimit: 10` on a consult means "10 anima responses." Human turns are just context delivery, not computational work.

#### 4. Conversation-Level Workspace (`cwd`)

> "Should the cwd be set once at conversation creation and stored in the conversation document?"

The spec flags this as an open question. `--resume` requires the same `cwd` across all turns. Two options:

- **Store on conversation doc** — safer, the Parlour enforces consistency.
- **Caller's responsibility** — more flexible, but easy to break.

**Recommendation:** Store on the conversation doc. Add `cwd: string` to `CreateConversationRequest` and `ConversationDoc`.

#### 5. Participant Ordering

> "Should The Parlour support explicit ordering or custom turn-order strategies?"

The spec says MVP uses insertion-order round-robin. Good enough to ship. Defer custom strategies to the Future section.

**Recommendation:** Ship with insertion-order round-robin. No decision needed now.

---

### 🟢 Ready to Implement

#### 6. Conversation Document & Stacks Book

Fully specified. `ConversationDoc` shape, indexes (`status`, `kind`, `createdAt`), nested participants — all clear. Maps directly to Stacks' `supportKit.books` API.

**Complexity:** Low

#### 7. `create()` — Create Conversation

Well-specified lifecycle. Generate IDs, resolve anima IDs, write doc. No session launched.

One detail to resolve: "resolve animaId" — the spec says this happens at creation time, but there's no Roster apparatus yet. At MVP, `animaId` could be left null or resolved from guild config if available.

**Complexity:** Low

#### 8. `takeTurn()` — Anima Turn (Consult)

For consult conversations, this is straightforward: pass the human's message as the prompt, call `animate()`, capture `providerSessionId`, update the doc.

**Complexity:** Low-Medium (the read-modify-write on the conversation doc needs care)

#### 9. `takeTurn()` — Anima Turn (Convene)

Same as consult, PLUS the inter-turn context assembly. This is the piece blocked by gap #1.

**Complexity:** Medium (dependent on inter-turn context decision)

#### 10. `takeTurn()` — Human Turn

Record the message for context. No session launched. Increment turn count (pending decision #3).

**Complexity:** Low

#### 11. `end()` — End Conversation

Trivially specified. Read doc, set status + `endedAt`. Idempotent.

**Complexity:** Low

#### 12. `nextParticipant()`

Round-robin for convene, anima-always for consult. Read conversation doc, count turns, return next in order.

**Complexity:** Low

#### 13. `list()` and `show()`

Standard Stacks queries. `list()` uses `find()` with filters. `show()` reads conversation doc + cross-book query to sessions for turn details.

`show()` cross-book query: needs to find sessions where `metadata.conversationId` matches. This works if `conversationId` is stored as a top-level indexed field on SessionDoc (it is — the Animator already indexes `conversationId`). ✅

**Complexity:** Low-Medium

#### 14. Support Kit Tools

Three tools: `conversation-list`, `conversation-show`, `conversation-end`. Standard tool definitions wrapping the API methods. Well-specified input/output shapes.

**Complexity:** Low

#### 15. Provider Session Continuity

The plumbing exists: `AnimateRequest` accepts `conversationId`, `SessionResult` returns `providerSessionId`. The Parlour stores and passes these through. Clean mapping.

**Complexity:** Low

#### 16. `takeTurnStreaming()`

Returns `{ chunks, result }`. The Animator already returns this shape from `animate({ streaming: true })`. The Parlour wraps the Animator's `SessionChunk` stream with an additional `turn_complete` chunk at the end.

**Complexity:** Low

---

## Implementation Status

### Phase 1 — COMPLETE

All Phase 1 items implemented and tested (37 tests, all passing):

1. ~~Package scaffolding + types~~ ✅
2. ~~Conversation document & Stacks book registration (supportKit)~~ ✅ (+ separate `turns` book)
3. ~~`create()` — conversation creation~~ ✅
4. ~~`takeTurn()` — human turns (message recording)~~ ✅
5. ~~`takeTurn()` — anima turns (consult path only)~~ ✅
6. ~~`end()`~~ ✅
7. ~~`nextParticipant()`~~ ✅
8. ~~`list()` and `show()`~~ ✅
9. ~~Support kit tools (conversation-list, conversation-show, conversation-end)~~ ✅
10. ~~`takeTurnStreaming()`~~ ✅
11. ~~Provider session continuity (`providerSessionId` round-trip)~~ ✅
12. ~~README~~ ✅

**Consult conversations work end-to-end.**

### Decisions made during implementation

- **Human turn counting:** anima turns only count toward `turnLimit`. Human turns are context delivery.
- **`cwd` storage:** stored on conversation doc at creation time via `CreateConversationRequest.cwd`. The Parlour enforces consistency by reading `cwd` from the conversation doc for every turn.
- **Turn storage:** added a separate `turns` book (not in original spec) for cleaner querying vs cross-book joins to the sessions book. Turns store the message, participant info, and sessionId reference.

### Phase 2 — Remaining (Convene Inter-Turn Context)

Structurally implemented (round-robin ordering works, convene conversations can be created and turns taken), but anima inter-turn context falls back to `[response not available]` placeholder. Needs:

12. Resolve inter-turn context gap (option 2 or 3 from gap analysis)
13. Populate real anima responses in inter-turn messages

---

## Pre-Implementation Decisions Still Needed (Phase 2 only)

1. **Inter-turn context strategy** — option 2 (Animator stores responseText) or option 3 (Parlour captures from stream)?
