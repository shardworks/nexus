/**
 * Guild accessor — the process-level singleton for accessing guild infrastructure.
 *
 * Plugin code (tools, engines, relays, CDC handlers) imports `guild()` to access
 * apparatus APIs, plugin config, and the guild root path. Arbor populates the
 * accessor at startup via `setGuildAccessor()`.
 *
 * This replaces the HandlerContext injection pattern — handlers no longer receive
 * context as a parameter. They call `guild()` directly.
 *
 * See: docs/architecture/plugins.md
 */

import type { GuildConfig } from './guild-config.ts';

// ── Interface ──────────────────────────────────────────────────────────

/**
 * Runtime access to guild infrastructure.
 *
 * Available after Arbor startup completes. One instance per process.
 */
export interface GuildAccessor {
  /** Absolute path to the guild root (contains guild.json). */
  readonly home: string

  /**
   * Retrieve a started apparatus's provides object by plugin id.
   *
   * Throws if the apparatus is not installed or has no `provides`.
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
   * Read the full parsed guild.json.
   *
   * Escape hatch for framework-level fields (name, nexus, plugins,
   * settings) that don't belong to any specific plugin.
   */
  guildConfig(): GuildConfig
}

// ── Singleton ──────────────────────────────────────────────────────────

let _accessor: GuildAccessor | null = null;

/**
 * Get the active guild accessor.
 *
 * Throws with a clear message if called before Arbor has initialized
 * the guild (e.g. at module import time, before startup completes).
 */
export function guild(): GuildAccessor {
  if (!_accessor) {
    throw new Error(
      'Guild not initialized — guild() called before Arbor startup. ' +
      'Ensure guild() is called inside a handler, not at module scope.',
    );
  }
  return _accessor;
}

/**
 * Set the guild accessor. Called by Arbor at startup.
 *
 * Not for plugin use — this is framework infrastructure.
 */
export function setGuildAccessor(accessor: GuildAccessor): void {
  _accessor = accessor;
}

/**
 * Clear the guild accessor. Called by Arbor at shutdown or in tests.
 *
 * Not for plugin use — this is framework infrastructure.
 */
export function clearGuildAccessor(): void {
  _accessor = null;
}
