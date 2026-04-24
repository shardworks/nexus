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
  SessionTerminationTag,
} from '@shardworks/animator-apparatus';

import { launchDetached } from './detached.ts';

// ── Rate-limit detection ────────────────────────────────────────────

/**
 * Exit code the claude CLI reports (at least sometimes) when the Anthropic
 * API returns a rate-limit error. The CLI does not document its exit
 * codes, so we treat a distinguished non-zero code as a signal and keep
 * it tunable in one place.
 *
 * Used as a last-resort branch: NDJSON result inspection fires first,
 * stderr pattern fires second, and the exit code catches the case where
 * the babysitter has no structural signal to go on.
 */
export const RATE_LIMIT_EXIT_CODE = 7;

/**
 * Regex that matches common rate-limit phrasings in claude CLI stderr
 * output. The CLI's stderr text is not a stable contract — the regex is
 * deliberately forgiving (case-insensitive, alternate phrasings) rather
 * than narrow. If none of the branches fire, the cascade falls through
 * to the exit-code branch.
 */
export const RATE_LIMIT_STDERR_PATTERN =
  /(rate[-\s]?limit|429\b|usage[-\s]?limit|quota[-\s]?exceeded|too\s+many\s+requests)/i;

/**
 * Detect a rate-limit signature on an NDJSON message from the claude
 * `--output-format stream-json` stream.
 *
 * Looks for:
 *  - `msg.subtype` === 'error_max_turns' or any value containing the
 *    substring `rate_limit` / `rate-limit`
 *  - `msg.is_error` true with `msg.error` / `msg.message.error` text
 *    matching the stderr pattern
 *  - `msg.type` === 'result' whose `result` field contains a rate-limit
 *    phrase (claude's CLI sometimes surfaces provider errors there)
 *
 * The wire shape of claude's error NDJSON is not formally documented, so
 * the branches are generous — any positive match returns a tag. Returns
 * null when the message does not indicate rate limiting.
 */
export function detectRateLimitFromNdjson(
  msg: Record<string, unknown>,
): SessionTerminationTag | null {
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;
  if (subtype && /rate[-_ ]?limit/i.test(subtype)) {
    return {
      kind: 'rate-limit',
      source: 'ndjson-result',
      detail: `NDJSON subtype: ${subtype}`,
    };
  }

  if (msg.is_error === true) {
    const errText =
      (typeof msg.error === 'string' ? msg.error : undefined) ??
      (typeof (msg as { message?: { error?: unknown } }).message?.error === 'string'
        ? ((msg as { message: { error: string } }).message.error)
        : undefined);
    if (errText && RATE_LIMIT_STDERR_PATTERN.test(errText)) {
      return {
        kind: 'rate-limit',
        source: 'ndjson-result',
        detail: errText.slice(0, 200),
      };
    }
  }

  if (msg.type === 'result') {
    const resultText = typeof msg.result === 'string' ? msg.result : undefined;
    if (resultText && RATE_LIMIT_STDERR_PATTERN.test(resultText)) {
      return {
        kind: 'rate-limit',
        source: 'ndjson-result',
        detail: resultText.slice(0, 200),
      };
    }
  }

  return null;
}

/**
 * Detect a rate-limit signature in a block of stderr text.
 *
 * Returns a tag when the pattern matches, null otherwise. The detail
 * carries a bounded excerpt of the matching line so operators can
 * confirm the detection in logs without the Animator forwarding the
 * full stderr buffer.
 */
export function detectRateLimitFromStderr(
  chunk: string,
): SessionTerminationTag | null {
  const match = chunk.match(RATE_LIMIT_STDERR_PATTERN);
  if (!match) return null;
  // Capture the line around the match for context — truncated to keep
  // the tag payload small.
  const lines = chunk.split('\n');
  const hit = lines.find((l) => RATE_LIMIT_STDERR_PATTERN.test(l)) ?? match[0];
  return {
    kind: 'rate-limit',
    source: 'stderr-pattern',
    detail: hit.slice(0, 200),
  };
}

/**
 * Detect a rate-limit signature from a process exit code.
 *
 * Used as the last branch of the cascade — the NDJSON and stderr
 * observers fire first. Returns a tag only for the one distinguished
 * code; generic non-zero codes surface as plain failures.
 */
export function detectRateLimitFromExitCode(
  exitCode: number,
): SessionTerminationTag | null {
  if (exitCode !== RATE_LIMIT_EXIT_CODE) return null;
  return {
    kind: 'rate-limit',
    source: 'exit-code',
    detail: `claude exited with distinguished rate-limit exit code ${exitCode}`,
  };
}

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
    const kind = cancelMetadata.kind as string | undefined;

    if (kind === 'local-pgid') {
      const pgid = cancelMetadata.pgid as number | undefined;
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          // Process group already dead — expected for race conditions. Silent no-op.
          return;
        }
        throw err;
      }
      return;
    }

    // Unknown kind — log and skip
    if (kind) {
      console.warn(`[claude-code] Unknown cancelHandle kind: ${kind}`);
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
  /**
   * Structured termination tag. Populated by the babysitter's detection
   * cascade (NDJSON parse → stderr pattern → exit-code) when the
   * session terminated under a detectable condition (today: rate
   * limiting).
   */
  terminationTag?: SessionTerminationTag;
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
    /**
     * First rate-limit signal observed on the NDJSON stream. Kept
     * first-wins so the cascade source is auditable. The babysitter
     * promotes this onto the final StreamJsonResult when present.
     */
    terminationTag?: SessionTerminationTag;
  },
): SessionChunk[] {
  // Detection first (first-wins) — examine every NDJSON message the
  // claude CLI emits. An error or `result`-with-error message may carry
  // a rate-limit signature even when we otherwise just pass the message
  // through to the transcript.
  if (!acc.terminationTag) {
    const tag = detectRateLimitFromNdjson(msg);
    if (tag) acc.terminationTag = tag;
  }

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

