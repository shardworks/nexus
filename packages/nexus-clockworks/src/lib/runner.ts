/**
 * Clockworks runner — processes the event queue.
 *
 * Reads unprocessed events from the Books, matches them to standing orders
 * declared in guild.json, and dispatches them as engine invocations.
 * Each event is marked processed after all its matching standing orders run.
 *
 * Standing orders have one canonical form: `{ on, run, ...params }`.
 * The `summon` verb is syntactic sugar desugared at dispatch time.
 *
 * ## Engine resolution
 *
 * Engines are resolved by scanning installed plugins in `node_modules`:
 *   1. Iterate config.plugins (installed plugin ids)
 *   2. Resolve each plugin id to its npm package name (via guild package.json deps)
 *   3. Import the package and scan its default export for a matching engine
 *
 * Throws with a clear message if the engine is not found in any installed plugin.
 */

import path from 'node:path';
import fs from 'node:fs';
import { readGuildConfig } from '@shardworks/nexus-core';
import type { StandingOrder, GuildConfig } from '@shardworks/nexus-core';
import { resolveEngineFromExport } from '@shardworks/nexus-core/legacy/1';
import type { GuildEvent, EngineDefinition } from '@shardworks/nexus-core/legacy/1';
import {
  readPendingEvents,
  readEvent,
  markEventProcessed,
  recordDispatch,
  signalEvent,
} from './events-api.ts';

// ── Standing order desugaring ─────────────────────────────────────────

/** Keys on a standing order that are structural, not engine params. */
const RESERVED_KEYS = new Set(['on', 'run', 'summon', 'brief']);

/**
 * Desugar a standing order into canonical `{ on, run, ...params }` form.
 *
 * - `{ on, run, ... }` — passes through unchanged
 * - `{ on, summon, prompt?, ... }` → `{ on, run: "summon-engine", role: <summon>, ... }`
 */
export function desugarOrder(order: StandingOrder): Record<string, unknown> {
  const raw = order as Record<string, unknown>;

  if ('summon' in raw && typeof raw.summon === 'string') {
    const { summon, ...rest } = raw;
    return { ...rest, run: 'summon-engine', role: summon };
  }

  return raw;
}

/**
 * Extract engine params from a desugared standing order.
 * Returns all keys except the reserved structural ones (`on`, `run`).
 */
export function extractParams(order: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(order)) {
    if (!RESERVED_KEYS.has(key)) params[key] = value;
  }
  return params;
}

// ── Result types ──────────────────────────────────────────────────────

/** Summary of one standing order execution. */
export interface DispatchSummary {
  handlerType: 'engine' | 'anima';
  handlerName: string;
  status: 'success' | 'error' | 'skipped';
  error?: string;
}

/** Result of processing a single event. */
export interface TickResult {
  eventId: string;
  eventName: string;
  dispatches: DispatchSummary[];
}

/** Result of a full clock run (drain the queue). */
export interface ClockRunResult {
  processed: TickResult[];
  totalEvents: number;
}

// ── Engine resolution ─────────────────────────────────────────────────

/**
 * Resolve an EngineDefinition by scanning installed plugin packages.
 *
 * For each plugin id in config.plugins:
 *  1. Check guild package.json dependencies for a matching package name.
 *  2. Fall back to treating the plugin id as the package name directly,
 *     or as `@shardworks/<id>` for scoped packages.
 *  3. Import the package and scan its default export for the engine.
 *
 * Throws if the engine is not found in any installed plugin.
 */
async function resolveEngine(
  home: string,
  config: GuildConfig,
  engineName: string,
): Promise<EngineDefinition> {
  const nodeModules = path.join(home, 'node_modules');

  for (const pluginId of config.plugins) {
    const candidates = [pluginId, `@shardworks/${pluginId}`];

    // Check guild package.json for a dependency that maps to this plugin id
    const guildPkgPath = path.join(home, 'package.json');
    if (fs.existsSync(guildPkgPath)) {
      try {
        const guildPkg = JSON.parse(fs.readFileSync(guildPkgPath, 'utf-8')) as {
          dependencies?: Record<string, string>;
        };
        const deps = guildPkg.dependencies ?? {};
        const match = Object.keys(deps).find(pkg => pkg.endsWith(pluginId) || pkg === pluginId);
        if (match) candidates.unshift(match);
      } catch { /* ignore malformed package.json */ }
    }

    for (const pkgName of candidates) {
      const pkgDir = path.join(nodeModules, ...pkgName.split('/'));
      if (!fs.existsSync(pkgDir)) continue;
      try {
        const mod = await import(pkgName);
        const def = resolveEngineFromExport(mod.default, engineName);
        if (def) return def;
      } catch { /* not this plugin */ }
    }
  }

  throw new Error(
    `Engine "${engineName}" not found. ` +
    `Checked ${config.plugins.length} installed plugin(s). ` +
    `Ensure the plugin that provides this engine is installed and listed in guild.json plugins.`,
  );
}

// ── Event processing ──────────────────────────────────────────────────

/** Signal standing-order.failed when an engine invocation fails. */
function signalStandingOrderFailed(
  home: string,
  order: StandingOrder,
  triggeringEvent: GuildEvent,
  error: string,
): void {
  signalEvent(home, 'standing-order.failed', {
    standingOrder: order,
    triggeringEvent: {
      id: triggeringEvent.id,
      name: triggeringEvent.name,
    },
    error,
  }, 'framework');
}

/**
 * Execute a single engine standing order — load and invoke the engine.
 */
async function executeEngineOrder(
  home: string,
  event: GuildEvent,
  engineName: string,
  config: GuildConfig,
  params: Record<string, unknown>,
): Promise<DispatchSummary> {
  const startedAt = new Date().toISOString();

  try {
    const engineDef = await resolveEngine(home, config, engineName);
    await engineDef.handler(event, { home, params });

    const endedAt = new Date().toISOString();
    recordDispatch(home, {
      eventId: event.id,
      handlerType: 'engine',
      handlerName: engineName,
      startedAt,
      endedAt,
      status: 'success',
    });

    return { handlerType: 'engine', handlerName: engineName, status: 'success' };
  } catch (err) {
    const endedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);

    recordDispatch(home, {
      eventId: event.id,
      handlerType: 'engine',
      handlerName: engineName,
      startedAt,
      endedAt,
      status: 'error',
      error: errorMsg,
    });

    return { handlerType: 'engine', handlerName: engineName, status: 'error', error: errorMsg };
  }
}

/**
 * Process a single event: find matching standing orders and execute them.
 */
async function processEvent(home: string, event: GuildEvent): Promise<TickResult> {
  const config = readGuildConfig(home);
  const standingOrders = config.clockworks?.standingOrders ?? [];
  const matching = standingOrders.filter(so => so.on === event.name);
  const dispatches: DispatchSummary[] = [];

  // Loop guard: don't process standing-order.failed events triggered by
  // other standing-order.failed events (prevents failure cascades).
  const isFailureEvent = event.name === 'standing-order.failed';
  const isNestedFailure = isFailureEvent &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    'triggeringEvent' in event.payload &&
    typeof (event.payload as Record<string, unknown>).triggeringEvent === 'object' &&
    (event.payload as Record<string, unknown>).triggeringEvent !== null &&
    ((event.payload as Record<string, unknown>).triggeringEvent as Record<string, unknown>).name === 'standing-order.failed';

  if (isNestedFailure) {
    markEventProcessed(home, event.id);
    return { eventId: event.id, eventName: event.name, dispatches: [] };
  }

  for (const order of matching) {
    const desugared = desugarOrder(order);
    const engineName = desugared.run as string;
    const params = extractParams(desugared);
    const summary = await executeEngineOrder(home, event, engineName, config, params);
    dispatches.push(summary);

    if (summary.status === 'error') {
      signalStandingOrderFailed(home, order, event, summary.error!);
    }
  }

  markEventProcessed(home, event.id);
  return { eventId: event.id, eventName: event.name, dispatches };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Process the next pending event, or a specific event by id.
 *
 * @param home - Guild root path.
 * @param eventId - Specific event id to process, or undefined for the next pending.
 * @returns Processing result, or null if no events are pending.
 */
export async function clockTick(home: string, eventId?: string): Promise<TickResult | null> {
  if (eventId != null) {
    const event = readEvent(home, eventId);
    if (!event) throw new Error(`Event "${eventId}" not found.`);
    return processEvent(home, event);
  }

  const pending = readPendingEvents(home);
  if (pending.length === 0) return null;

  return processEvent(home, pending[0]!);
}

/**
 * Process all pending events until the queue is empty.
 *
 * Loops to catch events generated by standing order failures.
 *
 * @param home - Guild root path.
 * @returns Summary of all events processed in this run.
 */
export async function clockRun(home: string): Promise<ClockRunResult> {
  const processed: TickResult[] = [];
  let totalEvents = 0;

  while (true) {
    const pending = readPendingEvents(home);
    if (pending.length === 0) break;

    totalEvents += pending.length;

    for (const event of pending) {
      const result = await processEvent(home, event);
      processed.push(result);
    }
  }

  return { processed, totalEvents };
}
