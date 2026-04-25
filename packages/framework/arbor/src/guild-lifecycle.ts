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
  KitEntry,
  LoadedKit,
  LoadedApparatus,
  FailedPlugin,
} from '@shardworks/nexus-core';

// ── Types ────────────────────────────────────────────────────────────

export type EventHandlerMap = Map<
  string,
  Array<(...args: unknown[]) => void | Promise<void>>
>;

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate all `requires` declarations and detect circular dependencies.
 * Returns an array of FailedPlugin entries describing every problem found.
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
): FailedPlugin[] {
  const failures: FailedPlugin[] = [];
  const failedIds = new Set<string>();

  const apparatusIds = new Set(apparatuses.map((a) => a.id));
  const allIds = new Set([
    ...kits.map((k) => k.id),
    ...apparatuses.map((a) => a.id),
  ]);

  // Check apparatus requires
  for (const app of apparatuses) {
    for (const dep of app.apparatus.requires ?? []) {
      if (!allIds.has(dep)) {
        if (!failedIds.has(app.id)) {
          failedIds.add(app.id);
          failures.push({
            id:     app.id,
            reason: `"${app.id}" requires "${dep}", which is not installed.`,
          });
        }
      }
    }
  }

  // Check kit requires (must be apparatus names — kits can't depend on kits)
  for (const kit of kits) {
    for (const dep of kit.kit.requires ?? []) {
      if (!apparatusIds.has(dep)) {
        if (!failedIds.has(kit.id)) {
          failedIds.add(kit.id);
          if (!allIds.has(dep)) {
            failures.push({
              id:     kit.id,
              reason: `kit "${kit.id}" requires "${dep}", which is not installed.`,
            });
          } else {
            failures.push({
              id:     kit.id,
              reason: `kit "${kit.id}" requires "${dep}", but that plugin is a kit, not an apparatus. Kit requires must name apparatus plugins.`,
            });
          }
        }
      }
    }
  }

  // Detect circular dependencies among apparatuses
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleParticipants = new Set<string>();

  function visit(id: string, chain: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      // Back-edge detected — extract cycle participants from chain
      const cycleStart = chain.indexOf(id);
      const cycleNodes = cycleStart >= 0 ? chain.slice(cycleStart) : [...chain];
      cycleNodes.push(id);
      for (const node of cycleNodes) {
        cycleParticipants.add(node);
      }
      return;
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

  for (const id of cycleParticipants) {
    if (!failedIds.has(id)) {
      failedIds.add(id);
      failures.push({
        id,
        reason: `"${id}" is part of a circular dependency chain.`,
      });
    }
  }

  return failures;
}

// ── Cascade filtering ─────────────────────────────────────────────────

/**
 * Remove plugins that transitively depend on any failed plugin.
 *
 * Iterates until stable, cascading failures through the dependency graph.
 * Returns healthy plugins and any newly-cascaded failures.
 */
export function filterFailedPlugins(
  kits: LoadedKit[],
  apparatuses: LoadedApparatus[],
  rootFailures: FailedPlugin[],
): { kits: LoadedKit[]; apparatuses: LoadedApparatus[]; cascaded: FailedPlugin[] } {
  const failedIds = new Set<string>(rootFailures.map((f) => f.id));
  const cascaded: FailedPlugin[] = [];

  // Apparatus cascade: iterate until no new failures
  let changed = true;
  while (changed) {
    changed = false;
    for (const app of apparatuses) {
      if (failedIds.has(app.id)) continue;
      for (const dep of app.apparatus.requires ?? []) {
        if (failedIds.has(dep)) {
          failedIds.add(app.id);
          cascaded.push({
            id:     app.id,
            reason: `"${app.id}" depends on failed plugin "${dep}".`,
          });
          changed = true;
          break;
        }
      }
    }
  }

  // Kit cascade: single pass (kits can't depend on other kits)
  for (const kit of kits) {
    if (failedIds.has(kit.id)) continue;
    for (const dep of kit.kit.requires ?? []) {
      if (failedIds.has(dep)) {
        failedIds.add(kit.id);
        cascaded.push({
          id:     kit.id,
          reason: `"${kit.id}" depends on failed plugin "${dep}".`,
        });
        break;
      }
    }
  }

  return {
    kits:        kits.filter((k) => !failedIds.has(k.id)),
    apparatuses: apparatuses.filter((a) => !failedIds.has(a.id)),
    cascaded,
  };
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

// ── Wire phase ───────────────────────────────────────────────────────

/** Framework-level kit fields excluded from KitEntry collection. */
const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

/**
 * Collect all kit contributions from standalone kits and apparatus supportKits
 * into a flat KitEntry array. Called during the Wire phase before any start().
 *
 * Iteration order: standalone kits first, then ordered apparatuses.
 * Framework fields (requires, recommends) are excluded.
 */
export function wireKitEntries(
  kits: LoadedKit[],
  orderedApparatuses: LoadedApparatus[],
): KitEntry[] {
  const entries: KitEntry[] = [];

  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }

  for (const app of orderedApparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }

  return entries;
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

  // Check apparatus recommends
  for (const app of apparatuses) {
    for (const rec of app.apparatus.recommends ?? []) {
      if (!installedIds.has(rec)) {
        warnings.push(
          `[arbor] warn: "${app.id}" recommends "${rec}" but it is not installed.`,
        );
      }
    }
  }

  for (const kit of kits) {
    // Check kit recommends
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

  // Check apparatus supportKit contribution types against consumes
  for (const app of apparatuses) {
    if (!app.apparatus.supportKit) continue;
    for (const key of Object.keys(app.apparatus.supportKit)) {
      if (key === 'requires' || key === 'recommends') continue;
      if (!consumedTypes.has(key)) {
        warnings.push(
          `[arbor] warn: "${app.id}" supportKit contributes "${key}" but no installed apparatus declares consumes: ["${key}"]`,
        );
      }
    }
  }

  return warnings;
}

// ── Event system ─────────────────────────────────────────────────────

/**
 * Build a StartupContext for an apparatus's start() call.
 * The context provides event subscription and kit contribution queries.
 * Handlers are stored in the shared eventHandlers map so fireEvent can
 * invoke them later. Kit entries are pre-indexed by type for efficient lookup.
 */
export function buildStartupContext(
  eventHandlers: EventHandlerMap,
  kitEntries: KitEntry[],
): StartupContext {
  // Pre-index by type for efficient lookup
  const index = new Map<string, KitEntry[]>();
  for (const entry of kitEntries) {
    const list = index.get(entry.type) ?? [];
    list.push(entry);
    index.set(entry.type, list);
  }

  return {
    on(event: string, handler: (...args: unknown[]) => void | Promise<void>) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },

    kits(type: string): KitEntry[] {
      return [...(index.get(type) ?? [])];
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

// ── Shutdown ─────────────────────────────────────────────────────────

/**
 * Per-apparatus failure produced by `shutdownStartedApparatuses` when one
 * or more `stop()` invocations throw. Each entry pairs the apparatus
 * plugin id with the underlying error so the aggregate caller can
 * surface every failed teardown.
 */
export interface ShutdownFailure {
  readonly id: string
  readonly error: Error
}

/**
 * Walk the started-apparatus list in reverse topological order, fire
 * the `guild:shutdown` event before any `stop()` runs, then call each
 * apparatus's optional `stop()` collecting per-apparatus errors instead
 * of aborting on the first throw.
 *
 * Pure orchestration — receives the started list and event handler map
 * by reference and does not touch any singleton. The caller (Arbor's
 * `StartedGuild.shutdown()`) wraps this in idempotency-guard +
 * `clearGuild()` housekeeping.
 *
 * Returns the list of per-apparatus failures (empty when every `stop()`
 * resolved cleanly). The caller is responsible for re-throwing an
 * aggregate when the list is non-empty — keeping the helper a pure
 * "collect failures" function mirrors the codebase's existing
 * `validateRequires` shape.
 *
 * Apparatus that omit `stop()` are skipped silently.
 *
 * Iterates `startedApparatuses` only — apparatus whose `start()` never
 * resolved are not present in the list (Arbor pushes after start
 * completes), so the symmetric "stop only what started" invariant is
 * preserved without an extra check here.
 */
export async function shutdownStartedApparatuses(
  startedApparatuses: readonly LoadedApparatus[],
  eventHandlers:      EventHandlerMap,
): Promise<ShutdownFailure[]> {
  // Fire `guild:shutdown` before any `stop()` runs so subscribers see
  // a consistent snapshot of running apparatus and have a chance to
  // act before teardown begins.
  await fireEvent(eventHandlers, 'guild:shutdown');

  const failures: ShutdownFailure[] = [];

  // Reverse iteration: dependents stop before dependencies. The
  // started list is populated in dependency-resolved order during
  // start, so walking it in reverse gives us reverse-topo order
  // without re-running topoSort.
  for (let i = startedApparatuses.length - 1; i >= 0; i--) {
    const app  = startedApparatuses[i]!;
    const stop = app.apparatus.stop;
    if (typeof stop !== 'function') continue;

    try {
      await stop();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failures.push({ id: app.id, error });
    }
  }

  return failures;
}

/**
 * Build the aggregate-error message thrown after a shutdown pass that
 * recorded one or more failures. Public so tests can assert message
 * shape without re-implementing the formatter.
 */
export function formatShutdownFailures(failures: readonly ShutdownFailure[]): string {
  const lines = failures.map((f) => `  - "${f.id}": ${f.error.message}`);
  return `[arbor] ${failures.length} apparatus stop() call${failures.length === 1 ? '' : 's'} failed during shutdown:\n${lines.join('\n')}`;
}
