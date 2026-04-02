/**
 * The Fabricator — guild engine design registry apparatus.
 *
 * Scans installed engine designs from kit contributions and apparatus supportKits,
 * and serves them to the Walker on demand.
 *
 * The Fabricator does not execute engines. It is a pure query service:
 * designs in, designs out.
 */

import type {
  StartupContext,
  LoadedPlugin,
  LoadedApparatus,
  Plugin,
} from '@shardworks/nexus-core';
import {
  guild,
  isLoadedKit,
  isLoadedApparatus,
} from '@shardworks/nexus-core';

// ── Public types ──────────────────────────────────────────────────────

/** Minimal execution context passed to an engine's run() method. */
export interface EngineRunContext {
  /** Simple string identity for this engine instance (e.g. 'draft', 'implement'). */
  engineId: string;
  /** All upstream yields, keyed by engine id. Escape hatch for engines that need to inspect the full upstream chain. */
  upstream: Record<string, unknown>;
}

/**
 * The result of an engine run.
 *
 * 'completed' — synchronous work done inline, yields are available immediately.
 * 'launched'  — async work launched in a session; the Walker polls for completion.
 */
export type EngineRunResult =
  | { status: 'completed'; yields: unknown }
  | { status: 'launched'; sessionId: string };

/**
 * An engine design — the unit of work the Fabricator catalogues and the
 * Walker executes. Kit authors import this type from @shardworks/fabricator-apparatus.
 */
export interface EngineDesign {
  /** Unique identifier for this engine design (e.g. 'draft', 'implement', 'review'). */
  id: string;

  /**
   * Execute this engine.
   *
   * @param givens   — the engine's declared inputs, assembled by the Walker.
   * @param context  — minimal execution context: engine id and upstream yields.
   */
  run(givens: Record<string, unknown>, context: EngineRunContext): Promise<EngineRunResult>;
}

/** The Fabricator's public API, exposed via `provides`. */
export interface FabricatorApi {
  /**
   * Look up an engine design by ID.
   * Returns the design if registered, undefined otherwise.
   */
  getEngineDesign(id: string): EngineDesign | undefined;
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

  /** Register all engine designs from a loaded plugin. */
  register(plugin: LoadedPlugin): void {
    if (isLoadedKit(plugin)) {
      this.registerFromKit(plugin.kit);
    } else if (isLoadedApparatus(plugin)) {
      if (plugin.apparatus.supportKit) {
        this.registerFromKit(plugin.apparatus.supportKit);
      }
    }
  }

  /** Extract and register engine designs from a kit (or supportKit) contribution. */
  private registerFromKit(kit: Record<string, unknown>): void {
    const rawEngines = kit.engines;
    if (typeof rawEngines !== 'object' || rawEngines === null) return;

    for (const value of Object.values(rawEngines as Record<string, unknown>)) {
      if (isEngineDesign(value)) {
        this.designs.set(value.id, value);
      }
    }
  }

  /** Look up an engine design by ID. */
  get(id: string): EngineDesign | undefined {
    return this.designs.get(id);
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
  };

  return {
    apparatus: {
      requires: [],
      consumes: ['engines'],
      provides: api,

      start(ctx: StartupContext): void {
        const g = guild();

        // Scan all already-loaded kits. These fired plugin:initialized before
        // any apparatus started, so we can't catch them via events.
        for (const kit of g.kits()) {
          registry.register(kit);
        }

        // Subscribe to plugin:initialized for apparatus supportKits that
        // fire after us in the startup sequence.
        ctx.on('plugin:initialized', (plugin: unknown) => {
          const loaded = plugin as LoadedPlugin;
          // Skip kits — we already scanned them above.
          if (isLoadedApparatus(loaded)) {
            registry.register(loaded);
          }
        });
      },
    },
  };
}
