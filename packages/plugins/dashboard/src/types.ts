/**
 * Local type stubs for apparatus documents read via Stacks readBook().
 * These mirror the shapes declared by the respective apparatus packages
 * without importing from them (to keep dashboard dependencies minimal).
 */

/** Minimal shape of a session document from the Animator's sessions book. */
export interface SessionDoc {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  provider: string;
  exitCode?: number;
  error?: string;
  conversationId?: string;
  providerSessionId?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  costUsd?: number;
  metadata?: Record<string, unknown>;
  output?: string;
  [key: string]: unknown;
}
