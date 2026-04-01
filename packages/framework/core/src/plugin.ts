/**
 * Plugin system — core types for the Kit/Apparatus model.
 *
 * Plugins come in two kinds:
 * - Kit:       passive package contributing capabilities to consuming apparatuses.
 *              No lifecycle, no running state. Read at load time.
 * - Apparatus: package contributing persistent running infrastructure.
 *              Has a start/stop lifecycle. Receives StartupContext at start.
 *
 * See: docs/architecture/plugins.md
 */

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
 * Startup context passed to an apparatus's start(ctx).
 *
 * Provides lifecycle-event subscription — the only capability that is
 * meaningful only during startup. All other guild access (apparatus APIs,
 * config, home path, loaded plugins) goes through the `guild()` singleton,
 * which is available during start() and in all handlers.
 *
 * See: docs/architecture/plugins.md
 */
export interface StartupContext {
  /** Subscribe to a guild lifecycle event. Handlers may be async; run sequentially. */
  on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void
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
 * Has a start/stop lifecycle. Receives StartupContext at start.
 *
 * `requires`: apparatus names that must be started before this apparatus's
 *   start() runs. Determines start ordering. Hard startup validation failure
 *   if a declared apparatus is not installed.
 *
 * `recommends`: advisory apparatus names — generates startup warnings when
 *   expected apparatuses are absent. Not enforced — the apparatus starts
 *   regardless. Use for soft dependencies needed by optional API methods
 *   (e.g. The Animator recommends The Loom for summon(), but animate()
 *   works without it).
 *
 * `provides`: the runtime API object this apparatus exposes to other plugins.
 *   Retrieved via guild().apparatus<T>(name). Created at manifest-definition time,
 *   populated during start.
 *
 * `supportKit`: kit contributions this apparatus exposes to consuming apparatuses.
 *   Treated identically to standalone kit contributions by consumers.
 *
 * `consumes`: kit contribution field types this apparatus scans for and registers.
 *   Enables framework startup warnings when kits contribute types with no consumer.
 */
export type Apparatus = {
  requires?:    string[]
  recommends?:  string[]
  provides?:    unknown
  start:        (ctx: StartupContext) => void | Promise<void>
  stop?:        () => void | Promise<void>
  supportKit?:  Kit
  consumes?:    string[]
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
