/**
 * Claude Code Session Provider
 *
 * Implements the SessionProvider interface for Claude Code sessions.
 * Handles both interactive (TUI) and autonomous (--print) modes.
 *
 * This is a platform dependency of the CLI, not a guild-registered engine.
 * The CLI imports it at startup and registers it as the session provider.
 * Guilds don't need to know about it — it's a transitive dep of @shardworks/nexus.
 *
 * Key design choice: uses async spawn() instead of spawnSync().
 * This is required for stream-json transcript parsing, timeout enforcement,
 * and future concurrent session support.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedTool, ManifestResult } from '@shardworks/nexus-core';
import type { McpServerConfig } from './mcp-server.ts';
import type { SessionProvider, SessionProviderLaunchOptions, SessionProviderResult, SessionChunk } from '@shardworks/nexus-core';

// ── MCP Config Generation ──────────────────────────────────────────────

/**
 * Generate the MCP server config for the resolved tool set.
 *
 * For tools with a `package` field in guild.json, the modulePath is the
 * npm package name (resolved via NODE_PATH at runtime). For tools without
 * a package field, the modulePath is an absolute path to the entry point.
 */
export function generateMcpConfig(
  home: string,
  tools: ResolvedTool[],
): McpServerConfig {
  const mcpTools: Array<{ name: string; modulePath: string }> = [];

  for (const t of tools) {
    if (t.package) {
      mcpTools.push({ name: t.name, modulePath: t.package });
    } else {
      const descriptorPath = path.join(t.path, 'nexus-tool.json');
      if (!fs.existsSync(descriptorPath)) continue;

      const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'));
      const entry = descriptor.entry as string;
      mcpTools.push({ name: t.name, modulePath: path.join(t.path, entry) });
    }
  }

  // Set NODE_PATH so the MCP server process can resolve npm-installed guild
  // tools from the guildhall's node_modules, regardless of where the MCP
  // engine code itself lives on disk.
  const nodePath = path.join(home, 'node_modules');
  return { home, tools: mcpTools, env: { NODE_PATH: nodePath } };
}

// ── Claude MCP Config ──────────────────────────────────────────────────

/**
 * Build the Claude MCP config JSON (mcpServers format) that launches the
 * MCP server as a stdio process serving the anima's tools.
 */
function buildClaudeMcpConfig(
  tmpDir: string,
  mcpServerConfigPath: string,
  serverConfig: McpServerConfig,
): object {
  // Resolve the mcp-server entry point within this package.
  // Use .js extension — TypeScript's transform-types does not rewrite
  // extensions in import.meta.resolve() calls, so .ts would be baked
  // into compiled output and fail at runtime (dist/ only has .js).
  const mcpServerUrl = import.meta.resolve('./mcp-server.js');
  const mcpServerPath = fileURLToPath(mcpServerUrl);

  // In dev (monorepo), only mcp-server.ts exists — the .js URL won't
  // resolve on disk. Detect this and swap to .ts with transform flags.
  const isDev = !fs.existsSync(mcpServerPath);
  const actualUrl = isDev
    ? mcpServerUrl.replace(/\.js$/, '.ts')
    : mcpServerUrl;

  // Write a wrapper script that imports and invokes main().
  const wrapperPath = path.join(tmpDir, 'mcp-entry.mjs');
  fs.writeFileSync(
    wrapperPath,
    `import { main } from ${JSON.stringify(actualUrl)};\nawait main();\n`,
  );

  // Dev mode needs transform-types to handle the .ts source.
  const nodeArgs: string[] = [];
  if (isDev) {
    nodeArgs.push(
      '--disable-warning=ExperimentalWarning',
      '--experimental-transform-types',
    );
  }

  return {
    mcpServers: {
      'nexus-guild': {
        command: 'node',
        args: [...nodeArgs, wrapperPath, mcpServerConfigPath],
        env: serverConfig.env ?? {},
      },
    },
  };
}

// ── Session Provider ───────────────────────────────────────────────────

/**
 * Claude Code session provider.
 *
 * Launches sessions via the `claude` CLI. Interactive mode inherits stdio;
 * autonomous mode uses --print with optional --output-format stream-json.
 */
// ── Session File Preparation ────────────────────────────────────────────

/** Prepared session files in a temp directory. */
interface PreparedSession {
  tmpDir: string;
  args: string[];
}

/**
 * Prepare session files and build base CLI args.
 *
 * Shared between launch() and launchStreaming(). Writes system prompt,
 * MCP config, and Claude MCP config to a temp directory. Builds the
 * base args array including --resume support.
 *
 * Caller is responsible for cleaning up tmpDir.
 */
function prepareSession(options: SessionProviderLaunchOptions): PreparedSession {
  const { home, manifest, cwd, name, claudeSessionId } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-session-'));

  // Generate MCP config from resolved tools
  const mcpConfig = generateMcpConfig(home, manifest.tools);

  const systemPromptPath = path.join(tmpDir, 'system-prompt.md');
  const mcpServerConfigPath = path.join(tmpDir, 'mcp-server-config.json');
  const claudeMcpConfigPath = path.join(tmpDir, 'claude-mcp-config.json');

  fs.writeFileSync(systemPromptPath, manifest.systemPrompt);
  fs.writeFileSync(mcpServerConfigPath, JSON.stringify(mcpConfig, null, 2));
  fs.writeFileSync(
    claudeMcpConfigPath,
    JSON.stringify(buildClaudeMcpConfig(tmpDir, mcpServerConfigPath, mcpConfig), null, 2),
  );

  // Base args
  const args: string[] = [
    '--setting-sources', 'user',
    '--dangerously-skip-permissions',
    '--system-prompt-file', systemPromptPath,
    '--mcp-config', claudeMcpConfigPath,
  ];

  // Resume an existing conversation
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }

  if (name) {
    args.push('--name', name);
  }

  return { tmpDir, args };
}

// ── Provider ───────────────────────────────────────────────────────────

export const claudeCodeProvider: SessionProvider = {
  name: 'claude-code',

  async launch(options: SessionProviderLaunchOptions): Promise<SessionProviderResult> {
    const { prompt, interactive, cwd } = options;
    const startTime = Date.now();
    const { tmpDir, args } = prepareSession(options);

    try {
      if (interactive) {
        // Interactive: human at keyboard, inherit stdio
        const exitCode = await spawnClaude(args, cwd, 'inherit');
        const durationMs = Date.now() - startTime;
        return { exitCode, durationMs };
      } else {
        // Autonomous: commission spec / brief as prompt
        // Use stream-json to capture transcript, token usage, and cost.
        args.push(
          '--print', prompt ?? '',
          '--output-format', 'stream-json',
          '--verbose',
        );
        const { exitCode, transcript, costUsd, tokenUsage, providerSessionId } =
          await spawnClaudeStreamJson(args, cwd);
        const durationMs = Date.now() - startTime;
        return { exitCode, durationMs, transcript, costUsd, tokenUsage, providerSessionId };
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },

  launchStreaming(options: SessionProviderLaunchOptions): {
    chunks: AsyncIterable<SessionChunk>;
    result: Promise<SessionProviderResult>;
  } {
    const { prompt, cwd } = options;
    const startTime = Date.now();
    const { tmpDir, args } = prepareSession(options);

    args.push(
      '--print', prompt ?? '',
      '--output-format', 'stream-json',
      '--verbose',
    );

    const { chunks, result: rawResult } = spawnClaudeStreamingJson(args, cwd);

    // Wrap the result promise to add durationMs and clean up tmp files
    const result = rawResult.then((raw) => {
      const durationMs = Date.now() - startTime;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return {
        exitCode: raw.exitCode,
        durationMs,
        transcript: raw.transcript,
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

/**
 * Spawn the claude CLI process asynchronously in interactive mode.
 *
 * @param args - CLI arguments for claude
 * @param cwd - Working directory for the process
 * @param stdio - 'inherit' for interactive, 'pipe' for autonomous (stdin only)
 * @returns Exit code (0 = success)
 */
function spawnClaude(
  args: string[],
  cwd: string,
  stdio: 'inherit' | 'pipe',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: stdio === 'inherit'
        ? 'inherit'
        : ['pipe', 'inherit', 'inherit'],
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

/** Parsed result from stream-json output. */
interface StreamJsonResult {
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
 */
function parseStreamJsonMessage(
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

    // Check for tool results
    const content = (msg as Record<string, unknown>).content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          // Try to find the tool name — it may not be directly available
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
 */
function processNdjsonBuffer(
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
  // Queue for streaming chunks to the async iterable consumer
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
        // Wake up the async iterator if it's waiting
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

  // Async iterable that yields chunks as they arrive
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
            // Wait for more data
            await new Promise<void>((resolve) => { chunkResolve = resolve; });
          }
        },
      };
    },
  };

  return { chunks, result };
}

export default claudeCodeProvider;
