/**
 * Rig — the guild runtime object.
 *
 * `createRig(guildRoot)` is the primary entry point. It reads guild.json
 * synchronously and returns a Rig instance. Plugin loading is lazy — modules
 * are imported on first call to `listPlugins()` or `listTools()`, then cached.
 *
 * The Rig object is the natural dependency-injection carrier for the guild
 * runtime: CLI and MCP server each create one at startup and hold it for the
 * session's lifetime. Plugin authors access other plugins via the `fromRig()`
 * convention — each plugin package exports a typed `fromRig(rig: Rig)` factory
 * that returns its inter-plugin API surface.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { readGuildConfig, resolveAllToolsFromExport, VERSION } from '@shardworks/nexus-core';
import type { GuildConfig, ToolDefinition } from '@shardworks/nexus-core';
import type { ToolChannel } from '@shardworks/nexus-core';
import { builtinTools } from './tools/index.ts';

// ── Plugin key derivation ──────────────────────────────────────────────

/**
 * Derive the guild-facing plugin key from an npm package name.
 *
 * Convention:
 * - `@shardworks/nexus-ledger` → `nexus-ledger`  (official scope stripped)
 * - `@acme/my-plugin`          → `acme/my-plugin` (third-party: drop @ only)
 * - `my-plugin`                → `my-plugin`      (unscoped: unchanged)
 *
 * The `@shardworks` scope is the official Nexus namespace — its plugins are
 * referenced by bare name in guild.json, CLI commands, and config keys.
 * Third-party scoped packages retain the scope as a prefix (without @) to
 * prevent collisions between `@acme/foo` and `@other/foo`.
 */
export function derivePluginKey(packageName: string): string {
  if (packageName.startsWith('@shardworks/')) {
    return packageName.slice('@shardworks/'.length);
  }
  if (packageName.startsWith('@')) {
    return packageName.slice(1); // @acme/foo → acme/foo
  }
  return packageName;
}

// ── Public types ───────────────────────────────────────────────────────

/**
 * A plugin as seen by the rig runtime.
 *
 * Groups the tools (and future contribution types) registered by a single
 * installed npm package. `packageName` is the full npm package name;
 * `key` is the derived guild-facing identifier used in guild.json,
 * CLI commands, and config sections.
 */
export interface NexusPlugin {
  /** Full npm package name, e.g. '@shardworks/nexus-ledger'. Source of truth. */
  readonly packageName: string;
  /** Derived guild-facing key, e.g. 'nexus-ledger'. Used in guild.json and config. */
  readonly key: string;
  /** Version resolved from the installed package's package.json. */
  readonly version: string;
  /** Tools this plugin contributes. */
  readonly tools: NexusTool[];
}

/**
 * A tool as seen by the rig runtime — a ToolDefinition with provenance.
 *
 * Extends ToolDefinition (the plugin-author SDK type) with the name of
 * the plugin that owns it. Used by CLI and MCP surfaces to register tools.
 */
export interface NexusTool extends ToolDefinition {
  /** npm package name of the plugin that owns this tool */
  readonly pluginName: string;
}

/** Options for filtering the tool list. */
export interface ListToolsOptions {
  /**
   * If set, only return tools available in this channel.
   * Tools with no allowedContexts are available everywhere and always pass.
   */
  channel?: ToolChannel;
  /**
   * If set, only return tools accessible to these roles.
   * Collected from baseTools + role.tools in guild.json.
   * When omitted, all installed tools are returned.
   */
  roles?: string[];
}

/**
 * The guild runtime. Created once per process via `createRig()`.
 *
 * Holds the initialized guild state and provides typed access to plugins,
 * tools, and configuration. Plugin loading is lazy and cached.
 */
export interface Rig {
  /** Absolute path to the guild root. */
  readonly home: string;

  /** The parsed guild.json config. Read at construction time. */
  getGuildConfig(): GuildConfig;

  /**
   * Get the plugin-specific section of guild.json.
   * Plugin configs are stored as named keys in guild.json.
   * Returns an empty object if the plugin has no config section.
   */
  getPluginConfig(pluginName: string): Record<string, unknown>;

  /**
   * List all installed plugins.
   * Loads and caches plugin modules on first call.
   */
  listPlugins(): Promise<NexusPlugin[]>;

  /**
   * Find a plugin by key or full package name. Returns null if not installed.
   * Accepts either the derived key ('nexus-ledger') or the full package name
   * ('@shardworks/nexus-ledger').
   */
  findPlugin(name: string): Promise<NexusPlugin | null>;

  /**
   * List installed tools, optionally filtered by channel and/or roles.
   *
   * @example All CLI tools:
   *   rig.listTools({ channel: 'cli' })
   *
   * @example MCP tools for a specific role:
   *   rig.listTools({ channel: 'mcp', roles: ['artificer'] })
   */
  listTools(options?: ListToolsOptions): Promise<NexusTool[]>;

  /**
   * Find a tool by name. Returns null if not installed.
   * Searches all installed tools regardless of channel or role.
   */
  findTool(name: string): Promise<NexusTool | null>;
}

// ── Implementation ─────────────────────────────────────────────────────

/**
 * Read a package.json from the guild's node_modules.
 * Returns the parsed JSON and version. Falls back gracefully.
 */
function readGuildPackageJson(
  guildRoot: string,
  pkgName: string,
): { version: string; pkgJson: Record<string, unknown> | null } {
  const pkgJsonPath = path.join(guildRoot, 'node_modules', pkgName, 'package.json');
  try {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    return { version: (pkgJson.version as string) ?? 'unknown', pkgJson };
  } catch {
    console.warn(`[rig] Could not resolve package.json for "${pkgName}"`);
    return { version: 'unknown', pkgJson: null };
  }
}

/**
 * Resolve the entry point for a guild-installed package.
 *
 * Reads the package's exports map to find the ESM entry point,
 * since guild packages are ESM-only and createRequire() can't resolve them.
 * Returns an absolute path suitable for dynamic import().
 */
function resolveGuildPackageEntry(guildRoot: string, pkgName: string): string {
  const pkgDir = path.join(guildRoot, 'node_modules', pkgName);
  const { pkgJson } = readGuildPackageJson(guildRoot, pkgName);

  if (pkgJson) {
    // Try exports['.'].import, then exports['.'] as string, then main
    const exports = pkgJson.exports as Record<string, unknown> | string | undefined;
    if (exports) {
      if (typeof exports === 'string') return path.join(pkgDir, exports);
      const main = (exports as Record<string, unknown>)['.'];
      if (typeof main === 'string') return path.join(pkgDir, main);
      if (main && typeof main === 'object') {
        const importPath = (main as Record<string, string>).import;
        if (importPath) return path.join(pkgDir, importPath);
      }
    }
    if (pkgJson.main) return path.join(pkgDir, pkgJson.main as string);
  }

  // Last resort
  return path.join(pkgDir, 'index.js');
}

/** Build the rig's own plugin entry from its built-in tools. */
function rigPlugin(): NexusPlugin {
  const rigPackageName = '@shardworks/nexus-rig';
  return {
    packageName: rigPackageName,
    key: derivePluginKey(rigPackageName),
    version: VERSION,
    tools: builtinTools.map((t) => ({ ...t, pluginName: rigPackageName }) as NexusTool),
  };
}

/** Load and cache all plugins from the guild.json tools catalog. */
async function loadAllPlugins(
  guildRoot: string,
  config: GuildConfig,
): Promise<NexusPlugin[]> {
  // Start with rig's own built-in tools — always present
  const plugins: NexusPlugin[] = [rigPlugin()];

  // Group installed tools by their npm package name
  const pluginMap = new Map<string, { version: string; tools: NexusTool[] }>();

  for (const [toolName, entry] of Object.entries(config.tools)) {
    if (!entry.package) continue;

    const pkgName = entry.package;

    // Ensure the plugin entry exists
    if (!pluginMap.has(pkgName)) {
      const { version } = readGuildPackageJson(guildRoot, pkgName);
      pluginMap.set(pkgName, { version, tools: [] });
    }

    // Import the package and extract the matching tool.
    // Resolve from the guild's node_modules (not rig's) since plugins are
    // installed as guild dependencies.
    try {
      const entryPath = resolveGuildPackageEntry(guildRoot, pkgName);
      const mod = await import(entryPath) as { default: unknown };
      const allTools = resolveAllToolsFromExport(mod.default);

      for (const toolDef of allTools) {
        if (toolDef.name !== toolName) continue;
        pluginMap.get(pkgName)!.tools.push({
          ...toolDef,
          pluginName: pkgName,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[rig] Failed to load tool "${toolName}" from "${pkgName}": ${message}`);
    }
  }

  // Append installed plugins after the rig built-in
  for (const [packageName, { version, tools }] of pluginMap.entries()) {
    plugins.push({
      packageName,
      key: derivePluginKey(packageName),
      version,
      tools,
    });
  }

  return plugins;
}

/**
 * Create a Rig for the given guild root.
 *
 * Reads guild.json synchronously. Plugin modules are loaded lazily on first
 * access to `listPlugins()` or `listTools()`, then cached for the lifetime
 * of the Rig instance.
 *
 * @param guildRoot - Absolute path to the guild root (contains guild.json).
 */
export function createRig(guildRoot: string): Rig {
  const config = readGuildConfig(guildRoot);

  // Lazy load cache — a single Promise shared across all callers.
  // Set on first access; all concurrent callers await the same Promise.
  let pluginsPromise: Promise<NexusPlugin[]> | null = null;

  function getPlugins(): Promise<NexusPlugin[]> {
    if (!pluginsPromise) {
      pluginsPromise = loadAllPlugins(guildRoot, config);
    }
    return pluginsPromise;
  }

  const rig: Rig = {
    home: guildRoot,

    getGuildConfig() {
      return config;
    },

    getPluginConfig(name: string) {
      // Normalize to key — accepts either full package name or short key
      const key = name.startsWith('@') ? derivePluginKey(name) : name;
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[key] as Record<string, unknown>) ?? {};
    },

    async listPlugins() {
      return getPlugins();
    },

    async findPlugin(name: string) {
      const plugins = await getPlugins();
      // Normalize the input to a key for comparison
      const targetKey = name.startsWith('@') ? derivePluginKey(name) : name;
      return plugins.find((p) => p.key === targetKey || p.packageName === name) ?? null;
    },

    async listTools(options?: ListToolsOptions) {
      const plugins = await getPlugins();
      let tools: NexusTool[] = plugins.flatMap((p) => p.tools);

      // Filter by channel (allowedContexts)
      if (options?.channel) {
        const channel = options.channel;
        tools = tools.filter(
          (t) => !t.allowedContexts || t.allowedContexts.includes(channel),
        );
      }

      // Filter by roles (baseTools + role-specific tools)
      if (options?.roles && options.roles.length > 0) {
        const toolNames = new Set<string>(config.baseTools ?? []);
        for (const role of options.roles) {
          const roleDef = config.roles[role];
          if (roleDef) {
            for (const toolName of roleDef.tools) {
              toolNames.add(toolName);
            }
          }
        }
        tools = tools.filter((t) => toolNames.has(t.name));
      }

      return tools;
    },

    async findTool(name: string) {
      const plugins = await getPlugins();
      const allTools = plugins.flatMap((p) => p.tools);
      return allTools.find((t) => t.name === name) ?? null;
    },
  };

  return rig;
}
