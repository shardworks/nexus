/**
 * Arbor — the guild runtime.
 *
 * `createGuild()` is the single entry point. It reads guild.json, loads all
 * declared plugins, validates dependencies, starts apparatus in order, wires
 * the guild() singleton, and returns the Guild object.
 *
 * The full plugin lifecycle:
 *   1. Load    — imports all declared plugin packages, discriminates kit vs apparatus
 *   2. Validate — checks `requires` declarations, detects circular dependencies
 *   3. Start   — calls start(ctx) on each apparatus in dependency-resolved order
 *   4. Events  — fires `plugin:initialized` after each plugin loads
 *   5. Warn    — advisory warnings for mismatched kit contributions / recommends
 *
 * Pure logic (validation, ordering, events) lives in guild-lifecycle.ts.
 * This file handles I/O and orchestration.
 */

import {
  readGuildConfig,
  findGuildRoot,
  isKit,
  isApparatus,
  setGuild,
  resolveGuildPackageEntry,
  resolvePackageNameForPluginId,
  readGuildPackageJson,
} from '@shardworks/nexus-core';
import type {
  Guild,
  LoadedKit,
  LoadedApparatus,
} from '@shardworks/nexus-core';

import {
  validateRequires,
  topoSort,
  collectStartupWarnings,
  buildStartupContext,
  fireEvent,
} from './guild-lifecycle.ts';
import type { EventHandlerMap } from './guild-lifecycle.ts';

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create and start a guild.
 *
 * Reads guild.json, loads all declared plugins, validates dependencies,
 * starts apparatus in dependency order, and returns the Guild object.
 * Also sets the guild() singleton so apparatus code can access it.
 *
 * @param root - Absolute path to the guild root. Defaults to auto-detection
 *               by walking up from cwd until guild.json is found.
 * @returns The initialized Guild — the same object guild() returns.
 */
export async function createGuild(root?: string): Promise<Guild> {
  const guildRoot = root ?? findGuildRoot();
  const config = readGuildConfig(guildRoot);

  const kits:        LoadedKit[]        = [];
  const apparatuses: LoadedApparatus[]  = [];
  const eventHandlers: EventHandlerMap = new Map();

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
        console.warn(
          `[arbor] Plugin "${packageName}" does not export a kit or apparatus — skipping. ` +
          `Plugins must export { kit: ... } or { apparatus: ... }.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[arbor] Failed to load plugin "${packageName}": ${message}`);
    }
  }

  // ── Validation phase ───────────────────────────────────────────────

  validateRequires(kits, apparatuses);

  // ── Startup warnings ───────────────────────────────────────────────

  for (const warning of collectStartupWarnings(kits, apparatuses)) {
    console.warn(warning);
  }

  // ── Start phase ────────────────────────────────────────────────────

  const orderedApparatuses = topoSort(apparatuses);
  const provides = new Map<string, unknown>();

  // Wire guild singleton before any apparatus starts so start() methods
  // can call guild(). The provides Map is populated progressively as each
  // apparatus starts; dependency ordering guarantees declared deps are
  // available.

  const guildInstance: Guild = {
    home: guildRoot,

    apparatus<T>(name: string): T {
      const p = provides.get(name);
      if (p === undefined) {
        throw new Error(
          `[guild] apparatus("${name}") is not available. ` +
          `No loaded apparatus provides this id. Check guild.json plugins list.`,
        );
      }
      return p as T;
    },

    config<T = Record<string, unknown>>(pluginId: string): T {
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[pluginId] ?? {}) as T;
    },

    guildConfig() {
      return config;
    },

    kits()        { return [...kits]; },
    apparatuses() { return [...orderedApparatuses]; },
  };
  setGuild(guildInstance);

  // Fire plugin:initialized for all kits before starting any apparatus
  for (const kit of kits) {
    await fireEvent(eventHandlers, 'plugin:initialized', kit);
  }

  // Start each apparatus in dependency order
  const startupCtx = buildStartupContext(eventHandlers);
  for (const app of orderedApparatuses) {
    // Register provides before start() so apparatuses that declare provides can
    // populate the object from within start() and it's visible to later startups.
    if (app.apparatus.provides !== undefined) {
      provides.set(app.id, app.apparatus.provides);
    }

    await app.apparatus.start(startupCtx);

    await fireEvent(eventHandlers, 'plugin:initialized', app);
  }

  return guildInstance;
}
