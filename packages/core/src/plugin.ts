/**
 * Plugin system — core types for the Kit/Apparatus model.
 *
 * Plugins come in two kinds:
 * - Kit:       passive package contributing capabilities to consuming apparatuses.
 *              No lifecycle, no running state. Read at load time.
 * - Apparatus: package contributing persistent running infrastructure.
 *              Has a start/stop lifecycle. Receives GuildContext at start.
 *
 * See: docs/architecture/plugins.md
 */

import type { GuildConfigV2 } from './guild-config.ts';

// ── Loaded plugin descriptors ──────────────────────────────────────────

/** A kit as tracked by the Arbor runtime. */
export interface LoadedKit {
  readonly packageName: string
  readonly id:          string
  readonly version:     string
  readonly kit:         Kit
}

/** An apparatus as tracked by the Arbor runtime. */
export interface LoadedApparatus {
  readonly packageName: string
  readonly id:          string
  readonly version:     string
  readonly apparatus:   Apparatus
}

/** Union of loaded kit and loaded apparatus. */
export type LoadedPlugin = LoadedKit | LoadedApparatus

// ── Context types ──────────────────────────────────────────────────────

/**
 * Context passed to an apparatus's start(ctx). Provides access to the
 * plugin graph during startup wiring.
 */
export interface GuildContext {
  /** Absolute path to the guild root. */
  home: string
  /**
   * Get the plugin-specific config section from guild.json.
   * Called with no args returns the section for the calling apparatus.
   * Called with a pluginId returns that plugin's section.
   * Returns `{}` if the section is absent.
   */
  config<T = Record<string, unknown>>(pluginId?: string): T
  /** Get the full parsed guild.json config. */
  guildConfig(): GuildConfigV2
  /**
   * Retrieve a started apparatus's provides object.
   * Validated against the calling apparatus's requires at startup.
   */
  apparatus<T>(name: string): T
  /** Snapshot of all loaded kits (including apparatus supportKits). */
  kits():        LoadedKit[]
  /** Snapshot of all started apparatuses. */
  apparatuses(): LoadedApparatus[]
  /** Union snapshot of all loaded plugins. */
  plugins():     LoadedPlugin[]
  /** Subscribe to a guild lifecycle event. Handlers may be async; run sequentially. */
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void
}

/**
 * Context injected into tool and engine handlers at invocation time.
 * Distinct from GuildContext — handlers run long after startup.
 */
export interface HandlerContext {
  /** Absolute path to the guild root. */
  home: string
  /**
   * Get the plugin-specific config section from guild.json.
   * Called with no args returns the section for the owning plugin.
   * Called with a pluginId returns that plugin's section.
   * Returns `{}` if the section is absent.
   */
  config<T = Record<string, unknown>>(pluginId?: string): T
  /** Get the full parsed guild.json config. */
  guildConfig(): GuildConfigV2
  /** Retrieve a started apparatus's provides object. */
  apparatus<T>(name: string): T
}

// ── Kit ────────────────────────────────────────────────────────────────

/**
 * A kit — passive package contributing capabilities to consuming apparatuses.
 * Open record: contribution fields (engines, relays, tools, etc.) are defined
 * by the apparatus packages that consume them. `requires` and `recommends` are
 * the only framework-level fields.
 *
 * `requires`: apparatus names whose runtime APIs this kit's contributions depend
 *   on at handler invocation time. Hard startup validation failure if a declared
 *   apparatus is not installed.
 *
 * `recommends`: advisory apparatus names — generates startup warnings when
 *   expected apparatuses are absent. Not enforced.
 */
export type Kit = {
  requires?:   string[]
  recommends?: string[]
  [key: string]: unknown
}

// ── Apparatus ─────────────────────────────────────────────────────────

/**
 * An apparatus — package contributing persistent running infrastructure.
 * Has a start/stop lifecycle. Receives GuildContext at start.
 *
 * `requires`: apparatus names that must be started before this apparatus's
 *   start() runs. Determines start ordering. Hard startup validation failure
 *   if a declared apparatus is not installed.
 *
 * `provides`: the runtime API object this apparatus exposes to other plugins.
 *   Retrieved via ctx.apparatus<T>(name). Created at manifest-definition time,
 *   populated during start.
 *
 * `supportKit`: kit contributions this apparatus exposes to consuming apparatuses.
 *   Treated identically to standalone kit contributions by consumers.
 *
 * `consumes`: kit contribution field types this apparatus scans for and registers.
 *   Enables framework startup warnings when kits contribute types with no consumer.
 */
export type Apparatus = {
  requires?:   string[]
  provides?:   unknown
  start:       (ctx: GuildContext) => void | Promise<void>
  stop?:       () => void | Promise<void>
  supportKit?: Kit
  consumes?:   string[]
}

// ── Plugin ─────────────────────────────────────────────────────────────

/**
 * The discriminated union plugin type. A plugin is either a kit or an apparatus.
 * The plugin name is always inferred from the npm package name at load time —
 * it is never declared in the manifest.
 */
export type Plugin =
  | { kit:       Kit }
  | { apparatus: Apparatus }

// ── Type guards ────────────────────────────────────────────────────────

/** Type guard: is this value a kit plugin export? */
export function isKit(obj: unknown): obj is { kit: Kit } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'kit' in obj &&
    typeof (obj as { kit: unknown }).kit === 'object' &&
    (obj as { kit: unknown }).kit !== null &&
    !Array.isArray((obj as { kit: unknown }).kit)
  )
}

/** Type guard: is this value an apparatus plugin export? */
export function isApparatus(obj: unknown): obj is { apparatus: Apparatus } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'apparatus' in obj &&
    typeof (obj as { apparatus: unknown }).apparatus === 'object' &&
    (obj as { apparatus: unknown }).apparatus !== null &&
    typeof (
      (obj as { apparatus: Record<string, unknown> }).apparatus.start
    ) === 'function'
  )
}

/** Type guard: narrows a LoadedPlugin to LoadedKit. */
export function isLoadedKit(p: LoadedPlugin): p is LoadedKit {
  return 'kit' in p
}

/** Type guard: narrows a LoadedPlugin to LoadedApparatus. */
export function isLoadedApparatus(p: LoadedPlugin): p is LoadedApparatus {
  return 'apparatus' in p
}
