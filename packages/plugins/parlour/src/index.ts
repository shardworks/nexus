/**
 * @shardworks/parlour-apparatus — The Parlour.
 *
 * Multi-turn conversation management: creates conversations, registers
 * participants, orchestrates turns (with streaming), enforces turn limits,
 * and ends conversations. Delegates session launch to The Animator and
 * context composition to The Loom.
 *
 * See: docs/architecture/apparatus/parlour.md
 */

import { createParlour } from './parlour.ts';

// ── Parlour API ─────────────────────────────────────────────────────

export {
  type ParlourApi,
  type ConversationDoc,
  type TurnDoc,
  type ParticipantRecord,
  type Participant,
  type CreateConversationRequest,
  type CreateConversationResult,
  type ParticipantDeclaration,
  type TakeTurnRequest,
  type TurnResult,
  type ConversationChunk,
  type ConversationSummary,
  type ConversationDetail,
  type TurnSummary,
  type ListConversationsOptions,
} from './types.ts';

export { createParlour } from './parlour.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createParlour();
