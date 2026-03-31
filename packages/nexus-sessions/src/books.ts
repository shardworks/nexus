/**
 * Book schema declarations for the nexus-sessions rig.
 *
 * Arbor reads these at startup and creates the backing SQLite tables
 * and indexes if they don't exist. Additive only — no destructive migrations.
 *
 * Table names (derived by arbor from rig ID + book name):
 *   sessions      → books_nexus_sessions_sessions
 *   conversations → books_nexus_sessions_conversations
 *   participants  → books_nexus_sessions_participants
 */

import type { BookOptions } from '@shardworks/nexus-core';

export const books: Record<string, BookOptions> = {
  /**
   * The session ledger. Each document is a SessionDoc.
   *
   * Query patterns:
   *   - by anima: where { animaId }
   *   - by writ: where { writId }
   *   - by conversation: where { conversationId }
   *   - by workshop: where { workshop }
   *   - by trigger: where { trigger }
   *   - active sessions: where endedAt is null (application-filtered post-query)
   *   - order by startedAt desc
   */
  sessions: {
    indexes: ['animaId', 'writId', 'conversationId', 'workshop', 'trigger', 'startedAt'],
  },

  /**
   * Conversation records. Each document is a ConversationDoc.
   *
   * Query patterns:
   *   - by status: where { status }
   *   - by kind: where { kind }
   *   - order by createdAt desc
   */
  conversations: {
    indexes: ['status', 'kind', 'createdAt'],
  },

  /**
   * Conversation participants. Each document is a ParticipantDoc.
   *
   * Query patterns:
   *   - all participants for a conversation: where { conversationId }
   *   - find participant by animaId within a conversation: where { conversationId, animaId }
   */
  participants: {
    indexes: ['conversationId', 'animaId'],
  },
};
