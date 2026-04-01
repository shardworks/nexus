# The Parlour — API Contract

Status: **Draft — MVP**

Package: `@shardworks/parlour` · Plugin id: `parlour`

> **⚠️ MVP scope.** This spec covers the core conversation lifecycle: creating conversations, registering participants, taking turns (with streaming), enforcing turn limits, and ending conversations. Inter-turn context assembly (`formatConveneMessage`) is included for convene conversations. There is no event signalling, no conversation-level cost budgets, and no pluggable turn-order strategies. See the Future sections for the target design.

---

## Purpose

The Parlour manages multi-turn conversations within the guild. It provides the structure for two kinds of interaction: **consult** (a human talks to an anima) and **convene** (multiple animas hold a structured dialogue). The Parlour tracks who is participating, whose turn it is, what has been said, and when the conversation ends.

The Parlour does not launch sessions itself — it delegates each turn to **The Animator**. The Parlour does not assemble prompts — it delegates that to **The Loom**. The Parlour orchestrates: it decides *when* and *for whom* to call the Animator, and assembles the inter-turn context that keeps each participant coherent across turns.

---

## Dependencies

```
requires: ['stacks', 'animator', 'loom']
```

- **The Stacks** — persists conversations (with nested participants) and turn records.
- **The Animator** — launches individual session turns (via `animate()` / `animateStreaming()`).
- **The Loom** — weaves the session context for each participant's turn.

---

## Support Kit

The Parlour contributes a `conversations` book and conversation management tools via its supportKit:

```typescript
supportKit: {
  books: {
    conversations: {
      indexes: ['status', 'kind', 'createdAt'],
    },
  },
  tools: [conversationList, conversationShow, conversationEnd],
},
```

### Document Shape

Participants are nested directly in the conversation document rather than stored in a separate book. This avoids N+1 queries on `list()` and `show()` operations — since Books has no join support, a separate participants book would require a per-conversation query to resolve participants. Conversations have a small, bounded number of participants (typically 2–5), so the nested document stays compact.

```typescript
interface ConversationDoc {
  id: string
  status: 'active' | 'concluded' | 'abandoned'
  kind: 'consult' | 'convene'
  topic: string | null
  turnLimit: number | null
  createdAt: string
  endedAt: string | null
  eventId: string | null
  participants: ParticipantRecord[]
}

interface ParticipantRecord {
  /** Stable participant id (generated at creation). */
  id: string
  kind: 'anima' | 'human'
  name: string
  /** Anima id, resolved at creation time. Null for human participants. */
  animaId: string | null
  /**
   * Provider session id for --resume. Updated after each turn so
   * the next turn can continue the provider's conversation context.
   */
  providerSessionId: string | null
}
```

The trade-off: updating a participant's `providerSessionId` after each turn requires a read-modify-write of the full conversation document. This is acceptable — the document is small and the write happens once per turn, not in a hot loop.

The one query this makes harder is "find all conversations involving anima X" — this requires a JSON path query on `participants[*].animaId` rather than a direct index lookup. This is a dashboard/analytics query, not an operational hot path, and The Stacks' JSON path queries handle it adequately.

### `conversation-list` tool

List conversations with optional filters. Returns conversation summaries ordered by `createdAt` descending (newest first).

| Parameter | Type | Description |
|---|---|---|
| `status` | `'active' \| 'concluded' \| 'abandoned'` | Filter by lifecycle status |
| `kind` | `'consult' \| 'convene'` | Filter by conversation kind |
| `limit` | `number` | Maximum results (default: 20) |

Returns: `ConversationSummary[]` — id, status, kind, topic, participants, turnCount, totalCostUsd.

### `conversation-show` tool

Show full detail for a conversation including all turns.

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id |

Returns: `ConversationDetail` — full conversation record with participant list, per-turn session references, prompts, costs, and durations.

### `conversation-end` tool

End an active conversation.

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Conversation id |
| `reason` | `'concluded' \| 'abandoned'` | Why the conversation ended (default: `'concluded'`) |

Idempotent — no error if the conversation is already ended.

---

## `ParlourApi` Interface (`provides`)

```typescript
interface ParlourApi {
  /**
   * Create a new conversation.
   *
   * Sets up conversation and participant records. Does NOT take a first
   * turn — that's a separate call to takeTurn().
   */
  create(request: CreateConversationRequest): Promise<CreateConversationResult>

  /**
   * Take a turn in a conversation.
   *
   * For anima participants: weaves context via The Loom, assembles the
   * inter-turn message, and calls The Animator to run a session. Returns
   * the session result. For human participants: records the message as
   * context for the next turn (no session launched).
   *
   * Throws if the conversation is not active or the turn limit is reached.
   */
  takeTurn(request: TakeTurnRequest): Promise<TurnResult>

  /**
   * Take a turn with streaming output.
   *
   * Same as takeTurn(), but yields ConversationChunks as the session
   * produces output. Includes a turn_complete chunk at the end.
   */
  takeTurnStreaming(request: TakeTurnRequest): {
    chunks: AsyncIterable<ConversationChunk>
    result: Promise<TurnResult>
  }

  /**
   * Get the next participant in a conversation.
   *
   * For convene: returns the next anima in round-robin order.
   * For consult: returns the anima participant (human turns are implicit).
   * Returns null if the conversation is not active or the turn limit is reached.
   */
  nextParticipant(conversationId: string): Promise<Participant | null>

  /**
   * End a conversation.
   *
   * Sets status to 'concluded' (normal end) or 'abandoned' (e.g. timeout,
   * disconnect). Idempotent — no error if already ended.
   */
  end(conversationId: string, reason?: 'concluded' | 'abandoned'): Promise<void>

  /**
   * List conversations with optional filters.
   */
  list(options?: ListConversationsOptions): Promise<ConversationSummary[]>

  /**
   * Show full detail for a conversation.
   */
  show(conversationId: string): Promise<ConversationDetail | null>
}
```

### Supporting Types

```typescript
interface CreateConversationRequest {
  /** Conversation kind. */
  kind: 'consult' | 'convene'
  /** Seed topic or prompt. Used as the initial message for the first turn. */
  topic?: string
  /** Maximum allowed turns. Null = unlimited. */
  turnLimit?: number
  /** Participants in the conversation. */
  participants: ParticipantDeclaration[]
  /** Triggering event id, for conversations started by clockworks. */
  eventId?: string
}

interface ParticipantDeclaration {
  kind: 'anima' | 'human'
  /** Display name. For anima participants, this is the anima name
   *  used to resolve identity via The Loom at turn time. */
  name: string
}

interface CreateConversationResult {
  conversationId: string
  participants: Participant[]
}

interface Participant {
  id: string
  name: string
  kind: 'anima' | 'human'
}

interface TakeTurnRequest {
  conversationId: string
  participantId: string
  /** The message for this turn. For consult: the human's message.
   *  For convene: typically assembled by the caller via formatMessage(),
   *  or omitted to let The Parlour assemble it automatically. */
  message?: string
}

interface TurnResult {
  /** The Animator's session result for this turn. Null for human turns. */
  sessionResult: SessionResult | null
  /** Turn number within the conversation (1-indexed). */
  turnNumber: number
  /** Whether the conversation is still active after this turn. */
  conversationActive: boolean
}

/** A chunk of output from a conversation turn. */
type ConversationChunk =
  | SessionChunk
  | { type: 'turn_complete'; turnNumber: number; costUsd?: number }

interface ConversationSummary {
  id: string
  status: 'active' | 'concluded' | 'abandoned'
  kind: 'consult' | 'convene'
  topic: string | null
  turnLimit: number | null
  createdAt: string
  endedAt: string | null
  participants: Participant[]
  /** Computed from session records. */
  turnCount: number
  /** Aggregate cost across all turns. */
  totalCostUsd: number
}

interface ConversationDetail extends ConversationSummary {
  turns: TurnSummary[]
}

interface TurnSummary {
  sessionId: string
  turnNumber: number
  participant: string
  prompt: string | null
  exitCode: number | null
  costUsd: number | null
  durationMs: number | null
  startedAt: string
  endedAt: string | null
}

interface ListConversationsOptions {
  status?: 'active' | 'concluded' | 'abandoned'
  kind?: 'consult' | 'convene'
  limit?: number
}
```

---

## Conversation Lifecycle

### Create

```
create(request)
  │
  ├─ 1. Generate conversation id
  ├─ 2. For each participant declaration:
  │     ├─ Generate participant id
  │     └─ Resolve animaId (for anima participants)
  ├─ 3. Write conversation document to The Stacks
  │     (status: 'active', participants nested inline)
  └─ 4. Return conversationId + participants
```

No session is launched at creation time. The first turn is a separate call.

### Take Turn (anima participant)

```
takeTurn(request)
  │
  ├─ 1. Read conversation state from The Stacks
  │     ├─ Verify status is 'active'
  │     └─ Verify turn limit not reached
  │
  ├─ 2. Determine turn number (count existing turns + 1)
  │
  ├─ 3. Assemble inter-turn message:
  │     ├─ First turn for this participant → use conversation topic
  │     └─ Subsequent turns → assemble messages from other participants
  │       since this participant's last turn (see § Inter-Turn Context)
  │
  ├─ 4. Weave context via The Loom (participant's anima name)
  │
  ├─ 5. Call The Animator:
  │     ├─ animate() or animateStreaming()
  │     ├─ conversationId for --resume
  │     └─ metadata: { trigger, conversationId, turnNumber, participantId }
  │
  ├─ 6. Update participant's providerSessionId in conversation doc
  │     (read-modify-write; enables --resume on next turn)
  │
  ├─ 7. If turn limit reached → auto-conclude conversation
  │
  └─ 8. Return TurnResult
```

### Take Turn (human participant)

Human turns do not launch sessions. The human's message is passed as context to the next anima turn via the inter-turn context assembly. The Parlour records that a human turn occurred (for turn counting and turn limit enforcement) but no Animator call is made.

### End

```
end(conversationId, reason)
  │
  ├─ 1. Read conversation from The Stacks
  ├─ 2. If already ended → no-op (idempotent)
  └─ 3. Update status to reason, set endedAt
```

---

## Inter-Turn Context

For convene conversations, each anima participant maintains their own session context via `--resume` (the provider's `conversationId`). Their session already contains their own prior messages and responses. When it's their turn again, The Parlour assembles only what happened *since their last turn* — the contributions of other participants.

```
Participant A's turn 3:
  - Read all turns since A's last turn (turn 1)
  - For each intervening turn (B's turn 2):
    - Read the session record artifact (if available)
    - Extract the assistant's text response from the transcript
  - Format as: "[B]: {response text}"
  - Pass as the message to A's session
```

On a participant's first turn, the conversation topic is used as the initial message.

For consult conversations, the pattern is simpler: the human's message is passed directly as the prompt to the anima's next turn.

**Dependency note:** Extracting responses from session transcripts requires access to session record artifacts (the JSON files written by The Animator). At MVP, this depends on The Animator writing artifacts to disk — see [Animator: Future: Session Record Artifacts](animator.md#future-session-record-artifacts). If artifacts are not available, the inter-turn message falls back to a placeholder (`[participant]: [response not available]`).

---

## Provider Session Continuity

Each anima participant in a conversation maintains session continuity across turns via the provider's `--resume` mechanism. The Parlour:

1. Passes `conversationId` to The Animator on each turn
2. Captures `providerSessionId` from the Animator's `SessionResult`
3. Stores it in the participant's `providerSessionId` field (in the conversation document)
4. Passes it back to The Animator on the participant's next turn

This allows the underlying AI process to maintain its full context window across turns without re-sending the entire conversation history.

### Workspace Persistence Constraint

The `--resume` mechanism depends on provider-specific session data stored on the local filesystem (e.g. Claude Code's `.claude/` directory). This creates a hard constraint: **all turns in a conversation must run in the same working directory**, or the session data needed for `--resume` will not be present.

This means:
- **Fresh temp worktrees per turn will not work.** The session data from turn 1 would be gone by turn 2.
- **A persistent workspace is required** — either the guildhall itself or a long-lived worktree that survives across turns.
- If a persistent workspace is not available, the fallback is to abandon `--resume` and re-send the full conversation context each turn. This works but costs more tokens and loses the provider's internal state (tool use history, reasoning context, etc.).

The Parlour must pass the same `cwd` to The Animator for every turn in a given conversation. The caller that creates the conversation is responsible for providing a workspace that will persist for the conversation's lifetime.

---

## Open Questions

- **Turn counting for human turns.** Do human turns count toward the turn limit? The legacy system counts only anima turns (sessions). For convene conversations this is clear (all turns are anima turns). For consult, should a turn limit of 10 mean 10 anima responses or 10 total exchanges (5 human + 5 anima)?
- **Conversation-level workspace.** Provider session continuity requires a persistent workspace across turns (see § Workspace Persistence Constraint). Should the `cwd` be set once at conversation creation and stored in the conversation document? Or is it the caller's responsibility to pass a consistent `cwd` on each `takeTurn()` call? Storing it on the conversation is safer (can't accidentally use different directories) but means the Parlour owns workspace lifecycle awareness.
- **Participant ordering.** The legacy uses insertion order for round-robin. Should The Parlour support explicit ordering or custom turn-order strategies?

---

## Future: Event Signalling

When Clockworks integration is available, The Parlour will signal conversation lifecycle events:

- **`conversation.started`** — fired after create(). Payload includes `conversationId`, `kind`, `topic`, participant names.
- **`conversation.turn-taken`** — fired after each turn. Payload includes `conversationId`, `turnNumber`, `participantName`, `sessionId`, `costUsd`.
- **`conversation.ended`** — fired after end() or auto-conclude. Payload includes `conversationId`, `reason`, `turnCount`, `totalCostUsd`.

These events enable clockworks standing orders to react to conversation activity (e.g. auto-summarize on conclusion, alert on high cost).

Blocked on: Clockworks apparatus spec finalization, Animator event signalling.

---

## Future: Conversation Cost Budgets

A `maxBudgetUsd` field on `CreateConversationRequest` that caps aggregate cost across all turns. The Parlour checks cumulative cost before each turn and auto-concludes if the budget would be exceeded.

---

## Future: Pluggable Turn-Order Strategies

The MVP uses round-robin for convene and simple alternation for consult. Future strategies might include:

- **Priority-based** — participants with higher priority speak more frequently
- **Facilitator-directed** — a designated facilitator anima decides who speaks next
- **Reactive** — participants speak when they have something to say (event-driven rather than scheduled)

This would require a `TurnOrderStrategy` interface and a configuration field on `CreateConversationRequest`.

---

## Implementation Notes

- **Cross-book queries.** The Parlour reads from both its own `conversations` book and The Animator's `sessions` book (for turn counts, cost aggregation, transcript extraction). This cross-apparatus read is via The Stacks' query API — no direct DB access.
- **Single-document access pattern.** With participants nested in the conversation document, most operations are single-document reads or read-modify-writes. The `takeTurn()` hot path reads one conversation doc, calls The Animator, then writes back the updated `providerSessionId`. No multi-book coordination needed.
- **No in-memory state.** All conversation state is persisted in The Stacks. The Parlour reads state fresh on each `takeTurn()` call. This makes it safe for concurrent callers and process restarts between turns.
- **Legacy migration.** The legacy `nexus-sessions` package combines session and conversation management in a single rig with separate `conversations` and `participants` books. The new architecture splits sessions (Animator) from conversations (Parlour) and nests participants inline. The Parlour's `conversations` book supersedes both legacy books.
