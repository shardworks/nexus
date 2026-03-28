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

import { readGuildConfigV2, resolveAllToolsFromExport, isRig, isToolDefinition, VERSION } from '@shardworks/nexus-core';
import type { Rig, GuildConfigV2, ToolDefinition, RigContext, ReadOnlyBook, Book } from '@shardworks/nexus-core';
import type { ToolCaller } from '@shardworks/nexus-core';
import { builtinTools } from './tools/index.ts';
import { deriveRigId, readGuildPackageJson, resolveGuildPackageEntry, resolvePackageNameForRigKey } from './resolve-package.ts';
import { openBooksDatabase, type BooksDatabase } from './db/sqlite-adapter.ts';
import { BookStore, booksTableName } from './db/book-store.ts';
import { reconcileBooks } from './db/reconcile-books.ts';

// ── Rig id derivation ──────────────────────────────────────────────────
// Re-exported from resolve-package.ts to avoid circular imports: tool modules
// need deriveRigId but also get imported by mainspring.ts via builtinTools.
export { deriveRigId } from './resolve-package.ts';

// ── Public types ───────────────────────────────────────────────────────

/**
 * A rig as seen by the mainspring runtime — an installed rig package with
 * its module instance and resolved tools.
 *
 * `instance` is the raw `Rig` object from the package's default export
 * (normalized to `{ tools }` shape if the package exported a bare tool
 * or array). `tools` is the flattened, annotated list used by CLI/MCP.
 *
 * `packageName` is the full npm package name; `id` is the derived
 * guild-facing identifier used in guild.json, CLI commands, and config.
 */
export interface LoadedRig {
  /** Full npm package name, e.g. '@shardworks/nexus-ledger'. Source of truth. */
  readonly packageName: string;
  /** Derived guild-facing id, e.g. 'nexus-ledger'. Used in guild.json and config. */
  readonly id: string;
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
 * Extends ToolDefinition (the rig-author SDK type) with the derived id of
 * the rig that owns it. Used by CLI and MCP surfaces to register tools.
 */
export interface Tool extends ToolDefinition {
  /** Derived rig id of the rig that owns this tool (e.g. 'nexus-ledger') */
  readonly rigId: string;
}

/** Options for filtering the tool list. */
export interface ListToolsOptions {
  /**
   * If set, only return tools available in this channel.
   * Tools with no callableFrom are available everywhere and always pass.
   */
  channel?: ToolCaller;
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
  getGuildConfig(): GuildConfigV2;

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
   */
  getDatabase(): BooksDatabase;

  /**
   * Create a `RigContext` scoped to the given rig id.
   *
   * The returned context's `book()` method returns `Book<T>` handles scoped
   * to `rigId`. `rigBook()` returns read-only handles scoped to the
   * specified foreign rig id.
   *
   * Called by the CLI and MCP server when constructing the context to pass
   * to tool and engine handlers.
   *
   * @param rigId - The derived rig id (e.g. 'nexus-ledger', not the npm package name).
   */
  createRigContext(rigId: string): RigContext;
}

// ── Implementation ─────────────────────────────────────────────────────

/** Build the mainspring's own LoadedRig entry from its built-in tools. */
function mainspringRig(): LoadedRig {
  const mainspringPackageName = '@shardworks/nexus-mainspring';
  const mainspringId = deriveRigId(mainspringPackageName);
  const tools: Tool[] = builtinTools.map((t) => ({ ...t, rigId: mainspringId }) as Tool);
  return {
    packageName: mainspringPackageName,
    id: mainspringId,
    version: VERSION,
    instance: { tools: builtinTools as ToolDefinition[] },
    tools,
  };
}

/**
 * Load all installed rigs by iterating config.rigs and resolving package names
 * from the guild's package.json. Each rig module is imported and introspected
 * to discover its tools — no per-tool registry in guild.json required.
 */
async function loadAllRigs(
  guildRoot: string,
  config: GuildConfigV2,
): Promise<LoadedRig[]> {
  // Start with mainspring's own built-in tools — always present
  const rigs: LoadedRig[] = [mainspringRig()];

  for (const rigKey of config.rigs) {
    // Reverse-map rig key → npm package name via the guild's package.json deps
    const packageName = resolvePackageNameForRigKey(guildRoot, rigKey);
    if (!packageName) {
      console.warn(`[mainspring] No package found in package.json for rig key "${rigKey}" — skipping`);
      continue;
    }

    const { version } = readGuildPackageJson(guildRoot, packageName);
    let instance: Rig = {};

    try {
      const entryPath = resolveGuildPackageEntry(guildRoot, packageName);
      const mod = await import(entryPath) as { default: unknown };
      const rawExport = mod.default;
      // Normalize to Rig shape regardless of export style (bare tool, array, or Rig object)
      instance = isRig(rawExport)
        ? rawExport
        : { tools: resolveAllToolsFromExport(rawExport) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[mainspring] Failed to load rig "${packageName}": ${message}`);
    }

    // Annotate each tool with its rig's id
    const tools: Tool[] = (instance.tools ?? [])
      .filter(isToolDefinition)
      .map((t) => ({ ...t, rigId: rigKey }));

    rigs.push({ packageName, id: rigKey, version, instance, tools });
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
  const config = readGuildConfigV2(guildRoot);

  // Lazy load cache — a single Promise shared across all callers.
  // Set on first access; all concurrent callers await the same Promise.
  // Reconciles book schemas after rigs are loaded.
  let rigsPromise: Promise<LoadedRig[]> | null = null;

  function getRigs(): Promise<LoadedRig[]> {
    if (!rigsPromise) {
      rigsPromise = loadAllRigs(guildRoot, config).then(async (rigs) => {
        await reconcileBooks(getDatabase(), rigs);
        return rigs;
      });
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
      const key = name.startsWith('@') ? deriveRigId(name) : name;
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[key] as Record<string, unknown>) ?? {};
    },

    async listRigs() {
      return getRigs();
    },

    async findRig(name: string) {
      const rigs = await getRigs();
      // Normalize the input to an id for comparison
      const targetId = name.startsWith('@') ? deriveRigId(name) : name;
      return rigs.find((r) => r.id === targetId || r.packageName === name) ?? null;
    },

    async listTools(options?: ListToolsOptions) {
      const rigs = await getRigs();
      let tools: Tool[] = rigs.flatMap((r) => r.tools);

      // Filter by caller type (callableFrom)
      if (options?.channel) {
        const channel = options.channel;
        tools = tools.filter(
          (t) => !t.callableFrom || t.callableFrom.includes(channel),
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

    createRigContext(rigId: string): RigContext {
      return {
        home: guildRoot,

        book<T extends { id: string }>(name: string): Book<T> {
          return new BookStore<T>(getDatabase(), booksTableName(rigId, name));
        },

        rigBook<T extends { id: string }>(
          otherRigId: string,
          name: string,
        ): ReadOnlyBook<T> {
          const store = new BookStore<T>(
            getDatabase(),
            booksTableName(otherRigId, name),
          );
          return {
            get: store.get.bind(store),
            find: store.find.bind(store),
            list: store.list.bind(store),
            count: store.count.bind(store),
          };
        },
      };
    },
  };

  return mainspring;
}
