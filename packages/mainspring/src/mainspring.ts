/**
 * Mainspring — the guild runtime object.
 *
 * `createMainspring(guildRoot)` is the primary entry point. It reads guild.json
 * synchronously and returns a Mainspring instance. Rig loading is lazy — modules
 * are imported on first call to `listRigs()` or `listTools()`, then cached.
 *
 * The Mainspring object is the natural dependency-injection carrier for the guild
 * runtime: CLI and MCP server each create one at startup and hold it for the
 * session's lifetime. Rig authors access other rigs via the `fromMainspring()`
 * convention — each rig package exports a typed `fromMainspring(ms: Mainspring)`
 * factory that returns its inter-rig API surface.
 */

import { readGuildConfig, resolveAllToolsFromExport, isRig, VERSION } from '@shardworks/nexus-core';
import type { Rig, GuildConfig, ToolDefinition } from '@shardworks/nexus-core';
import type { ToolChannel } from '@shardworks/nexus-core';
import { builtinTools } from './tools/index.ts';
import { readGuildPackageJson, resolveGuildPackageEntry } from './resolve-package.ts';
import { openBooksDatabase, type BooksDatabase } from './db/sqlite-adapter.ts';

// ── Rig key derivation ─────────────────────────────────────────────────

/**
 * Derive the guild-facing rig key from an npm package name.
 *
 * Convention:
 * - `@shardworks/nexus-ledger` → `nexus-ledger`  (official scope stripped)
 * - `@acme/my-rig`             → `acme/my-rig`   (third-party: drop @ only)
 * - `my-rig`                   → `my-rig`         (unscoped: unchanged)
 *
 * The `@shardworks` scope is the official Nexus namespace — its rigs are
 * referenced by bare name in guild.json, CLI commands, and config keys.
 * Third-party scoped packages retain the scope as a prefix (without @) to
 * prevent collisions between `@acme/foo` and `@other/foo`.
 */
export function deriveRigKey(packageName: string): string {
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
 * A rig as seen by the mainspring runtime — an installed rig package with
 * its module instance and resolved tools.
 *
 * `instance` is the raw `Rig` object from the package's default export
 * (normalized to `{ tools }` shape if the package exported a bare tool
 * or array). `tools` is the flattened, annotated list used by CLI/MCP.
 *
 * `packageName` is the full npm package name; `key` is the derived
 * guild-facing identifier used in guild.json, CLI commands, and config.
 */
export interface LoadedRig {
  /** Full npm package name, e.g. '@shardworks/nexus-ledger'. Source of truth. */
  readonly packageName: string;
  /** Derived guild-facing key, e.g. 'nexus-ledger'. Used in guild.json and config. */
  readonly key: string;
  /** Version resolved from the installed package's package.json. */
  readonly version: string;
  /** The rig's module export — normalized to Rig shape. */
  readonly instance: Rig;
  /** Tools this rig contributes (ToolDefinition + provenance). */
  readonly tools: Tool[];
}

/**
 * A tool as seen by the mainspring runtime — a ToolDefinition with provenance.
 *
 * Extends ToolDefinition (the rig-author SDK type) with the name of
 * the rig that owns it. Used by CLI and MCP surfaces to register tools.
 */
export interface Tool extends ToolDefinition {
  /** npm package name of the rig that owns this tool */
  readonly rigName: string;
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
 * The guild runtime. Created once per process via `createMainspring()`.
 *
 * Holds the initialized guild state and provides typed access to rigs,
 * tools, and configuration. Rig loading is lazy and cached.
 */
export interface Mainspring {
  /** Absolute path to the guild root. */
  readonly home: string;

  /** The parsed guild.json config. Read at construction time. */
  getGuildConfig(): GuildConfig;

  /**
   * Get the rig-specific section of guild.json.
   * Rig configs are stored as named keys in guild.json.
   * Returns an empty object if the rig has no config section.
   */
  getRigConfig(rigName: string): Record<string, unknown>;

  /**
   * List all installed rigs.
   * Loads and caches rig modules on first call.
   */
  listRigs(): Promise<LoadedRig[]>;

  /**
   * Find a rig by key or full package name. Returns null if not installed.
   * Accepts either the derived key ('nexus-ledger') or the full package name
   * ('@shardworks/nexus-ledger').
   */
  findRig(name: string): Promise<LoadedRig | null>;

  /**
   * List installed tools, optionally filtered by channel and/or roles.
   *
   * @example All CLI tools:
   *   mainspring.listTools({ channel: 'cli' })
   *
   * @example MCP tools for a specific role:
   *   mainspring.listTools({ channel: 'mcp', roles: ['artificer'] })
   */
  listTools(options?: ListToolsOptions): Promise<Tool[]>;

  /**
   * Find a tool by name. Returns null if not installed.
   * Searches all installed tools regardless of channel or role.
   */
  findTool(name: string): Promise<Tool | null>;

  /**
   * Get an open connection to the guild's Books database.
   *
   * Lazily initialized on first call; the same instance is returned on
   * all subsequent calls for the lifetime of this Mainspring. Callers
   * do not need to close the connection — it lives as long as the process.
   *
   * The returned `BooksDatabase` is what the framework injects into
   * `ToolContext.booksDatabase` for every tool handler invocation.
   */
  getDatabase(): BooksDatabase;
}

// ── Implementation ─────────────────────────────────────────────────────

/** Build the mainspring's own LoadedRig entry from its built-in tools. */
function mainspringRig(): LoadedRig {
  const mainspringPackageName = '@shardworks/nexus-mainspring';
  const tools: Tool[] = builtinTools.map((t) => ({ ...t, rigName: mainspringPackageName }) as Tool);
  return {
    packageName: mainspringPackageName,
    key: deriveRigKey(mainspringPackageName),
    version: VERSION,
    instance: { tools: builtinTools as ToolDefinition[] },
    tools,
  };
}

/** Load and cache all rigs from the guild.json tools catalog. */
async function loadAllRigs(
  guildRoot: string,
  config: GuildConfig,
): Promise<LoadedRig[]> {
  // Start with mainspring's own built-in tools — always present
  const rigs: LoadedRig[] = [mainspringRig()];

  // Group installed tools by their npm package name.
  // instance is populated on first module load for each package.
  const rigMap = new Map<string, { version: string; instance: Rig; tools: Tool[] }>();

  for (const [toolName, entry] of Object.entries(config.tools)) {
    if (!entry.package) continue;

    const pkgName = entry.package;

    // Ensure the rig entry exists — load the module once per package
    if (!rigMap.has(pkgName)) {
      const { version } = readGuildPackageJson(guildRoot, pkgName);
      let instance: Rig = {};

      try {
        const entryPath = resolveGuildPackageEntry(guildRoot, pkgName);
        const mod = await import(entryPath) as { default: unknown };
        const rawExport = mod.default;
        // Normalize to Rig shape regardless of export style (bare tool, array, or Rig object)
        instance = isRig(rawExport)
          ? rawExport
          : { tools: resolveAllToolsFromExport(rawExport) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[mainspring] Failed to load rig "${pkgName}": ${message}`);
      }

      rigMap.set(pkgName, { version, instance, tools: [] });
    }

    // Match the registered tool name to a tool in the rig's instance
    const rigEntry = rigMap.get(pkgName)!;
    const allTools = rigEntry.instance.tools ?? [];
    const toolDef = allTools.find((t) => t.name === toolName);
    if (toolDef) {
      rigEntry.tools.push({ ...toolDef, rigName: pkgName });
    }
  }

  // Append installed rigs after the mainspring built-ins
  for (const [packageName, { version, instance, tools }] of rigMap.entries()) {
    rigs.push({
      packageName,
      key: deriveRigKey(packageName),
      version,
      instance,
      tools,
    });
  }

  return rigs;
}

/**
 * Create a Mainspring for the given guild root.
 *
 * Reads guild.json synchronously. Rig modules are loaded lazily on first
 * access to `listRigs()` or `listTools()`, then cached for the lifetime
 * of the Mainspring instance.
 *
 * @param guildRoot - Absolute path to the guild root (contains guild.json).
 */
export function createMainspring(guildRoot: string): Mainspring {
  const config = readGuildConfig(guildRoot);

  // Lazy load cache — a single Promise shared across all callers.
  // Set on first access; all concurrent callers await the same Promise.
  let rigsPromise: Promise<LoadedRig[]> | null = null;

  function getRigs(): Promise<LoadedRig[]> {
    if (!rigsPromise) {
      rigsPromise = loadAllRigs(guildRoot, config);
    }
    return rigsPromise;
  }

  // Lazy database — opened on first call, reused for the process lifetime.
  let db: BooksDatabase | null = null;

  function getDatabase(): BooksDatabase {
    if (!db) {
      db = openBooksDatabase(guildRoot);
    }
    return db;
  }

  const mainspring: Mainspring = {
    home: guildRoot,

    getGuildConfig() {
      return config;
    },

    getRigConfig(name: string) {
      // Normalize to key — accepts either full package name or short key
      const key = name.startsWith('@') ? deriveRigKey(name) : name;
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[key] as Record<string, unknown>) ?? {};
    },

    async listRigs() {
      return getRigs();
    },

    async findRig(name: string) {
      const rigs = await getRigs();
      // Normalize the input to a key for comparison
      const targetKey = name.startsWith('@') ? deriveRigKey(name) : name;
      return rigs.find((r) => r.key === targetKey || r.packageName === name) ?? null;
    },

    async listTools(options?: ListToolsOptions) {
      const rigs = await getRigs();
      let tools: Tool[] = rigs.flatMap((r) => r.tools);

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
      const rigs = await getRigs();
      const allTools = rigs.flatMap((r) => r.tools);
      return allTools.find((t) => t.name === name) ?? null;
    },

    getDatabase,
  };

  return mainspring;
}
