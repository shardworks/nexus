/**
 * Session provider registry — a lightweight singleton for the provider
 * registered at guild startup.
 *
 * Lives in core (rather than nexus-sessions) because `clock-daemon.ts` —
 * also in core — imports `registerSessionProvider` at startup. If the
 * registry lived in nexus-sessions, core would need a runtime dependency
 * on nexus-sessions, creating a circular dependency.
 *
 * nexus-sessions imports these from @shardworks/nexus-core and re-exports
 * them, so external callers can use either import path.
 */

import type { ManifestResult } from './legacy/1/manifest.ts';

// ── Provider types ─────────────────────────────────────────────────────────

/** A chunk emitted during streaming session output. */
export type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };

/** Options passed to the provider's launch() method. */
export interface SessionProviderLaunchOptions {
  /** Guild root path. */
  home: string;
  /** The manifest result — system prompt + resolved tools. */
  manifest: ManifestResult;
  /** The user-facing prompt (writ spec, consultation topic, brief). */
  prompt: string | null;
  /** Whether the session is interactive (human at keyboard) or autonomous. */
  interactive: boolean;
  /** Resolved working directory for the session. */
  cwd: string;
  /** Display name for tracking. */
  name?: string;
  /** Budget cap, if any. */
  maxBudgetUsd?: number;
  /**
   * Claude session ID to resume. When provided, the provider uses --resume
   * to continue an existing conversation instead of starting fresh.
   */
  claudeSessionId?: string;
}

/** What comes back from the provider after a session completes. */
export interface SessionProviderResult {
  exitCode: number;
  /** Provider-reported token usage, if available. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Provider-reported cost in USD, if available. */
  costUsd?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Session ID from the provider (e.g. claude session ID for --resume). */
  providerSessionId?: string;
  /**
   * Full conversation transcript — raw provider output, minimally typed.
   * Stored as-is in the session record.
   */
  transcript?: Record<string, unknown>[];
}

/** What a session provider must implement. */
export interface SessionProvider {
  /** Provider identifier (e.g. "claude-code", "claude-api", "bedrock"). */
  name: string;
  /** Launch a session and return when it completes. */
  launch(options: SessionProviderLaunchOptions): Promise<SessionProviderResult>;
  /**
   * Launch a session with streaming output.
   *
   * Returns an async iterable of chunks for real-time output AND a promise
   * for the final result.
   *
   * Optional — providers that don't support streaming omit this; the session
   * funnel falls back to launch() (no streaming).
   */
  launchStreaming?(options: SessionProviderLaunchOptions): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}

// ── Provider registry singleton ────────────────────────────────────────────

let _provider: SessionProvider | null = null;

/**
 * Register a session provider. Called once at startup by the MCP server or
 * clock daemon before any sessions are launched.
 */
export function registerSessionProvider(provider: SessionProvider): void {
  _provider = provider;
}

/**
 * Get the registered session provider. Returns null if none registered yet.
 *
 * Used by nexus-sessions' launchSession() to obtain the provider without
 * maintaining its own registry (which would break the singleton guarantee).
 */
export function getSessionProvider(): SessionProvider | null {
  return _provider;
}
