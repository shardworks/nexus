/**
 * Session API — STUB.
 *
 * The real session API moved to @shardworks/nexus-sessions.
 * This stub exists solely so the legacy/1 barrel compiles.
 * All functions throw at runtime; all types are minimal placeholders.
 */

// Re-export the provider types that still live in core
export {
  type SessionChunk,
  type SessionProvider,
  type SessionProviderLaunchOptions,
  type SessionProviderResult,
  registerSessionProvider,
  getSessionProvider,
} from '../../session-provider.ts';

// ── Placeholder types for APIs that moved to nexus-sessions ──────────

export type SessionLaunchOptions = Record<string, unknown>;
export type SessionResult = Record<string, unknown>;
export type WorkspaceContext = Record<string, unknown>;
export interface ResolvedWorkspace { kind: string; path: string; branch?: string }
export type SessionRecord = Record<string, unknown>;
export type SessionSummary = Record<string, unknown>;
export type SessionDetail = Record<string, unknown>;
export type ListSessionsOptions = Record<string, unknown>;

// ── Stub functions ───────────────────────────────────────────────────

const MOVED = 'Moved to @shardworks/nexus-sessions. This legacy stub should not be called.';

export function resolveWorkspace(..._a: any[]): never { throw new Error(MOVED); }
export function createTempWorktree(..._a: any[]): never { throw new Error(MOVED); }
export function removeTempWorktree(..._a: any[]): never { throw new Error(MOVED); }
export function launchSession(..._a: any[]): never { throw new Error(MOVED); }
export function listSessions(..._a: any[]): never { throw new Error(MOVED); }
export function countSessionsForWrit(..._a: any[]): never { throw new Error(MOVED); }
export function showSession(..._a: any[]): never { throw new Error(MOVED); }
