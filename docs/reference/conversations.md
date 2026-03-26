# Conversations API Reference

Multi-turn interaction with animas — web consultation and convene sessions.

Conversations group multiple sessions (turns) into a single logical interaction. Each turn is a full `launchSession()` call through the standard session funnel — same manifest pipeline, same metrics, same session records. The conversation layer is thin: it groups sessions, threads claude session IDs for `--resume`, and tracks overall conversation state.

---

## Concepts

### Kinds

| Kind | Description | Participants |
|------|-------------|-------------|
| `consult` | Human talks to an anima (from dashboard or CLI) | 1 human + 1 anima |
| `convene` | Multiple animas hold a turn-limited dialogue | N animas |

### Turns and Sessions

Each turn in a conversation produces a session row in the `sessions` table. All per-turn metrics (cost, tokens, duration, transcript) live in the existing session infrastructure. The conversation tables add grouping and state on top.

**Human turns** in a consult do not produce sessions. The human's message is passed as the `prompt` to the anima's `takeTurn()` call and appears in the anima's session record as `userPrompt`. This means cost/token analytics are always agent-side — which is what you want for budget tracking. For dialogue reconstruction, `showConversation()` interleaves the anima's prompt (the human's message) with the anima's response.

### Session Threading

Conversation turns use claude's `--resume` flag to maintain conversational continuity. The first turn for each anima participant starts a fresh claude session. Subsequent turns resume it with the `providerSessionId` captured from the previous turn's result. This ID is stored on the `conversation_participants` record and passed through `launchSession()` → provider.

### Manifest at Turn Time

Animas are manifested via `manifest()` on each turn, not at conversation creation time. This means the anima's system prompt, tools, and MCP config reflect the current guild state when the turn is taken. If a tool is installed mid-conversation, the next turn picks it up.

---

## Database Schema

### New Tables

```sql
-- Conversation: one logical multi-turn interaction
CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,               -- conv_xxxx
    status      TEXT NOT NULL DEFAULT 'active', -- active | concluded | abandoned
    kind        TEXT NOT NULL,                  -- consult | convene
    topic       TEXT,                           -- seeding prompt / subject
    turn_limit  INTEGER,                        -- max total turns (null = unlimited)
    created_at  TEXT NOT NULL,
    ended_at    TEXT,
    event_id    TEXT                            -- for convene: triggering event
);

-- Participant in a conversation (human or anima)
CREATE TABLE conversation_participants (
    id                TEXT PRIMARY KEY,          -- cpart_xxxx
    conversation_id   TEXT NOT NULL REFERENCES conversations(id),
    kind              TEXT NOT NULL,             -- anima | human
    name              TEXT NOT NULL,             -- anima name or 'patron'
    anima_id          TEXT,                      -- FK to animas (null for humans)
    claude_session_id TEXT                       -- threaded via --resume
);
```

### Sessions Table Extensions

```sql
ALTER TABLE sessions ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE sessions ADD COLUMN turn_number     INTEGER;
```

- **`conversation_id`** — groups turns. Null for standalone sessions (summon, brief, terminal consult).
- **`turn_number`** — 1-indexed position within the conversation. Useful for analytics: cost-per-turn curves, cache efficiency trends.

### Analytics Queries

```sql
-- Total cost of a conversation
SELECT SUM(cost_usd) FROM sessions WHERE conversation_id = ?;

-- Per-participant cost breakdown
SELECT a.name, SUM(s.cost_usd), SUM(s.input_tokens), SUM(s.output_tokens)
FROM sessions s JOIN animas a ON a.id = s.anima_id
WHERE s.conversation_id = ?
GROUP BY a.name;

-- Cost per turn (do later turns get cheaper from caching?)
SELECT turn_number, cost_usd, cache_read_tokens
FROM sessions WHERE conversation_id = ?
ORDER BY turn_number;
```

---

## Session Infrastructure Changes

### SessionProviderLaunchOptions

Added field:

```ts
claudeSessionId?: string
```

When provided, the provider uses `--resume SESSION_ID` to continue an existing conversation instead of starting a fresh session.

### SessionProvider Interface

Added optional method:

```ts
launchStreaming?(options: SessionProviderLaunchOptions): {
  chunks: AsyncIterable<SessionChunk>;
  result: Promise<SessionProviderResult>;
}
```

Returns an async iterable of `SessionChunk` for real-time streaming AND a promise for the final result. Used by `takeTurn()` to stream responses to the dashboard. Falls back to `launch()` when not implemented.

### SessionChunk

```ts
type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string }
```

### SessionLaunchOptions

Added fields:

```ts
conversationId?: string   // written to sessions.conversation_id
turnNumber?: number       // written to sessions.turn_number
claudeSessionId?: string  // passed through to provider for --resume
onChunk?: (chunk: SessionChunk) => void  // streaming callback
```

The trigger type union is extended: `'consult' | 'summon' | 'brief' | 'convene'`.

---

## Conversation API

All functions take `home: string` (the guild root path) as their first argument.

### `createConversation(home, options): CreateConversationResult`

Create a new conversation with participant records. Does NOT take a first turn.

**Options (`CreateConversationOptions`):**
- `kind: 'consult' | 'convene'`
- `topic?: string` — seeding prompt or subject
- `turnLimit?: number` — max total turns (null = unlimited)
- `participants: Array<{ kind: 'anima' | 'human'; name: string }>` — at least one participant
- `eventId?: string` — for convene: the triggering event ID

**Returns (`CreateConversationResult`):**
- `conversationId: string` — the new conversation ID (`conv_xxxx`)
- `participants: Array<{ id: string; name: string; kind: string }>` — with generated IDs

### `takeTurn(home, conversationId, participantId, message): AsyncGenerator<ConversationChunk>`

Take a turn in a conversation. The core primitive.

For anima participants:
1. Reads conversation state (checks active, turn limit)
2. Manifests the anima via `manifest()` — standard pipeline
3. Calls `launchSession()` with `claudeSessionId` for `--resume`
4. Streams `ConversationChunk`s as they arrive from the provider
5. Updates participant's `claude_session_id` for next turn
6. Auto-concludes if turn limit reached

For human participants: no-op (returns immediately). The human's message should be passed as the `message` argument to the next anima `takeTurn()` call.

**ConversationChunk:**
```ts
type ConversationChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string }
  | { type: 'turn_complete'; turnNumber: number; costUsd?: number }
```

**Throws** if conversation is not active or turn limit reached.

### `endConversation(home, conversationId, reason?): void`

End a conversation explicitly. Sets status to `'concluded'` (default) or `'abandoned'`. Idempotent — no-op if already ended.

### `nextParticipant(home, conversationId): { participantId, name } | null`

Get the next participant in a convene rotation (round-robin by creation order). Returns `null` if conversation is not active, turn limit reached, or no anima participants.

### `formatConveneMessage(home, conversationId, participantId): string`

Format the message for the next participant in a convene. Returns only what happened since their last turn (other participants' responses), avoiding duplicate context with `--resume`. Returns the conversation topic if it's the participant's first turn.

### `listConversations(home, opts?): ConversationSummary[]`

List conversations with optional filters.

**Options (`ListConversationsOptions`):**
- `status?: string` — `'active'`, `'concluded'`, or `'abandoned'`
- `kind?: string` — `'consult'` or `'convene'`
- `limit?: number`

**Returns (`ConversationSummary`):**
- `id, status, kind, topic, turnLimit, createdAt, endedAt`
- `participants: Array<{ id, name, kind }>`
- `turnCount: number` — computed from sessions table
- `totalCostUsd: number` — computed from sessions table

### `showConversation(home, conversationId): ConversationDetail | null`

Full conversation detail including all turns.

**Returns (`ConversationDetail`):** extends `ConversationSummary` with:
- `turns: Array<{ sessionId, turnNumber, participant, prompt, exitCode, costUsd, durationMs, startedAt, endedAt }>`

The `prompt` field on each turn is the input message (in a consult, this is the human's message). Together with the session's transcript, this reconstructs the full dialogue.

---

## Integration Patterns

### Dashboard — Web Consultation

```ts
// Start a consultation
const { conversationId, participants } = createConversation(home, {
  kind: 'consult',
  participants: [
    { kind: 'human', name: 'patron' },
    { kind: 'anima', name: 'steward' },
  ],
});

const animaPart = participants.find(p => p.name === 'steward')!;

// On each message from browser:
for await (const chunk of takeTurn(home, conversationId, animaPart.id, userMessage)) {
  ws.send(JSON.stringify(chunk));
}

// On disconnect:
endConversation(home, conversationId, 'abandoned');

// On reconnect with stored conversationId:
const state = showConversation(home, conversationId);
// Restore UI from state.turns
```

### Clockworks — Convene

```ts
const { conversationId } = createConversation(home, {
  kind: 'convene',
  topic: hydratedPrompt,
  turnLimit: 10,
  participants: standingOrder.participants.map(name => ({ kind: 'anima', name })),
  eventId,
});

while (true) {
  const next = nextParticipant(home, conversationId);
  if (!next) break;

  const message = formatConveneMessage(home, conversationId, next.participantId);
  for await (const chunk of takeTurn(home, conversationId, next.participantId, message)) {
    // stream to dashboard, log, etc.
  }
}
```

---

## Types Summary

| Type | Description |
|------|-------------|
| `ConversationChunk` | Union: text, tool_use, tool_result, turn_complete |
| `SessionChunk` | Union: text, tool_use, tool_result (without turn_complete) |
| `CreateConversationOptions` | Options for `createConversation()` |
| `CreateConversationResult` | `{ conversationId, participants[] }` |
| `ConversationSummary` | List view with computed turnCount and totalCostUsd |
| `ConversationDetail` | Full view with turns array |
| `ListConversationsOptions` | Filters for `listConversations()` |

## ID Prefixes

| Prefix | Entity |
|--------|--------|
| `conv-` | conversation |
| `cpart-` | conversation participant |
