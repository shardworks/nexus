/**
 * Guild — the process-level singleton for accessing guild infrastructure.
 *
 * All plugin code — apparatus start(), tool handlers, engine handlers,
 * relay handlers, CDC handlers — imports `guild()` to access apparatus APIs,
 * plugin config, the guild root path, and the loaded plugin graph.
 *
 * Arbor creates the Guild instance before starting apparatus and registers
 * it via `setGuild()`. The instance is backed by live data structures
 * (e.g. the provides Map) that are populated progressively as apparatus start.
 *
 * See: docs/architecture/plugins.md
 */

import type { GuildConfig } from './guild-config.ts';
import type { LoadedKit, LoadedApparatus, FailedPlugin } from './plugin.ts';

// ── Interface ──────────────────────────────────────────────────────────

/**
 * Runtime access to guild infrastructure.
 *
 * Available after Arbor creates the instance (before apparatus start).
 * One instance per process.
 */
export interface Guild {
  /** Absolute path to the guild root (contains guild.json). */
  readonly home: string

  /**
   * Retrieve a started apparatus's provides object by plugin id.
   *
   * Throws if the apparatus is not installed or has no `provides`.
   * During startup, only apparatus that have already started are visible
   * (dependency ordering guarantees declared deps are started first).
   */
  apparatus<T>(name: string): T

  /**
   * Read a plugin's configuration section from guild.json.
   *
   * Returns `guild.json[pluginId]` cast to `T`. Returns `{}` if no
   * section exists. The generic parameter is a cast — the framework
   * does not validate config shape.
   */
  config<T = Record<string, unknown>>(pluginId: string): T

  /**
   * Write a plugin's configuration section to guild.json.
   *
   * Updates `guild.json[pluginId]` with `value` and writes the file
   * to disk. Also updates the in-memory config so subsequent reads
   * reflect the change.
   *
   * For framework-level keys (name, nexus, plugins, settings), use
   * the standalone `writeGuildConfig()` function instead.
   */
  writeConfig<T = Record<string, unknown>>(pluginId: string, value: T): void

  /**
   * Read the full parsed guild.json.
   *
   * Escape hatch for framework-level fields (name, nexus, plugins,
   * settings) that don't belong to any specific plugin.
   */
  guildConfig(): GuildConfig

  /** Snapshot of all loaded kits (including apparatus supportKits). */
  kits(): LoadedKit[]

  /** Snapshot of all started apparatuses. */
  apparatuses(): LoadedApparatus[]

  /** Snapshot of plugins that failed to load, validate, or start. */
  failedPlugins(): FailedPlugin[]
}

// ── Singleton ──────────────────────────────────────────────────────────

let _guild: Guild | null = null;

/**
 * Get the active guild instance.
 *
 * Throws with a clear message if called before Arbor has initialized
 * the guild (e.g. at module import time, before startup begins).
 */
export function guild(): Guild {
  if (!_guild) {
    throw new Error(
      'Guild not initialized — guild() called before Arbor startup. ' +
      'Ensure guild() is called inside a handler or start(), not at module scope.',
    );
  }
  return _guild;
}

/**
 * Set the guild instance. Called by Arbor before starting apparatus.
 *
 * Not for plugin use — this is framework infrastructure.
 */
export function setGuild(g: Guild): void {
  _guild = g;
}

/**
 * Clear the guild instance. Called by Arbor at shutdown or in tests.
 *
 * Not for plugin use — this is framework infrastructure.
 */
export function clearGuild(): void {
  _guild = null;
}
