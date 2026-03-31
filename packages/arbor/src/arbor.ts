/**
 * Arbor — the guild runtime object.
 *
 * `createArbor(guildRoot)` is the primary entry point. It reads guild.json
 * synchronously and returns an Arbor instance. Plugin loading is lazy —
 * modules are imported on first access to any listing method, then cached.
 *
 * The Arbor manages the full plugin lifecycle:
 *   1. Load    — imports all declared plugin packages, discriminates kit vs apparatus
 *   2. Validate — checks `requires` declarations, detects circular dependencies
 *   3. Start   — calls start(ctx) on each apparatus in dependency-resolved order
 *   4. Events  — fires `plugin:initialized` after each plugin loads
 *   5. Warn    — advisory warnings for mismatched kit contributions / recommends
 */

import {
  readGuildConfigV2,
  resolveAllToolsFromExport,
  isToolDefinition,
  isKit,
  isApparatus,
  VERSION,
} from '@shardworks/nexus-core';
import type {
  GuildConfigV2,
  ToolDefinition,
  HandlerContext,
  GuildContext,
  Kit,
  LoadedKit,
  LoadedApparatus,
  LoadedPlugin,
} from '@shardworks/nexus-core';
import type { ToolCaller } from '@shardworks/nexus-core';
import { builtinTools } from './tools/index.ts';
import { derivePluginId, readGuildPackageJson, resolveGuildPackageEntry, resolvePackageNameForPluginId } from './resolve-package.ts';
import { openBooksDatabase, type BooksDatabase } from './db/sqlite-adapter.ts';
import { BookStore, booksTableName } from './db/book-store.ts';
import { reconcileBooks } from './db/reconcile-books.ts';

// Re-export for consumers that need the id derivation function
export { derivePluginId } from './resolve-package.ts';

// ── Public types ───────────────────────────────────────────────────────

/**
 * A tool as seen by the arbor runtime — a ToolDefinition with provenance.
 *
 * Extends ToolDefinition (the plugin-author SDK type) with the derived id of
 * the plugin that owns it. Used by CLI and MCP surfaces to register tools.
 */
export interface Tool extends ToolDefinition {
  /** Derived plugin id of the plugin that owns this tool (e.g. 'nexus-ledger') */
  readonly pluginId: string;
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
 * The guild runtime. Created once per process via `createArbor()`.
 *
 * Holds the initialized guild state and provides typed access to plugins,
 * tools, and configuration. Plugin loading is lazy and cached.
 */
export interface Arbor {
  /** Absolute path to the guild root. */
  readonly home: string;

  /** The parsed guild.json config. Read at construction time. */
  getGuildConfig(): GuildConfigV2;

  /**
   * List all installed kits.
   * Loads, validates, and starts plugins on first call.
   */
  listKits(): Promise<LoadedKit[]>;

  /**
   * List all installed apparatuses.
   * Loads, validates, and starts plugins on first call.
   */
  listApparatuses(): Promise<LoadedApparatus[]>;

  /**
   * List all installed plugins (kits + apparatuses).
   * Loads, validates, and starts plugins on first call.
   */
  listPlugins(): Promise<LoadedPlugin[]>;

  /**
   * Find a plugin by id or full package name. Returns null if not installed.
   * Accepts either the derived id ('nexus-ledger') or the full package name
   * ('@shardworks/nexus-ledger').
   */
  findPlugin(name: string): Promise<LoadedPlugin | null>;

  /**
   * List installed tools, optionally filtered by channel and/or roles.
   */
  listTools(options?: ListToolsOptions): Promise<Tool[]>;

  /**
   * Find a tool by name. Returns null if not installed.
   * Searches all installed tools regardless of channel or role.
   */
  findTool(name: string): Promise<Tool | null>;

  /**
   * Create a HandlerContext for use when dispatching a tool or engine handler.
   *
   * Pass `owningPluginId` (e.g. `tool.pluginId`) so that `ctx.config()` with
   * no args returns the correct plugin's config section. Omit for generic
   * contexts (e.g. testing, CLI introspection) — `ctx.config()` returns `{}`.
   *
   * Must be called after plugin loading has completed (i.e., after any listing
   * method has been awaited).
   */
  createHandlerContext(owningPluginId?: string): HandlerContext;

  /**
   * Get an open connection to the guild's Books database.
   *
   * Transitional: Books database management will move to the nexus-books
   * apparatus once implemented. Lazily initialized; lives for the process lifetime.
   *
   * @deprecated Will be removed when nexus-books apparatus ships.
   */
  getDatabase(): BooksDatabase;
}

// ── Internal manifest ──────────────────────────────────────────────────

interface GuildManifest {
  kits:        LoadedKit[]
  apparatuses: LoadedApparatus[]
  /** Flat tool list extracted from all kits and apparatus supportKits. */
  tools:       Tool[]
  /** Map from apparatus id → provides object, populated as each apparatus starts. */
  provides:    Map<string, unknown>
}

// ── Implementation ─────────────────────────────────────────────────────

/** Build the arbor's own LoadedKit entry from its built-in tools. */
function arborKit(): LoadedKit {
  const packageName = '@shardworks/nexus-arbor';
  const id = derivePluginId(packageName);
  return {
    packageName,
    id,
    version: VERSION,
    kit: { tools: builtinTools as ToolDefinition[] },
  };
}

/**
 * Validate all `requires` declarations and detect circular dependencies.
 * Throws with a descriptive error on the first problem found.
 */
function validateRequires(
  kits: LoadedKit[],
  apparatuses: LoadedApparatus[],
): void {
  const apparatusIds = new Set(apparatuses.map((a) => a.id));
  const allIds = new Set([
    ...kits.map((k) => k.id),
    ...apparatuses.map((a) => a.id),
  ]);

  // Check apparatus requires
  for (const app of apparatuses) {
    for (const dep of app.apparatus.requires ?? []) {
      if (!allIds.has(dep)) {
        throw new Error(
          `[arbor] "${app.id}" requires "${dep}", which is not installed.`,
        );
      }
    }
  }

  // Check kit requires (must be apparatus names — kits can't depend on kits)
  for (const kit of kits) {
    for (const dep of kit.kit.requires ?? []) {
      if (!apparatusIds.has(dep)) {
        if (!allIds.has(dep)) {
          throw new Error(
            `[arbor] kit "${kit.id}" requires "${dep}", which is not installed.`,
          );
        }
        throw new Error(
          `[arbor] kit "${kit.id}" requires "${dep}", but that plugin is a kit, not an apparatus. ` +
          `Kit requires must name apparatus plugins.`,
        );
      }
    }
  }

  // Detect circular dependencies among apparatuses
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, chain: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...chain, id].join(' → ');
      throw new Error(`[arbor] Circular dependency detected: ${cycle}`);
    }
    visiting.add(id);
    const app = apparatuses.find((a) => a.id === id);
    if (app) {
      for (const dep of app.apparatus.requires ?? []) {
        visit(dep, [...chain, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const app of apparatuses) {
    visit(app.id, []);
  }
}

/**
 * Sort apparatuses in dependency-resolved order using topological sort.
 * validateRequires() must be called first to ensure the graph is acyclic.
 */
function topoSort(apparatuses: LoadedApparatus[]): LoadedApparatus[] {
  const sorted: LoadedApparatus[] = [];
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    const app = apparatuses.find((a) => a.id === id);
    if (!app) return;
    for (const dep of app.apparatus.requires ?? []) {
      visit(dep);
    }
    visited.add(id);
    sorted.push(app);
  }

  for (const app of apparatuses) {
    visit(app.id);
  }

  return sorted;
}

/**
 * Build a GuildContext scoped to a specific apparatus.
 * ctx.apparatus() validates the call against the apparatus's requires list.
 */
function buildGuildContext(
  forApparatus:  LoadedApparatus,
  manifest:      GuildManifest,
  guildRoot:     string,
  config:        GuildConfigV2,
  eventHandlers: Map<string, Array<(...args: unknown[]) => void | Promise<void>>>,
): GuildContext {
  const allowed = new Set(forApparatus.apparatus.requires ?? []);

  return {
    home: guildRoot,

    config<T = Record<string, unknown>>(pluginId?: string): T {
      const key = pluginId ?? forApparatus.id;
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[key] ?? {}) as T;
    },

    guildConfig() {
      return config;
    },

    apparatus<T>(name: string): T {
      if (!allowed.has(name)) {
        throw new Error(
          `[arbor] "${forApparatus.id}" called ctx.apparatus("${name}") without declaring ` +
          `it in requires. Add "${name}" to this apparatus's requires array.`,
        );
      }
      const provides = manifest.provides.get(name);
      if (provides === undefined) {
        // Return a sentinel that throws on access
        return new Proxy({} as T, {
          get(_target, prop) {
            throw new Error(
              `[arbor] ctx.apparatus("${name}") has no provides. ` +
              `Accessing .${String(prop)} is not available.`,
            );
          },
        });
      }
      return provides as T;
    },

    kits()        { return [...manifest.kits] },
    apparatuses() { return [...manifest.apparatuses] },
    plugins()     { return [...manifest.kits, ...manifest.apparatuses] },

    on(event: string, handler: (...args: unknown[]) => void | Promise<void>) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
  };
}

/**
 * Fire a lifecycle event, awaiting each handler sequentially.
 */
async function fireEvent(
  eventHandlers: Map<string, Array<(...args: unknown[]) => void | Promise<void>>>,
  event:         string,
  ...args: unknown[]
): Promise<void> {
  const handlers = eventHandlers.get(event) ?? [];
  for (const h of handlers) {
    await h(...args);
  }
}

/**
 * Emit advisory warnings for kit contributions that no apparatus consumes,
 * and for missing recommended apparatuses.
 */
function emitStartupWarnings(
  kits:        LoadedKit[],
  apparatuses: LoadedApparatus[],
): void {
  const consumedTypes = new Set<string>();
  const installedIds  = new Set(apparatuses.map((a) => a.id));

  for (const app of apparatuses) {
    for (const token of app.apparatus.consumes ?? []) {
      consumedTypes.add(token);
    }
  }

  for (const kit of kits) {
    // Check recommends
    for (const rec of kit.kit.recommends ?? []) {
      if (!installedIds.has(rec)) {
        console.warn(
          `[arbor] warn: "${kit.id}" recommends "${rec}" but it is not installed.`,
        );
      }
    }

    // Check contribution types against consumes
    for (const key of Object.keys(kit.kit)) {
      if (key === 'requires' || key === 'recommends') continue;
      if (!consumedTypes.has(key)) {
        console.warn(
          `[arbor] warn: "${kit.id}" contributes "${key}" but no installed apparatus declares consumes: ["${key}"]`,
        );
      }
    }
  }
}

/**
 * Extract Tool[] from a LoadedKit, annotating with pluginId.
 */
function extractTools(pluginId: string, kit: Kit): Tool[] {
  const rawTools = (kit as Record<string, unknown>).tools;
  if (!Array.isArray(rawTools)) return [];
  return rawTools
    .filter(isToolDefinition)
    .map((t) => ({ ...t, pluginId }) as Tool);
}

/**
 * Load all installed plugins, start apparatuses, and return the manifest.
 */
async function loadAndStart(
  guildRoot: string,
  config:    GuildConfigV2,
  db:        BooksDatabase,
): Promise<GuildManifest> {
  const kits:        LoadedKit[]        = [arborKit()];
  const apparatuses: LoadedApparatus[]  = [];
  const eventHandlers = new Map<
    string,
    Array<(...args: unknown[]) => void | Promise<void>>
  >();

  // ── Load phase ─────────────────────────────────────────────────────

  for (const pluginId of config.plugins) {
    const packageName = resolvePackageNameForPluginId(guildRoot, pluginId);
    if (!packageName) {
      console.warn(`[arbor] No package found in package.json for plugin "${pluginId}" — skipping`);
      continue;
    }

    const { version } = readGuildPackageJson(guildRoot, packageName);

    try {
      const entryPath = resolveGuildPackageEntry(guildRoot, packageName);
      const mod = await import(entryPath) as { default: unknown };
      const raw = mod.default;

      if (isApparatus(raw)) {
        apparatuses.push({ packageName, id: pluginId, version, apparatus: raw.apparatus });
      } else if (isKit(raw)) {
        kits.push({ packageName, id: pluginId, version, kit: raw.kit });
      } else {
        // Legacy export format (bare tool, array, or { tools: [...] }) —
        // wrap in a synthetic kit so it participates in the plugin model.
        const tools = resolveAllToolsFromExport(raw);
        kits.push({
          packageName,
          id:      pluginId,
          version,
          kit:     { tools },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[arbor] Failed to load plugin "${packageName}": ${message}`);
    }
  }

  // ── Validation phase ───────────────────────────────────────────────

  validateRequires(kits, apparatuses);

  // ── Startup warnings ───────────────────────────────────────────────

  emitStartupWarnings(kits, apparatuses);

  // ── Start phase ────────────────────────────────────────────────────

  const orderedApparatuses = topoSort(apparatuses);
  const provides = new Map<string, unknown>();

  const manifest: GuildManifest = {
    kits,
    apparatuses: orderedApparatuses,
    tools: [],
    provides,
  };

  // Fire plugin:initialized for all kits before starting any apparatus
  for (const kit of kits) {
    await fireEvent(eventHandlers, 'plugin:initialized', kit);
  }

  // Start each apparatus in dependency order
  for (const app of orderedApparatuses) {
    // Register provides before start() so apparatuses that declare provides can
    // populate the object from within start() and it's visible to later startups.
    if (app.apparatus.provides !== undefined) {
      provides.set(app.id, app.apparatus.provides);
    }

    const ctx = buildGuildContext(app, manifest, guildRoot, config, eventHandlers);
    await app.apparatus.start(ctx);

    await fireEvent(eventHandlers, 'plugin:initialized', app);
  }

  // ── Books reconciliation (transitional) ───────────────────────────
  // Scans kit `books` contribution fields and ensures SQLite tables/indexes
  // exist. Moves to the nexus-books apparatus when that ships.

  await reconcileBooks(db, kits);

  // ── Build flat tool list ──────────────────────────────────────────

  const allTools: Tool[] = [];

  for (const kit of kits) {
    allTools.push(...extractTools(kit.id, kit.kit));
    // Also extract from apparatus supportKits where applicable
  }
  for (const app of orderedApparatuses) {
    if (app.apparatus.supportKit) {
      allTools.push(...extractTools(app.id, app.apparatus.supportKit));
    }
  }

  manifest.tools = allTools;

  return manifest;
}

/**
 * Create an Arbor for the given guild root.
 *
 * Reads guild.json synchronously. Plugin modules are loaded and apparatuses
 * started lazily on first access to any listing method, then cached.
 *
 * @param guildRoot - Absolute path to the guild root (contains guild.json).
 */
export function createArbor(guildRoot: string): Arbor {
  const config = readGuildConfigV2(guildRoot);

  // Lazy manifest — a single Promise shared across all callers.
  // `resolvedManifest` is set synchronously once the Promise resolves,
  // enabling synchronous access inside HandlerContext.apparatus().
  let manifestPromise:  Promise<GuildManifest> | null = null;
  let resolvedManifest: GuildManifest | null = null;

  // Lazy database — opened on first call, reused for the process lifetime.
  let db: BooksDatabase | null = null;

  function getDatabase(): BooksDatabase {
    if (!db) {
      db = openBooksDatabase(guildRoot);
    }
    return db;
  }

  function getManifest(): Promise<GuildManifest> {
    if (!manifestPromise) {
      manifestPromise = loadAndStart(guildRoot, config, getDatabase()).then((m) => {
        resolvedManifest = m;
        return m;
      });
    }
    return manifestPromise;
  }

  const arbor: Arbor = {
    home: guildRoot,

    getGuildConfig() {
      return config;
    },

    async listKits() {
      return (await getManifest()).kits;
    },

    async listApparatuses() {
      return (await getManifest()).apparatuses;
    },

    async listPlugins() {
      const m = await getManifest();
      return [...m.kits, ...m.apparatuses];
    },

    async findPlugin(name: string) {
      const m      = await getManifest();
      const target = name.startsWith('@') ? derivePluginId(name) : name;
      const all    = [...m.kits, ...m.apparatuses];
      return all.find(
        (p) => p.id === target || p.packageName === name,
      ) ?? null;
    },

    async listTools(options?: ListToolsOptions) {
      const m = await getManifest();
      let tools = m.tools;

      if (options?.channel) {
        const channel = options.channel;
        tools = tools.filter(
          (t) => !t.callableFrom || t.callableFrom.includes(channel),
        );
      }

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
      const m = await getManifest();
      return m.tools.find((t) => t.name === name) ?? null;
    },

    createHandlerContext(owningPluginId?: string): HandlerContext {
      return {
        home: guildRoot,

        config<T = Record<string, unknown>>(pluginId?: string): T {
          const key = pluginId ?? owningPluginId;
          if (!key) return {} as T;
          const cfg = config as unknown as Record<string, unknown>;
          return (cfg[key] ?? {}) as T;
        },

        guildConfig() {
          return config;
        },

        apparatus<T>(name: string): T {
          if (!resolvedManifest) {
            throw new Error(
              `[arbor] ctx.apparatus("${name}") called before plugins were loaded. ` +
              `Ensure listPlugins() or listTools() has been awaited before invoking handlers.`,
            );
          }
          const provides = resolvedManifest.provides.get(name);
          if (provides === undefined) {
            return new Proxy({} as T, {
              get(_target, prop) {
                throw new Error(
                  `[arbor] ctx.apparatus("${name}") has no provides. ` +
                  `Accessing .${String(prop)} is not available. ` +
                  `Does "${name}" declare a provides object?`,
                );
              },
            });
          }
          return provides as T;
        },
      };
    },

    getDatabase,
  };

  return arbor;
}
