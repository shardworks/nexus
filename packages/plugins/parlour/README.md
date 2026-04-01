# `@shardworks/parlour-apparatus`

The Parlour manages multi-turn conversations within the guild. It provides the structure for two kinds of interaction: **consult** (a human talks to an anima) and **convene** (multiple animas hold a structured dialogue). The Parlour orchestrates turns — deciding *when* and *for whom* to call The Animator — while delegating session launch to The Animator and context composition to The Loom.

The Parlour sits downstream of both The Animator and The Loom in the dependency graph: `stacks <- animator <- parlour` and `loom <- parlour`.

---

## Installation

Add to your package's dependencies:

```json
{
  "@shardworks/parlour-apparatus": "workspace:*"
}
```

The Parlour requires The Stacks, The Animator, and The Loom to be installed in the guild.

---

## API

The Parlour exposes a `ParlourApi` via its `provides` interface, retrieved at runtime:

```typescript
import type { ParlourApi } from '@shardworks/parlour-apparatus';

const parlour = guild().apparatus<ParlourApi>('parlour');
```

### `create(request): Promise<CreateConversationResult>`

Create a new conversation. Sets up the conversation and participant records but does NOT take a first turn.

```typescript
const { conversationId, participants } = await parlour.create({
  kind: 'consult',
  topic: 'Help me refactor the session layer',
  turnLimit: 10,
  cwd: '/workspace/shardworks',
  participants: [
    { kind: 'human', name: 'Sean' },
    { kind: 'anima', name: 'Artificer' },
  ],
});
```

| Parameter | Type | Description |
|---|---|---|
| `kind` | `'consult' \| 'convene'` | Conversation kind |
| `topic` | `string` | Seed topic / initial prompt (optional) |
| `turnLimit` | `number` | Max anima turns before auto-conclude (optional) |
| `cwd` | `string` | Working directory — persists for the conversation's lifetime |
| `participants` | `ParticipantDeclaration[]` | Who is in the conversation |
| `eventId` | `string` | Triggering event id (optional, for clockworks) |

### `takeTurn(request): Promise<TurnResult>`

Take a turn in a conversation. For anima participants, weaves context and calls The Animator. For human participants, records the message as context for the next anima turn.

```typescript
// Human turn — records message, no session launched
await parlour.takeTurn({
  conversationId,
  participantId: humanId,
  message: 'What about the error handling?',
});

// Anima turn — launches a session via The Animator
const result = await parlour.takeTurn({
  conversationId,
  participantId: animaId,
  message: 'What about the error handling?', // or omit to use topic
});
// result.sessionResult contains the Animator's SessionResult
// result.turnNumber is the 1-indexed turn count
// result.conversationActive indicates if the conversation is still open
```

### `takeTurnStreaming(request): { chunks, result }`

Same as `takeTurn()`, but streams output chunks as the session produces them. Returns synchronously with `{ chunks, result }` — same pattern as The Animator.

```typescript
const { chunks, result } = parlour.takeTurnStreaming({
  conversationId,
  participantId: animaId,
});

for await (const chunk of chunks) {
  if (chunk.type === 'text') process.stdout.write(chunk.text);
  if (chunk.type === 'turn_complete') console.log(`\nTurn ${chunk.turnNumber} done`);
}

const turnResult = await result;
```

Chunk types include all `SessionChunk` types from The Animator, plus:
- `{ type: 'turn_complete', turnNumber, costUsd? }` — emitted after the session completes

### `nextParticipant(conversationId): Promise<Participant | null>`

Get the next participant in line. For consult: always returns the anima. For convene: round-robin by insertion order. Returns `null` if the conversation is ended or the turn limit is reached.

### `end(conversationId, reason?): Promise<void>`

End a conversation. Reason defaults to `'concluded'`. Idempotent — safe to call on already-ended conversations.

### `list(options?): Promise<ConversationSummary[]>`

List conversations with optional filters by `status`, `kind`, and `limit`. Returns summaries ordered by `createdAt` descending.

### `show(conversationId): Promise<ConversationDetail | null>`

Show full detail for a conversation including all turns, participant list, and aggregate cost.

---

## Configuration

No guild-level configuration is required. The Parlour reads its dependencies from the guild's apparatus registry at startup.

---

## Support Kit

The Parlour contributes two books and three tools to the guild:

### Books

| Book | Indexes | Contents |
|---|---|---|
| `conversations` | `status`, `kind`, `createdAt` | Conversation documents with nested participant records |
| `turns` | `conversationId`, `turnNumber`, `participantId`, `participantKind` | Per-turn records linking conversations to Animator sessions |

### Tools

| Tool | Permission | Description |
|---|---|---|
| `conversation-list` | `read` | List conversations with optional status/kind filters |
| `conversation-show` | `read` | Show full conversation detail including all turns |
| `conversation-end` | `write` | End an active conversation (concluded or abandoned) |

---

## Key Types

```typescript
interface CreateConversationRequest {
  kind: 'consult' | 'convene';
  topic?: string;
  turnLimit?: number;
  participants: ParticipantDeclaration[];
  cwd: string;
  eventId?: string;
}

interface ParticipantDeclaration {
  kind: 'anima' | 'human';
  name: string;
}

interface TurnResult {
  sessionResult: SessionResult | null;  // null for human turns
  turnNumber: number;
  conversationActive: boolean;
}

interface ConversationSummary {
  id: string;
  status: 'active' | 'concluded' | 'abandoned';
  kind: 'consult' | 'convene';
  topic: string | null;
  participants: Participant[];
  turnCount: number;
  totalCostUsd: number;
  // ... timestamps, turnLimit
}
```

See `src/types.ts` for the complete type definitions.

---

## Exports

The package exports all public types and the `createParlour()` factory:

```typescript
import parlourPlugin, { createParlour, type ParlourApi } from '@shardworks/parlour-apparatus';
```

The default export is a pre-built plugin instance, ready for guild installation.
