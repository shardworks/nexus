/**
 * MCP Tool Server — serves guild tools as typed MCP tools during anima sessions.
 *
 * Two entry points:
 *
 * 1. **`createMcpServer(tools)`** — library function. Takes an array of
 *    ToolDefinitions (already resolved by the Instrumentarium) and returns
 *    a configured McpServer. Used by in-process callers or by the process
 *    entry point below.
 *
 * 2. **`startMcpServer(config)`** — process entry point. Boots a guild
 *    runtime, resolves the permission-gated tool set via the Instrumentarium,
 *    creates the MCP server, and connects via stdio transport. Designed to
 *    be spawned by Claude's runtime via `--mcp-config`.
 *
 * The MCP server is one-per-session. Claude's runtime manages the lifecycle —
 * spawns at session start, kills at session end.
 *
 * See: docs/architecture/apparatus/claude-code.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '@shardworks/nexus-core';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Configuration for the MCP server process entry point.
 *
 * Passed as a JSON file (path in argv[2]) when the MCP server is
 * spawned as a standalone process by Claude's runtime.
 */
export interface McpServerProcessConfig {
  /** Absolute path to the guild root. */
  home: string;
  /**
   * Permission grants for tool resolution (plugin:level format).
   * Passed to instrumentarium.resolve() to determine the tool set.
   */
  permissions: string[];
  /**
   * Strict mode for permissionless tools.
   * When true, permissionless tools are excluded unless the grants
   * contain plugin:* or *:* for the tool's plugin.
   */
  strict?: boolean;
}

// ── Library API ─────────────────────────────────────────────────────────

/**
 * Create and configure an MCP server with the given tools.
 *
 * Each tool's Zod param schema is registered directly with the MCP SDK
 * (which handles JSON Schema conversion). The handler is wrapped to
 * validate params via Zod and format the result as MCP tool output.
 *
 * Tools with `callableFrom` set that does not include `'mcp'` are
 * filtered out. Tools without `callableFrom` are included (available
 * on all channels by default).
 */
export async function createMcpServer(tools: ToolDefinition[]): Promise<McpServer> {
  const server = new McpServer({
    name: 'nexus-guild',
    version: VERSION,
  });

  for (const def of tools) {
    // Filter by callableFrom — only serve tools that include 'mcp'.
    // Tools with no callableFrom default to all callers (available everywhere).
    if (def.callableFrom && !def.callableFrom.includes('mcp')) {
      continue;
    }

    server.tool(
      def.name,
      def.description,
      def.params.shape,
      async (params) => {
        try {
          const validated = def.params.parse(params);
          const result = await def.handler(validated);

          return {
            content: [{
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

// ── Process entry point ─────────────────────────────────────────────────

/**
 * Start the MCP server as a standalone stdio process.
 *
 * Boots the guild runtime, resolves the permission-gated tool set via
 * the Instrumentarium, creates the MCP server, and connects via stdio.
 *
 * Config is read from a JSON file whose path is passed as argv[2]:
 *
 *   node mcp-server.js <config.json>
 *
 * Config shape: McpServerProcessConfig (home, permissions, strict?)
 *
 * This is the entry point Claude's runtime uses when spawning the MCP
 * server via --mcp-config. Requires @shardworks/nexus-arbor at runtime
 * for guild boot (createGuild).
 */
export async function startMcpServer(configPath?: string): Promise<void> {
  const resolvedPath = configPath ?? process.argv[2];

  if (!resolvedPath) {
    console.error('Usage: mcp-server <config.json>');
    process.exit(1);
  }

  const fs = await import('node:fs');
  const configText = fs.readFileSync(resolvedPath, 'utf-8');
  const config: McpServerProcessConfig = JSON.parse(configText);

  // Boot the guild runtime so tool handlers can access guild().
  // Dynamic import — nexus-arbor is not a declared dependency of this
  // package. It will be available at runtime when the MCP server is
  // spawned inside a guild's node_modules tree (all framework packages
  // are co-installed). This avoids a compile-time circular dependency.
  // @ts-expect-error — nexus-arbor is a runtime-only dependency (not in
  // this package's package.json). Available in guild node_modules at runtime.
  const arbor: { createGuild: (root: string) => Promise<unknown> } = await import('@shardworks/nexus-arbor');
  await arbor.createGuild(config.home);

  // Resolve the permission-gated tool set via the Instrumentarium.
  const core = await import('@shardworks/nexus-core');
  const instrumentarium = core.guild().apparatus<{
    resolve(options: {
      permissions: string[];
      strict?: boolean;
      channel?: string;
    }): Array<{ definition: ToolDefinition; pluginId: string }>;
  }>('tools');

  const resolved = instrumentarium.resolve({
    permissions: config.permissions,
    strict: config.strict,
    channel: 'mcp',
  });

  const tools = resolved.map((r) => r.definition);
  const server = await createMcpServer(tools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
