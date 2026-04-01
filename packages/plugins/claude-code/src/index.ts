/**
 * Claude Code Session Provider
 *
 * Apparatus plugin that implements AnimatorSessionProvider for the
 * Claude Code CLI. The Animator discovers this via guild config:
 *
 *   guild.json["animator"]["sessionProvider"] = "claude-code"
 *
 * Launches sessions via the `claude` CLI in autonomous mode (--print)
 * with --output-format stream-json for structured telemetry.
 *
 * Key design choice: uses async spawn() instead of spawnSync().
 * This is required for stream-json transcript parsing, timeout enforcement,
 * and future concurrent session support.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Plugin } from '@shardworks/nexus-core';
import type {
  AnimatorSessionProvider,
  SessionProviderConfig,
  SessionProviderResult,
  SessionChunk,
} from '@shardworks/animator-apparatus';

// ── Session File Preparation ────────────────────────────────────────────

/** Prepared session files in a temp directory. */
interface PreparedSession {
  tmpDir: string;
  args: string[];
}

/**
 * Prepare session files and build base CLI args.
 *
 * Writes system prompt to a temp directory. Builds the base args array
 * including --resume support. No MCP config in MVP — tool-equipped
 * sessions are a future capability.
 *
 * Caller is responsible for cleaning up tmpDir.
 */
function prepareSession(config: SessionProviderConfig): PreparedSession {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-session-'));

  const args: string[] = [
    '--setting-sources', 'user',
    '--dangerously-skip-permissions',
    '--model', config.model,
  ];

  if (config.systemPrompt) {
    const systemPromptPath = path.join(tmpDir, 'system-prompt.md');
    fs.writeFileSync(systemPromptPath, config.systemPrompt);
    args.push('--system-prompt-file', systemPromptPath);
  }

  // Resume an existing conversation
  if (config.conversationId) {
    args.push('--resume', config.conversationId);
  }

  return { tmpDir, args };
}

// ── Provider implementation ──────────────────────────────────────────

const provider: AnimatorSessionProvider = {
  name: 'claude-code',

  async launch(config: SessionProviderConfig): Promise<SessionProviderResult> {
    const { tmpDir, args } = prepareSession(config);

    try {
      // Autonomous mode: initial prompt via --print, stream-json for telemetry
      args.push(
        '--print', config.initialPrompt ?? '',
        '--output-format', 'stream-json',
        '--verbose',
      );
      const { exitCode, costUsd, tokenUsage, providerSessionId } =
        await spawnClaudeStreamJson(args, config.cwd);

      const status = exitCode === 0 ? 'completed' : 'failed';
      return {
        status,
        exitCode,
        error: status === 'failed' ? `claude exited with code ${exitCode}` : undefined,
        costUsd,
        tokenUsage,
        providerSessionId,
      };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },

  launchStreaming(config: SessionProviderConfig): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  } {
    const { tmpDir, args } = prepareSession(config);

    args.push(
      '--print', config.initialPrompt ?? '',
      '--output-format', 'stream-json',
      '--verbose',
    );

    const { chunks, result: rawResult } = spawnClaudeStreamingJson(args, config.cwd);

    const result = rawResult.then((raw) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const status = raw.exitCode === 0 ? 'completed' as const : 'failed' as const;
      return {
        status,
        exitCode: raw.exitCode,
        error: status === 'failed' ? `claude exited with code ${raw.exitCode}` : undefined,
        costUsd: raw.costUsd,
        tokenUsage: raw.tokenUsage,
        providerSessionId: raw.providerSessionId,
      } satisfies SessionProviderResult;
    }).catch((err) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    });

    return { chunks, result };
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

// ── MCP server re-exports ───────────────────────────────────────────
// The MCP server module is used by the session provider (future: to
// attach tools to sessions via --mcp-config) and can be imported
// directly for testing or custom integrations.

export { createMcpServer } from './mcp-server.ts';
export type { McpServerProcessConfig } from './mcp-server.ts';

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
            process.stderr.write(block.text);
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

/**
 * Spawn Claude in autonomous mode with --output-format stream-json.
 *
 * Captures stdout (NDJSON lines), parses each line to extract:
 * - assistant messages → transcript
 * - result message → cost, token usage, session ID
 *
 * Forwards assistant text content to stderr so it's visible during execution.
 */
function spawnClaudeStreamJson(args: string[], cwd: string): Promise<StreamJsonResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const acc: {
      transcript: Record<string, unknown>[];
      costUsd?: number;
      tokenUsage?: StreamJsonResult['tokenUsage'];
      providerSessionId?: string;
    } = { transcript: [] };

    let buffer = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      buffer = processNdjsonBuffer(buffer, (msg) => {
        parseStreamJsonMessage(msg, acc);
      });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (acc.transcript.length > 0) {
        process.stderr.write('\n');
      }

      resolve({
        exitCode: code ?? 1,
        transcript: acc.transcript,
        costUsd: acc.costUsd,
        tokenUsage: acc.tokenUsage,
        providerSessionId: acc.providerSessionId,
      });
    });
  });
}

/**
 * Spawn Claude with streaming — yields SessionChunks as they arrive
 * while also accumulating the full result.
 *
 * Returns an async iterable of chunks for real-time consumption and
 * a promise for the final StreamJsonResult.
 */
function spawnClaudeStreamingJson(args: string[], cwd: string): {
  chunks: AsyncIterable<SessionChunk>;
  result: Promise<StreamJsonResult>;
} {
  const chunkQueue: SessionChunk[] = [];
  let chunkResolve: (() => void) | null = null;
  let done = false;

  const acc: {
    transcript: Record<string, unknown>[];
    costUsd?: number;
    tokenUsage?: StreamJsonResult['tokenUsage'];
    providerSessionId?: string;
  } = { transcript: [] };

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let buffer = '';

  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    buffer = processNdjsonBuffer(buffer, (msg) => {
      const newChunks = parseStreamJsonMessage(msg, acc);
      if (newChunks.length > 0) {
        chunkQueue.push(...newChunks);
        if (chunkResolve) {
          chunkResolve();
          chunkResolve = null;
        }
      }
    });
  });

  const result = new Promise<StreamJsonResult>((resolve, reject) => {
    proc.on('error', (err) => {
      done = true;
      if (chunkResolve) { chunkResolve(); chunkResolve = null; }
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (acc.transcript.length > 0) {
        process.stderr.write('\n');
      }
      done = true;
      if (chunkResolve) { chunkResolve(); chunkResolve = null; }
      resolve({
        exitCode: code ?? 1,
        transcript: acc.transcript,
        costUsd: acc.costUsd,
        tokenUsage: acc.tokenUsage,
        providerSessionId: acc.providerSessionId,
      });
    });
  });

  const chunks: AsyncIterable<SessionChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SessionChunk>> {
          while (true) {
            if (chunkQueue.length > 0) {
              return { value: chunkQueue.shift()!, done: false };
            }
            if (done) {
              return { value: undefined as unknown as SessionChunk, done: true };
            }
            await new Promise<void>((resolve) => { chunkResolve = resolve; });
          }
        },
      };
    },
  };

  return { chunks, result };
}
