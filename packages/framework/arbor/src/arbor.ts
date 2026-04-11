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
 *   3. Warn    — advisory warnings for mismatched kit contributions / recommends
 *   4. Wire    — collects all kit contributions (kits + supportKits) into KitEntry[]
 *   5. Start   — calls start(ctx) on each apparatus in dependency-resolved order;
 *                ctx.kits(type) returns Wire-phase entries; fires `apparatus:started`
 *                after each apparatus; fires `phase:started` when all are done
 *
 * Pure logic (validation, ordering, events) lives in guild-lifecycle.ts.
 * This file handles I/O and orchestration.
 */

import { pathToFileURL } from "node:url";
import {
  readGuildConfig,
  writeGuildConfig,
  findGuildRoot,
  isKit,
  isApparatus,
  setGuild,
  resolveGuildPackageEntry,
  resolvePackageNameForPluginId,
  readGuildPackageJson,
} from "@shardworks/nexus-core";
import type {
  Guild,
  LoadedKit,
  LoadedApparatus,
  FailedPlugin,
} from "@shardworks/nexus-core";

import {
  validateRequires,
  filterFailedPlugins,
  topoSort,
  collectStartupWarnings,
  buildStartupContext,
  fireEvent,
  wireKitEntries,
} from "./guild-lifecycle.ts";
import type { EventHandlerMap } from "./guild-lifecycle.ts";

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

  const kits: LoadedKit[] = [];
  const apparatuses: LoadedApparatus[] = [];
  const eventHandlers: EventHandlerMap = new Map();

  // ── Load phase ─────────────────────────────────────────────────────

  for (const pluginId of config.plugins) {
    const packageName = resolvePackageNameForPluginId(guildRoot, pluginId);
    if (!packageName) {
      console.warn(
        `[arbor] No package found in package.json for plugin "${pluginId}" — skipping`,
      );
      continue;
    }

    const { version } = readGuildPackageJson(guildRoot, packageName);

    try {
      const entryPath = resolveGuildPackageEntry(guildRoot, packageName);
      const entryUrl = pathToFileURL(entryPath).href;
      const mod = (await import(entryUrl)) as { default: unknown };
      const raw = mod.default;

      if (isApparatus(raw)) {
        apparatuses.push({
          packageName,
          id: pluginId,
          version,
          apparatus: raw.apparatus,
        });
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
      console.warn(
        `[arbor] Failed to load plugin "${packageName}": ${message}`,
      );
    }
  }

  // ── Validation phase ───────────────────────────────────────────────

  const allFailures: FailedPlugin[] = [];

  const rootFailures = validateRequires(kits, apparatuses);
  allFailures.push(...rootFailures);

  // Remove plugins that transitively depend on failed ones
  if (rootFailures.length > 0) {
    const filtered = filterFailedPlugins(kits, apparatuses, rootFailures);
    kits.length = 0;
    kits.push(...filtered.kits);
    apparatuses.length = 0;
    apparatuses.push(...filtered.apparatuses);
    allFailures.push(...filtered.cascaded);

    for (const f of allFailures) {
      console.warn(`[arbor] ${f.reason}`);
    }
  }

  // ── Startup warnings ───────────────────────────────────────────────

  const allWarnings = collectStartupWarnings(kits, apparatuses);
  for (const warning of allWarnings) {
    console.warn(warning);
  }

  // ── Start phase ────────────────────────────────────────────────────

  const orderedApparatuses = topoSort(apparatuses);
  const provides = new Map<string, unknown>();
  const startedApparatuses: LoadedApparatus[] = [];

  // ── Wire phase ─────────────────────────────────────────────────────
  // Collect all kit contributions before any apparatus starts.
  const kitEntries = wireKitEntries(kits, orderedApparatuses);

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
      // GuildConfig types only the framework-level keys (name, nexus, plugins, etc.).
      // Plugin-specific config sections (e.g. "animator", "stacks") are additional
      // top-level keys in guild.json that GuildConfig doesn't model. The cast is safe
      // because guild.json is a plain JSON object — all keys are accessible at runtime.
      // Plugins can use module augmentation on GuildConfig to get typed access; this
      // generic path remains the untyped fallback.
      const cfg = config as unknown as Record<string, unknown>;
      return (cfg[pluginId] ?? {}) as T;
    },

    writeConfig<T = Record<string, unknown>>(pluginId: string, value: T): void {
      // Update the in-memory config so subsequent reads reflect the change,
      // then persist to disk. The cast is the same pattern as config() above.
      const cfg = config as unknown as Record<string, unknown>;
      cfg[pluginId] = value;
      writeGuildConfig(guildRoot, config);
    },

    guildConfig() {
      return config;
    },

    kits() {
      return [...kits];
    },
    apparatuses() {
      return [...startedApparatuses];
    },
    failedPlugins() {
      return [...allFailures];
    },
    startupWarnings() {
      return [...allWarnings];
    },
  };
  setGuild(guildInstance);

  // Start each apparatus in dependency order
  const startupCtx = buildStartupContext(eventHandlers, kitEntries);
  for (const app of orderedApparatuses) {
    // Register provides before start() so apparatuses with eager provides are
    // visible to later startups that run during this loop.
    if (app.apparatus.provides !== undefined) {
      provides.set(app.id, app.apparatus.provides);
    }

    await app.apparatus.start(startupCtx);

    // Re-check after start() for deferred provides (e.g. Stacks uses a getter
    // that returns undefined until start() populates the backing variable).
    if (!provides.has(app.id) && app.apparatus.provides !== undefined) {
      provides.set(app.id, app.apparatus.provides);
    }

    // Add to started list BEFORE firing event
    startedApparatuses.push(app);

    // Fire apparatus:started (replaces plugin:initialized — no deprecation period)
    await fireEvent(eventHandlers, "apparatus:started", app);
  }

  // Fire phase:started after all apparatus start + events complete
  await fireEvent(eventHandlers, "phase:started");

  return guildInstance;
}
