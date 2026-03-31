/**
 * nexus-sessions — Sessions rig for Nexus Mk 2.1
 *
 * Default export: the Rig descriptor (books + tools). Arbor reads this
 * at startup to create the Books tables and register the tools.
 *
 * Named exports: the TypeScript API surface for framework-internal callers
 * (engines, CLI commands, MCP server startup). These functions accept
 * `home: string` so they can be called without a RigContext.
 */

import type { Rig, ToolDefinition } from '@shardworks/nexus-core';
import { books } from './books.js';

import sessionList from './tools/session-list.js';
import sessionShow from './tools/session-show.js';
import conversationList from './tools/conversation-list.js';
import conversationShow from './tools/conversation-show.js';
import conversationEnd from './tools/conversation-end.js';

// ── Rig default export ─────────────────────────────────────────────────────

export default {
  tools: [
    sessionList,
    sessionShow,
    conversationList,
    conversationShow,
    conversationEnd,
  ] as unknown as ToolDefinition[],
  books,
} satisfies Rig;

// ── Session TypeScript API (re-exports for framework-internal callers) ─────

export {
  // Provider registry — called at startup
  registerSessionProvider,
  getSessionProvider,
  // Session funnel — THE core launch path
  launchSession,
  // Workspace helpers — used by summon engine
  resolveWorkspace,
  createTempWorktree,
  removeTempWorktree,
  // Circuit breaker — used by summon engine
  countSessionsForWrit,
  // Dashboard read functions — used by tools and convene tool
  listSessions,
  showSession,
} from './lib/session-api.js';

export type {
  // Provider types live in core (re-exported here for convenience)
  SessionProvider,
  SessionProviderLaunchOptions,
  SessionProviderResult,
  // nexus-sessions–owned types
  SessionLaunchOptions,
  SessionResult,
  SessionRecord,
  SessionSummary,
  SessionDetail,
  ListSessionsOptions,
  SessionChunk,
  ResolvedWorkspace,
  WorkspaceContext,
} from './lib/session-api.js';

// ── Conversation TypeScript API (re-exports for framework-internal callers) ─

export {
  // Lifecycle — used by convene tool and CLI
  createConversation,
  takeTurn,
  endConversation,
  nextParticipant,
  formatConveneMessage,
  // Dashboard reads — used by convene tool, CLI, and conversation tools
  listConversations,
  showConversation,
} from './lib/conversation-api.js';

export type {
  ConversationChunk,
  CreateConversationOptions,
  CreateConversationResult,
  ConversationSummary,
  ConversationDetail,
  ListConversationsOptions,
} from './lib/conversation-api.js';

// ── Document types (for callers that need to inspect raw docs) ─────────────

export type { SessionDoc, ConversationDoc, ParticipantDoc } from './types.js';
