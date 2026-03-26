/**
 * MCP Server — serves guild tools as typed MCP tools during anima sessions.
 *
 * Absorbed from the former `engine-mcp-server` package. This is an internal
 * module of claude-code-session-provider — not a separate package.
 *
 * The session provider launches this as a stdio process, configured with
 * the set of tools the anima has access to (based on role gating).
 *
 * One process per session. All the anima's tools. Claude's runtime manages
 * the lifecycle — spawns at session start, kills at session end.
 *
 * ## Usage
 *
 * The server reads a JSON config from a file path passed as argv[2]:
 *
 *   node mcp-server <config.json>
 *
 * Config shape:
 *   {
 *     "home": "/absolute/path/to/guild-root",
 *     "tools": [
 *       { "name": "install-tool", "modulePath": "@shardworks/nexus-stdlib" },
 *       { "name": "my-tool", "modulePath": "/absolute/path/to/handler.ts" }
 *     ]
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, resolveToolFromExport, registerSessionProvider } from '@shardworks/nexus-core';
import type { ToolDefinition, ToolContext } from '@shardworks/nexus-core';
import { claudeCodeProvider } from './index.ts';

/** A single tool to load into the MCP server. */
export interface ToolSpec {
  /** Tool name — how the anima sees it. */
  name: string;
  /** Module path — package name (for framework tools) or absolute file path (for guild tools). */
  modulePath: string;
}

/** Configuration for the MCP server. */
export interface McpServerConfig {
  /** Absolute path to the guild root. */
  home: string;
  /** Tools to register as MCP tools. */
  tools: ToolSpec[];
  /** Environment variables for the MCP server process. */
  env?: Record<string, string>;
}

/**
 * Load a tool definition from a module path.
 *
 * Handles both single-tool and array-of-tools exports:
 * - Single: `export default tool({...})` → returned directly
 * - Array: `export default [tool({...}), ...]` → resolved by spec.name
 */
async function loadTool(spec: ToolSpec): Promise<ToolDefinition | null> {
  try {
    const mod = await import(spec.modulePath);
    const def = resolveToolFromExport(mod.default, spec.name);

    if (!def) {
      console.error(
        `[mcp-server] ${spec.name}: could not resolve tool from "${spec.modulePath}". ` +
        `Module must export a tool() definition or an array of tool() definitions with matching names. Skipping.`,
      );
      return null;
    }

    return def;
  } catch (err) {
    console.error(`[mcp-server] ${spec.name}: failed to load module "${spec.modulePath}":`, err);
    return null;
  }
}

/**
 * Create and configure an MCP server with the given tools.
 *
 * Each tool's Zod param schema is registered directly with the MCP SDK
 * (which handles JSON Schema conversion). The handler is wrapped to inject
 * the framework context and format the result as MCP tool output.
 */
export async function createMcpServer(config: McpServerConfig): Promise<McpServer> {
  const server = new McpServer({
    name: 'nexus-guild',
    version: VERSION,
  });

  const context: ToolContext = { home: config.home };

  for (const spec of config.tools) {
    const def = await loadTool(spec);
    if (!def) continue;

    // Register the tool as an MCP tool.
    // The MCP SDK accepts Zod shapes directly — it handles JSON Schema conversion.
    server.tool(
      spec.name,
      def.description,
      def.params.shape,
      async (params) => {
        try {
          // Validate params through Zod before passing to handler
          const validated = def.params.parse(params);
          const result = await def.handler(validated, context);

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

/**
 * Entry point when run as a standalone process.
 *
 * Reads config from a JSON file (path passed as first argument),
 * creates the MCP server, and connects via stdio transport.
 */
export async function main(configPath?: string): Promise<void> {
  const resolvedPath = configPath ?? process.argv[2];

  if (!resolvedPath) {
    console.error('Usage: nexus-mcp-server <config.json>');
    process.exit(1);
  }

  // Register the session provider so tools that trigger session launches
  // (e.g. clock-run dispatching a summon) have a provider available.
  // Without this, launchSession() throws because no provider is registered —
  // the CLI entry point (program.ts) registers it for CLI commands, but the
  // MCP server is a separate process that needs its own registration.
  registerSessionProvider(claudeCodeProvider);

  const fs = await import('node:fs');
  const configText = fs.readFileSync(resolvedPath, 'utf-8');
  const config: McpServerConfig = JSON.parse(configText);

  const server = await createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
