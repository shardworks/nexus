/**
 * Session provider registry — a slim singleton that holds the registered
 * SessionProvider implementation.
 *
 * Lives in core so apparatus packages can import it without creating
 * circular dependencies.
 */

// ── Manifest types (inlined from former legacy/1/manifest.ts) ─────────

/** The result of manifesting an anima — everything needed to launch a session. */
export interface ManifestResult {
  /** The anima record from the Register. */
  anima: { id: string; name: string; status: string; roles: string[] };
  /** The composed system prompt for the anima. */
  systemPrompt: string;
  /** The individual ingredients that produced the system prompt. */
  composition: {
    codex: string;
    roleInstructions: string;
    curriculum: { name: string; version: string; content: string } | null;
    temperament: { name: string; version: string; content: string } | null;
    toolInstructions: Array<{ toolName: string; instructions: string }>;
  };
  /** Resolved tools the anima has access to. */
  tools: Array<{ name: string; description: string; package: string; export: string }>;
  /** Tools that matched the anima's roles but failed precondition checks. */
  unavailable: Array<{ name: string; reason: string }>;
  /** Warnings generated during manifest (e.g. undefined roles). */
  warnings: string[];
}

// ── Provider types ─────────────────────────────────────────────────────

/** A chunk emitted during streaming session output. */
export type SessionChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'tool_result'; tool: string };

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
   * for the final result. Used by conversation turns to stream responses
   * to the dashboard while still capturing the full result for the funnel.
   *
   * Optional — providers that don't support streaming just omit this.
   * The conversation system falls back to launch() (no streaming, just
   * the final result).
   */
  launchStreaming?(options: SessionProviderLaunchOptions): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  };
}

/** Options passed to the provider's launch() — provider-specific subset. */
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

/** What comes back from the provider (before the funnel adds its own fields). */
export interface SessionProviderResult {
  exitCode: number;
  /** Provider-reported token usage, if available. */
  tokenUsage?: {
    inputTokens:       number;
    outputTokens:      number;
    cacheReadTokens?:  number;
    cacheWriteTokens?: number;
  };
  /** Provider-reported cost in USD, if available. */
  costUsd?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Session ID from the provider, if available (e.g. claude session ID). */
  providerSessionId?: string;
  /**
   * Full conversation transcript — raw provider output, minimally typed.
   * Stored as-is in the session record; typed normalization deferred.
   */
  transcript?: Record<string, unknown>[];
}

// ── Registry ───────────────────────────────────────────────────────────

let _provider: SessionProvider | null = null;

/**
 * Register a session provider. Called once at startup (by the MCP server or
 * clock daemon) before any sessions are launched.
 */
export function registerSessionProvider(provider: SessionProvider): void {
  _provider = provider;
}

/**
 * Get the registered session provider. Returns null if no provider has been
 * registered yet.
 */
export function getSessionProvider(): SessionProvider | null {
  return _provider;
}
