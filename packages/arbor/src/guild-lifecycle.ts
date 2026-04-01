/**
 * Guild lifecycle — pure logic for plugin validation, ordering, and events.
 *
 * All functions here operate on in-memory data structures (LoadedKit[],
 * LoadedApparatus[], Maps) with no I/O. This makes them independently
 * testable with synthetic fixtures.
 *
 * `createGuild()` in arbor.ts is the orchestrator that performs I/O
 * (config reading, dynamic imports) then delegates to these functions.
 */

import type {
  StartupContext,
  LoadedKit,
  LoadedApparatus,
} from '@shardworks/nexus-core';

// ── Types ────────────────────────────────────────────────────────────

export type EventHandlerMap = Map<
  string,
  Array<(...args: unknown[]) => void | Promise<void>>
>;

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate all `requires` declarations and detect circular dependencies.
 * Throws with a descriptive error on the first problem found.
 *
 * Checks:
 * - Apparatus requires: every named dependency must exist (kit or apparatus).
 * - Kit requires: every named dependency must be an apparatus (kits can't
 *   depend on kits).
 * - Cycle detection: no circular dependency chains among apparatuses.
 */
export function validateRequires(
  kits: LoadedKit[],
  apparatuses: LoadedApparatus[],
): void {
  const apparatusIds = new Set(apparatuses.map((a) => a.id));
  const allIds = new Set([
    ...kits.map((k) => k.id),
    ...apparatuses.map((a) => a.id),
  ]);

  // Check apparatus requires
  for (const app of apparatuses) {
    for (const dep of app.apparatus.requires ?? []) {
      if (!allIds.has(dep)) {
        throw new Error(
          `[arbor] "${app.id}" requires "${dep}", which is not installed.`,
        );
      }
    }
  }

  // Check kit requires (must be apparatus names — kits can't depend on kits)
  for (const kit of kits) {
    for (const dep of kit.kit.requires ?? []) {
      if (!apparatusIds.has(dep)) {
        if (!allIds.has(dep)) {
          throw new Error(
            `[arbor] kit "${kit.id}" requires "${dep}", which is not installed.`,
          );
        }
        throw new Error(
          `[arbor] kit "${kit.id}" requires "${dep}", but that plugin is a kit, not an apparatus. ` +
          `Kit requires must name apparatus plugins.`,
        );
      }
    }
  }

  // Detect circular dependencies among apparatuses
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, chain: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...chain, id].join(' → ');
      throw new Error(`[arbor] Circular dependency detected: ${cycle}`);
    }
    visiting.add(id);
    const app = apparatuses.find((a) => a.id === id);
    if (app) {
      for (const dep of app.apparatus.requires ?? []) {
        visit(dep, [...chain, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const app of apparatuses) {
    visit(app.id, []);
  }
}

// ── Dependency ordering ──────────────────────────────────────────────

/**
 * Sort apparatuses in dependency-resolved order using topological sort.
 * validateRequires() must be called first to ensure the graph is acyclic.
 */
export function topoSort(apparatuses: LoadedApparatus[]): LoadedApparatus[] {
  const sorted: LoadedApparatus[] = [];
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    const app = apparatuses.find((a) => a.id === id);
    if (!app) return;
    for (const dep of app.apparatus.requires ?? []) {
      visit(dep);
    }
    visited.add(id);
    sorted.push(app);
  }

  for (const app of apparatuses) {
    visit(app.id);
  }

  return sorted;
}

// ── Startup warnings ─────────────────────────────────────────────────

/**
 * Collect advisory warnings for kit contributions that no apparatus
 * consumes, and for missing recommended apparatuses.
 *
 * Returns an array of warning strings. The caller decides how to emit
 * them (console.warn, logger, etc.).
 */
export function collectStartupWarnings(
  kits:        LoadedKit[],
  apparatuses: LoadedApparatus[],
): string[] {
  const warnings: string[] = [];
  const consumedTypes = new Set<string>();
  const installedIds  = new Set(apparatuses.map((a) => a.id));

  for (const app of apparatuses) {
    for (const token of app.apparatus.consumes ?? []) {
      consumedTypes.add(token);
    }
  }

  for (const kit of kits) {
    // Check recommends
    for (const rec of kit.kit.recommends ?? []) {
      if (!installedIds.has(rec)) {
        warnings.push(
          `[arbor] warn: "${kit.id}" recommends "${rec}" but it is not installed.`,
        );
      }
    }

    // Check contribution types against consumes
    for (const key of Object.keys(kit.kit)) {
      if (key === 'requires' || key === 'recommends') continue;
      if (!consumedTypes.has(key)) {
        warnings.push(
          `[arbor] warn: "${kit.id}" contributes "${key}" but no installed apparatus declares consumes: ["${key}"]`,
        );
      }
    }
  }

  return warnings;
}

// ── Event system ─────────────────────────────────────────────────────

/**
 * Build a StartupContext for an apparatus's start() call.
 * The context provides event subscription; handlers are stored in the
 * shared eventHandlers map so fireEvent can invoke them later.
 */
export function buildStartupContext(
  eventHandlers: EventHandlerMap,
): StartupContext {
  return {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
  };
}

/**
 * Fire a lifecycle event, awaiting each handler sequentially.
 */
export async function fireEvent(
  eventHandlers: EventHandlerMap,
  event:         string,
  ...args: unknown[]
): Promise<void> {
  const handlers = eventHandlers.get(event) ?? [];
  for (const h of handlers) {
    await h(...args);
  }
}
