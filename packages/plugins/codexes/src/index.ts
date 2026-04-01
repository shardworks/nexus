/**
 * @shardworks/codexes-apparatus — The Scriptorium.
 *
 * Guild codex management: bare clone registry, draft binding lifecycle
 * (git worktrees), sealing (ff-only merge or rebase+ff), and push.
 * Default export is the apparatus plugin.
 *
 * See: docs/architecture/apparatus/scriptorium.md
 */

import { createScriptorium } from './scriptorium.ts';

// ── Public types ──────────────────────────────────────────────────────

export type {
  // API
  ScriptoriumApi,

  // Codex records
  CodexRecord,
  CodexDetail,

  // Draft records
  DraftRecord,

  // Requests
  OpenDraftRequest,
  AbandonDraftRequest,
  SealRequest,
  PushRequest,

  // Results
  SealResult,

  // Configuration
  CodexesConfig,
  CodexesSettings,
  CodexConfigEntry,
} from './types.ts';

// ── Apparatus factory ─────────────────────────────────────────────────

export { createScriptorium } from './scriptorium.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createScriptorium();
