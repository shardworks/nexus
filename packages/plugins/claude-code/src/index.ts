/**
 * Claude Code Session Provider
 *
 * Apparatus plugin that implements AnimatorSessionProvider for the
 * Claude Code CLI. The Animator discovers this via guild config:
 *
 *   guild.json["animator"]["sessionProvider"] = "claude-code"
 *
 * All sessions launch in detached mode: a babysitter process is spawned
 * that survives guild restarts, hosts the MCP server, spawns claude,
 * streams transcripts to SQLite, and reports lifecycle events via HTTP.
 *
 * This module also exports the NDJSON stream parsing utilities used by
 * both the provider and the babysitter.
 */

import type { Plugin } from '@shardworks/nexus-core';
import type {
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
} from '@shardworks/animator-apparatus';

import { launchDetached } from './detached.ts';

// ── Output extraction ───────────────────────────────────────────────

/**
 * Extract the final assistant text from a transcript.
 *
 * Walks the transcript backwards to find the last `assistant` message
 * and concatenates its text content blocks.
 *
 * @internal Exported for testing only.
 */
export function extractFinalAssistantText(transcript: Record<string, unknown>[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i]!;
    if (msg.type !== 'assistant') continue;

    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (!content) continue;

    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    return text || undefined;
  }
  return undefined;
}

// ── Provider implementation ──────────────────────────────────────────

const provider: AnimatorSessionProvider = {
  name: 'claude-code',

  async cancel(cancelMetadata: Record<string, unknown>): Promise<void> {
    const pid = cancelMetadata.pid as number | undefined;
    if (pid === undefined) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // Process already dead — expected for race conditions. Silent no-op.
        return;
      }
      throw err;
    }
  },

  launch(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
    processInfo?: Promise<Record<string, unknown>>;
  } {
    return launchDetached(config);
  },
};

// ── Apparatus export ─────────────────────────────────────────────────

/**
 * Create the Claude Code session provider apparatus.
 *
 * The apparatus has no startup logic — it just provides the
 * AnimatorSessionProvider implementation. The Animator looks it up
 * via guild().apparatus('claude-code').
 */
export function createClaudeCodeProvider(): Plugin {
  return {
    apparatus: {
      requires: [],
      provides: provider,

      start() {
        // No startup work — the provider is stateless.
      },
    },
  };
}

export default createClaudeCodeProvider();

// ── Spawn helpers ────────────────────────────────────────────────────

/** Parsed result from stream-json output. @internal */
export interface StreamJsonResult {
  exitCode: number;
  transcript: Record<string, unknown>[];
  costUsd?: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  providerSessionId?: string;
  /** Process signal name if killed by signal (e.g. 'SIGTERM'). */
  signal?: string;
}

/**
 * Parse a single NDJSON message from stream-json output.
 *
 * Returns parsed chunks for streaming and accumulates data into the
 * provided accumulators (transcript, metrics).
 *
 * @internal Exported for testing only.
 */
export function parseStreamJsonMessage(
  msg: Record<string, unknown>,
  acc: {
    transcript: Record<string, unknown>[];
    costUsd?: number;
    tokenUsage?: StreamJsonResult['tokenUsage'];
    providerSessionId?: string;
  },
): SessionChunk[] {
  const chunks: SessionChunk[] = [];

  if (msg.type === 'assistant') {
    acc.transcript.push(msg);

    const message = msg.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            chunks.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            chunks.push({ type: 'tool_use', tool: block.name });
          }
        }
      }
    }
  } else if (msg.type === 'user') {
    acc.transcript.push(msg);

    const content = (msg as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          chunks.push({ type: 'tool_result', tool: String(block.tool_use_id) });
        }
      }
    }
  } else if (msg.type === 'result') {
    acc.costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;
    acc.providerSessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage) {
      acc.tokenUsage = {
        inputTokens: (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0),
        outputTokens: (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0),
        cacheReadTokens: typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens : undefined,
        cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number'
          ? usage.cache_creation_input_tokens : undefined,
      };
    }
  }

  return chunks;
}

/**
 * Process NDJSON buffer, calling handler for each complete line.
 * Returns the remaining incomplete buffer.
 *
 * @internal Exported for testing only.
 */
export function processNdjsonBuffer(
  buffer: string,
  handler: (msg: Record<string, unknown>) => void,
): string {
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      handler(msg);
    } catch {
      // Non-JSON line — ignore
    }
  }
  return buffer;
}

