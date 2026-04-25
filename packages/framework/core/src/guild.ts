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
 * The `Guild` interface is the contract plugin code sees — it deliberately
 * does not expose `shutdown()`. Lifecycle teardown is the responsibility
 * of the bootstrapping process (the CLI, a daemon entry point, a one-shot
 * helper) that called `createGuild()`. That caller receives a
 * `StartedGuild` (a `Guild` plus a `shutdown()` method) and is expected
 * to invoke it before exit. See `StartedGuild` and `clearGuild()` below.
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
 * One instance per process. Plugin code only ever sees this narrow
 * interface — `shutdown()` is intentionally not part of it. The
 * bootstrap caller of `createGuild()` receives the richer
 * `StartedGuild` and owns the shutdown lifecycle.
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

  /** Snapshot of all loaded standalone kit plugins. Does not include apparatus supportKits. */
  kits(): LoadedKit[]

  /** Snapshot of all started apparatuses. */
  apparatuses(): LoadedApparatus[]

  /** Snapshot of plugins that failed to load, validate, or start. */
  failedPlugins(): FailedPlugin[]

  /** Advisory warnings collected during guild startup (missing recommends, unconsumed contributions). */
  startupWarnings(): string[]
}

/**
 * Extension of {@link Guild} returned by `createGuild()` — adds the
 * `shutdown()` method that drives reverse-topo apparatus teardown.
 *
 * The `Guild` interface is what plugin code sees through the
 * process-level singleton; `shutdown()` is deliberately not exposed
 * there because plugin code has no legitimate reason to tear down the
 * guild it is running inside. The bootstrap caller of `createGuild()`
 * — a CLI command, a daemon entry point, or a one-shot helper —
 * receives this richer type and is responsible for invoking
 * `shutdown()` on the way out.
 *
 * `shutdown()` invokes every started apparatus's optional `stop()` in
 * reverse topological order, fires the `guild:shutdown` lifecycle
 * event before any `stop()` runs, collects per-apparatus errors and
 * surfaces them as a single aggregate (continuing iteration even when
 * one throws), is idempotent under repeated calls, and clears the
 * `guild()` singleton as its last act so subsequent `guild()` calls
 * fail loudly with the existing "Guild not initialized" error rather
 * than handing out stale references to apparatus whose handles are
 * already gone.
 */
export interface StartedGuild extends Guild {
  /**
   * Tear the guild down: fire `guild:shutdown`, call `stop()` on every
   * started apparatus in reverse topological order, then clear the
   * `guild()` singleton.
   *
   * Idempotent — second and subsequent calls return immediately.
   *
   * If one or more `stop()` invocations throw, every remaining
   * apparatus is still attempted; once iteration completes, an
   * aggregate `Error` is thrown summarising each failure. The
   * singleton is cleared regardless of whether any `stop()` threw.
   */
  shutdown(): Promise<void>
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
 * Clear the guild instance.
 *
 * Called as the last act of `StartedGuild.shutdown()` after every
 * apparatus's optional `stop()` has run, so subsequent `guild()` calls
 * fail loudly with the "Guild not initialized" error rather than
 * handing out stale references to apparatus whose handles are gone.
 * Tests call it directly to reset between cases.
 *
 * Not for plugin use — this is framework infrastructure. Plugin code
 * should never need to tear the guild down.
 */
export function clearGuild(): void {
  _guild = null;
}
