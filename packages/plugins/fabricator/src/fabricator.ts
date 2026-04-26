/**
 * The Fabricator — guild engine design registry apparatus.
 *
 * Scans installed engine designs from kit contributions and apparatus supportKits,
 * and serves them to the Spider on demand.
 *
 * The Fabricator does not execute engines. It is a pure query service:
 * designs in, designs out.
 */

import type {
  StartupContext,
  Plugin,
} from '@shardworks/nexus-core';

// ── Public types ──────────────────────────────────────────────────────

/** Minimal execution context passed to an engine's run() method. */
export interface EngineRunContext {
  /** The rig this engine instance belongs to. */
  rigId: string;
  /** Simple string identity for this engine instance (e.g. 'draft', 'implement'). */
  engineId: string;
  /** All upstream yields, keyed by engine id. Escape hatch for engines that need to inspect the full upstream chain. */
  upstream: Record<string, unknown>;
  /**
   * Present when this engine was previously blocked and has been restarted.
   * Advisory — do not depend on for correctness.
   *
   * Note: Defined inline to avoid a circular package dependency with spider-apparatus.
   * Shape matches spider-apparatus BlockRecord exactly.
   */
  priorBlock?: {
    type: string;
    condition: unknown;
    blockedAt: string;
    message?: string;
    lastCheckedAt?: string;
  };
}

/**
 * The result of an engine run.
 *
 * 'completed' — synchronous work done inline, yields are available immediately.
 * 'launched'  — async work launched in a session; the Spider polls for completion.
 * 'blocked'   — engine is waiting for an external condition; Spider will poll
 *               the registered block type's checker and restart when cleared.
 */
export type EngineRunResult =
  | { status: 'completed'; yields: unknown }
  | { status: 'launched'; sessionId: string }
  | { status: 'blocked'; blockType: string; condition: unknown; message?: string };

/**
 * Back-off growth parameters for an engine's retry policy. Matches
 * the shape Animator uses for its rate-limit back-off:
 *   - initialMs — first hold window in milliseconds
 *   - maxMs    — cap on the hold window in milliseconds
 *   - factor   — growth multiplier per consumed attempt
 */
export interface EngineRetryBackoffConfig {
  initialMs: number;
  maxMs: number;
  factor: number;
}

/**
 * Opt-in retry policy for an engine design. When absent, the effective
 * policy is `maxAttempts: 0` — the engine fails terminally on the first
 * transient error with no retry. Explicit config enables retry.
 *
 * The Spider validates this shape at engine-design registration time
 * (see `validateEngineRetryConfig`); malformed values throw at startup.
 */
export interface EngineRetryConfig {
  /**
   * Total retry budget. `0` means fail-fast (no retry). `1` means one
   * retry (so up to two attempts total). Matches the "attempts consumed
   * from budget" semantics.
   */
  maxAttempts: number;
  /** Back-off growth parameters. Optional; defaults applied when omitted. */
  backoff?: Partial<EngineRetryBackoffConfig>;
}

/**
 * An engine design — the unit of work the Fabricator catalogues and the
 * Spider executes. Kit authors import this type from @shardworks/fabricator-apparatus.
 */
export interface EngineDesign {
  /** Unique identifier for this engine design (e.g. 'draft', 'implement', 'review'). */
  id: string;

  /**
   * Execute this engine.
   *
   * @param givens   — the engine's declared inputs, assembled by the Spider.
   * @param context  — minimal execution context: engine id and upstream yields.
   */
  run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult>;

  /**
   * Assemble yields from a completed session.
   *
   * Called by the Spider's collect step when a quick engine's session
   * reaches a terminal state. The engine looks up whatever it needs
   * via guild() — same dependency pattern as run().
   *
   * @param sessionId — the session to collect yields from (primary input).
   * @param givens    — same givens that were passed to run().
   * @param context   — same execution context that was passed to run().
   *
   * If not defined, the Spider uses a generic default:
   *   { sessionId, sessionStatus, output? }
   *
   * Only relevant for quick engines (those that return { status: 'launched' }).
   * Clockwork engines return yields directly from run().
   */
  collect?(sessionId: string, givens: Record<string, unknown>, context: EngineRunContext): Promise<unknown>;

  /**
   * Opt-in retry policy. When absent, the engine has no retry budget
   * (effectively `maxAttempts: 0`). Validated at registration — a
   * malformed block throws at startup.
   */
  retry?: EngineRetryConfig;
}

// ── Retry config defaults and validation ──────────────────────────────

/**
 * Default back-off values applied when a retry-enabled engine design
 * omits explicit back-off. Chosen short — retry is a rig-local mechanism,
 * not a long-term scheduler. 30s initial, 10m cap, 2x growth.
 */
export const DEFAULT_ENGINE_RETRY_BACKOFF: EngineRetryBackoffConfig = Object.freeze({
  initialMs: 30_000,
  maxMs: 600_000,
  factor: 2,
}) as EngineRetryBackoffConfig;

/**
 * Validate a retry config fail-loud at registration time. Fills in
 * default back-off values for fields the caller omitted. Throws a
 * descriptive error if any supplied value is malformed.
 *
 * Checks:
 *  - `maxAttempts` must be a non-negative integer.
 *  - `backoff.initialMs` must be a positive integer.
 *  - `backoff.maxMs` must be a positive integer and >= `initialMs`.
 *  - `backoff.factor` must be a finite number > 1.
 *
 * Returns the resolved config (all back-off fields populated) when the
 * input passes.
 */
export function validateEngineRetryConfig(
  designId: string,
  raw: EngineRetryConfig,
): EngineRetryConfig & { backoff: EngineRetryBackoffConfig } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `[fabricator] engine "${designId}": retry config must be an object; received ${typeof raw}`,
    );
  }
  if (!Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 0) {
    throw new Error(
      `[fabricator] engine "${designId}": retry.maxAttempts must be a non-negative integer; received ${String(raw.maxAttempts)}`,
    );
  }

  const resolved: EngineRetryBackoffConfig = { ...DEFAULT_ENGINE_RETRY_BACKOFF };
  const backoff = raw.backoff ?? {};
  if (typeof backoff !== 'object' || backoff === null) {
    throw new Error(
      `[fabricator] engine "${designId}": retry.backoff must be an object; received ${typeof backoff}`,
    );
  }
  if (backoff.initialMs !== undefined) {
    if (!Number.isInteger(backoff.initialMs) || backoff.initialMs <= 0) {
      throw new Error(
        `[fabricator] engine "${designId}": retry.backoff.initialMs must be a positive integer; received ${String(backoff.initialMs)}`,
      );
    }
    resolved.initialMs = backoff.initialMs;
  }
  if (backoff.maxMs !== undefined) {
    if (!Number.isInteger(backoff.maxMs) || backoff.maxMs <= 0) {
      throw new Error(
        `[fabricator] engine "${designId}": retry.backoff.maxMs must be a positive integer; received ${String(backoff.maxMs)}`,
      );
    }
    resolved.maxMs = backoff.maxMs;
  }
  if (backoff.factor !== undefined) {
    if (typeof backoff.factor !== 'number' || !Number.isFinite(backoff.factor) || backoff.factor <= 1) {
      throw new Error(
        `[fabricator] engine "${designId}": retry.backoff.factor must be a finite number greater than 1; received ${String(backoff.factor)}`,
      );
    }
    resolved.factor = backoff.factor;
  }
  if (resolved.maxMs < resolved.initialMs) {
    throw new Error(
      `[fabricator] engine "${designId}": retry.backoff.maxMs (${resolved.maxMs}) must be >= initialMs (${resolved.initialMs})`,
    );
  }
  return { maxAttempts: raw.maxAttempts, backoff: resolved };
}

/**
 * Resolve an engine design's effective retry config. Returns a shape
 * with all back-off fields populated. For designs without `retry`,
 * returns the zero-attempts shape — signalling fail-fast to the Spider.
 */
export function resolveEngineRetryConfig(
  design: EngineDesign,
): { maxAttempts: number; backoff: EngineRetryBackoffConfig } {
  if (!design.retry) {
    return { maxAttempts: 0, backoff: { ...DEFAULT_ENGINE_RETRY_BACKOFF } };
  }
  return validateEngineRetryConfig(design.id, design.retry);
}

/**
 * Resolve an engine design's effective retry config, layering an optional
 * deployment-level override on top. Pure — Fabricator does not read guild
 * config; the caller (Spider) is responsible for handing in the override
 * map fetched from `g.guildConfig().spider?.engineRetryOverrides`.
 *
 * Three-layer overlay (highest wins):
 *
 *     override > design.retry > built-in defaults
 *
 * The override is treated as "fields the operator chose to change":
 *  - If `override.maxAttempts` is set, it replaces the design's value.
 *  - Each `override.backoff.<field>` independently replaces the
 *    corresponding design backoff field.
 *  - Unspecified fields fall through to `design.retry`, then to
 *    `DEFAULT_ENGINE_RETRY_BACKOFF` for backoff sub-fields.
 *
 * When the design declares no `retry`, the design layer is `{ maxAttempts: 0,
 * backoff: DEFAULT }` — so an override that specifies only `maxAttempts: N`
 * enables retry on a previously fail-fast design with the default backoff.
 *
 * The override is assumed already-validated (Spider runs the validation
 * pass at startup via `validateEngineRetryConfig`). Passing an undefined
 * or empty override returns the same value `resolveEngineRetryConfig`
 * would.
 *
 * Throws if the merged result is internally inconsistent (e.g. an
 * override that drops `maxMs` below the design's `initialMs`) — the same
 * cross-field invariants `validateEngineRetryConfig` enforces.
 */
export function resolveEngineRetryConfigWithOverrides(
  design: EngineDesign,
  override: Partial<EngineRetryConfig> | undefined,
): { maxAttempts: number; backoff: EngineRetryBackoffConfig } {
  const baseline = resolveEngineRetryConfig(design);
  if (override === undefined) return baseline;

  // Build a merged raw shape and run it through the same validator the
  // design path uses, so the cross-field invariants (maxMs >= initialMs,
  // factor > 1, etc.) are checked on the merged result. The override is
  // already validated for per-field shape at startup; the validator call
  // here is the canonical merge-of-fields-and-cross-field-check.
  const mergedMaxAttempts =
    override.maxAttempts !== undefined ? override.maxAttempts : baseline.maxAttempts;
  const mergedBackoff: EngineRetryBackoffConfig = {
    initialMs: override.backoff?.initialMs ?? baseline.backoff.initialMs,
    maxMs: override.backoff?.maxMs ?? baseline.backoff.maxMs,
    factor: override.backoff?.factor ?? baseline.backoff.factor,
  };
  return validateEngineRetryConfig(design.id, {
    maxAttempts: mergedMaxAttempts,
    backoff: mergedBackoff,
  });
}

/** Summary info for a registered engine design. */
export interface EngineDesignInfo {
  /** Engine design id. */
  id: string;
  /** Plugin id that contributed this design. */
  pluginId: string;
  /** Whether the design defines a collect() method (indicates quick engine with custom yield assembly). */
  hasCollect: boolean;
}

/** The Fabricator's public API, exposed via `provides`. */
export interface FabricatorApi {
  /**
   * Look up an engine design by ID.
   * Returns the design if registered, undefined otherwise.
   */
  getEngineDesign(id: string): EngineDesign | undefined;

  /**
   * List all registered engine designs with summary info.
   */
  listEngineDesigns(): EngineDesignInfo[];
}

// ── Type guard ────────────────────────────────────────────────────────

/** Narrow an unknown value to EngineDesign. */
function isEngineDesign(value: unknown): value is EngineDesign {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).run === 'function'
  );
}

// ── Implementation ────────────────────────────────────────────────────

/** The engine design registry — populated at startup, queried at runtime. */
class EngineRegistry {
  private readonly designs = new Map<string, EngineDesign>();
  private readonly provenance = new Map<string, string>();

  /** Extract and register engine designs from a kit (or supportKit) contribution. */
  registerFromKit(kit: Record<string, unknown>, pluginId: string): void {
    const rawEngines = kit.engines;
    if (typeof rawEngines !== 'object' || rawEngines === null) return;

    for (const value of Object.values(rawEngines as Record<string, unknown>)) {
      if (!isEngineDesign(value)) continue;

      // Fail-loud retry validation at registration. An opt-in `retry`
      // block whose shape is malformed (negative maxAttempts, maxMs <
      // initialMs, non-positive factor, etc.) throws here rather than
      // silently becoming inert in the dispatch loop.
      if (value.retry !== undefined) {
        validateEngineRetryConfig(value.id, value.retry);
      }

      // Kit-vs-kit collision: throw at registration time. Two kits contributing
      // an engine design with the same id is a guild-config hazard — Spider
      // keys engines by id and would silently bind to whichever kit happened
      // to load last. Refuse to start instead.
      const existingPlugin = this.provenance.get(value.id);
      if (existingPlugin !== undefined) {
        throw new Error(
          `[fabricator] engines: engine design "${value.id}" is contributed by two kits ` +
          `— kit "${existingPlugin}" already registered it, and ` +
          `kit "${pluginId}" attempted to register it again. ` +
          `Two kits cannot contribute the same engine design id. ` +
          `Resolve by removing one of the kit contributions.`
        );
      }

      this.designs.set(value.id, value);
      this.provenance.set(value.id, pluginId);
    }
  }

  /** Look up an engine design by ID. */
  get(id: string): EngineDesign | undefined {
    return this.designs.get(id);
  }

  /** List all registered engine designs with summary info. */
  list(): EngineDesignInfo[] {
    const result: EngineDesignInfo[] = [];
    for (const [id, design] of this.designs) {
      result.push({
        id,
        pluginId: this.provenance.get(id) ?? 'unknown',
        hasCollect: typeof design.collect === 'function',
      });
    }
    return result;
  }
}

// ── Apparatus factory ─────────────────────────────────────────────────

/**
 * Create the Fabricator apparatus plugin.
 *
 * Returns a Plugin with:
 * - `consumes: ['engines']` — scans kit/supportKit contributions
 * - `provides: FabricatorApi` — the engine design registry API
 */
export function createFabricator(): Plugin {
  const registry = new EngineRegistry();

  const api: FabricatorApi = {
    getEngineDesign(id: string): EngineDesign | undefined {
      return registry.get(id);
    },
    listEngineDesigns(): EngineDesignInfo[] {
      return registry.list();
    },
  };

  return {
    apparatus: {
      requires: [],
      consumes: ['engines'],
      provides: api,

      start(ctx: StartupContext): void {
        // Register all engine design contributions (standalone kits + apparatus supportKits)
        // via the Wire-phase ctx.kits('engines') snapshot.
        // entry.value IS the engines record (e.g. { draft: engine }) — wrap it back
        // into the shape registerFromKit expects: { engines: <engines record> }.
        for (const entry of ctx.kits('engines')) {
          registry.registerFromKit(
            { engines: entry.value } as Record<string, unknown>,
            entry.pluginId,
          );
        }
      },
    },
  };
}
