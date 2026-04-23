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
