/**
 * Clockworks runner — processes the event queue by matching pending events
 * to standing orders in guild.json and executing them.
 *
 * This is the core of Pillar 5. It reads unprocessed events from the
 * Clockworks event queue, finds matching standing orders, and dispatches
 * them as engine invocations. Each event is marked as processed after all
 * its standing orders have been dispatched.
 *
 * Standing orders have one canonical form: `{ on, run, ...params }`.
 * The `summon` verb is syntactic sugar — desugared to a `summon-engine`
 * invocation at dispatch time. All dispatch flows through engines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGuildConfig } from './guild-config.ts';
import type { GuildConfig, StandingOrder } from './guild-config.ts';
import {
  readPendingEvents,
  readEvent,
  markEventProcessed,
  recordDispatch,
  signalEvent,
} from './events.ts';
import { isClockworkEngine, resolveEngineFromExport } from './engine.ts';
import type { GuildEvent } from './engine.ts';
import { clockPidPath, clockLogPath } from './nexus-home.ts';

// ── Standing Order Desugaring ─────────────────────────────────────────

/** Reserved keys on a standing order — everything else is an engine param. */
const RESERVED_KEYS = new Set(['on', 'run', 'summon', 'brief']);

/**
 * Desugar a standing order into canonical form: `{ on, run, ...params }`.
 *
 * - `{ on, run, ... }` passes through unchanged.
 * - `{ on, summon, prompt?, ... }` becomes `{ on, run: "summon-engine", role: <summon>, prompt?, ... }`.
 * - `{ on, brief, ... }` becomes `{ on, run: "summon-engine", role: <brief>, ... }` (legacy).
 *
 * Returns a plain object (not typed as StandingOrder) because the sugar
 * forms carry arbitrary extra keys that the TS type doesn't declare.
 */
export function desugarOrder(order: StandingOrder): Record<string, unknown> {
  const raw = order as Record<string, unknown>;

  if ('summon' in raw && typeof raw.summon === 'string') {
    const { summon, ...rest } = raw;
    return { ...rest, run: 'summon-engine', role: summon };
  }

  // Legacy brief support — desugar to summon-engine
  if ('brief' in raw && typeof raw.brief === 'string') {
    const { brief, ...rest } = raw;
    return { ...rest, run: 'summon-engine', role: brief };
  }

  return raw;
}

/**
 * Extract engine params from a desugared standing order.
 * Returns all keys except the reserved structural ones.
 */
export function extractParams(order: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(order)) {
    if (!RESERVED_KEYS.has(key)) params[key] = value;
  }
  return params;
}

// ── Types ─────────────────────────────────────────────────────────────

/** Result of processing a single event. */
export interface TickResult {
  eventId: string;
  eventName: string;
  dispatches: DispatchSummary[];
}

/** Summary of one standing order execution. */
export interface DispatchSummary {
  handlerType: 'engine' | 'anima';
  handlerName: string;
  status: 'success' | 'error' | 'skipped';
  error?: string;
}

/** Result of a full clock run. */
export interface ClockRunResult {
  processed: TickResult[];
  totalEvents: number;
}

/**
 * Process a single event: find matching standing orders and execute them.
 *
 * All standing orders are desugared into `{ on, run, ...params }` form and
 * dispatched as engine invocations. The `summon` verb is syntactic sugar
 * for `{ run: "summon-engine", role: <summon-value>, ... }`.
 *
 * @param home - Absolute path to the guild root.
 * @param event - The event to process.
 * @returns Summary of what was dispatched.
 */
async function processEvent(home: string, event: GuildEvent): Promise<TickResult> {
  const config = readGuildConfig(home);
  const standingOrders = config.clockworks?.standingOrders ?? [];
  const matching = standingOrders.filter(so => so.on === event.name);
  const dispatches: DispatchSummary[] = [];

  // Check loop guard: don't process standing-order.failed events triggered
  // by other standing-order.failed events.
  const isFailureEvent = event.name === 'standing-order.failed';
  const isNestedFailure = isFailureEvent &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    'triggeringEvent' in event.payload &&
    typeof (event.payload as Record<string, unknown>).triggeringEvent === 'object' &&
    (event.payload as Record<string, unknown>).triggeringEvent !== null &&
    ((event.payload as Record<string, unknown>).triggeringEvent as Record<string, unknown>).name === 'standing-order.failed';

  if (isNestedFailure) {
    // Loop guard: skip processing to prevent cascade.
    markEventProcessed(home, event.id);
    return { eventId: event.id, eventName: event.name, dispatches: [] };
  }

  for (const order of matching) {
    const desugared = desugarOrder(order);
    const engineName = desugared.run as string;
    const params = extractParams(desugared);
    const summary = await executeEngineOrder(home, event, engineName, config, params);
    dispatches.push(summary);

    // On failure, signal standing-order.failed
    if (summary.status === 'error') {
      signalStandingOrderFailed(home, order, event, summary.error!);
    }
  }

  markEventProcessed(home, event.id);
  return { eventId: event.id, eventName: event.name, dispatches };
}

/**
 * Execute an engine standing order — load and call a clockwork engine.
 *
 * Params from the standing order are passed through to the engine via
 * `EngineContext.params`.
 */
async function executeEngineOrder(
  home: string,
  event: GuildEvent,
  engineName: string,
  config: GuildConfig,
  params: Record<string, unknown> = {},
): Promise<DispatchSummary> {
  const startedAt = new Date().toISOString();

  try {
    // Resolve engine entry point from guild.json
    const engineEntry = config.engines?.[engineName];
    if (!engineEntry) {
      throw new Error(`Engine "${engineName}" not found in guild.json engines registry.`);
    }

    // Resolve the engine module path
    const enginePkg = engineEntry.package;
    if (!enginePkg) {
      throw new Error(`Engine "${engineName}" has no package field — cannot resolve module.`);
    }

    // Import the engine module — handles both single and array exports
    const mod = await import(enginePkg);
    const engineDef = resolveEngineFromExport(mod.default, engineName);

    if (!engineDef) {
      throw new Error(
        `Engine "${engineName}" could not be resolved from "${enginePkg}". ` +
        `Module must export an engine() definition or an array of engine() definitions with matching names.`,
      );
    }

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
 * Signal standing-order.failed when a standing order execution fails.
 */
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
 * Process the next pending event (or a specific event by id).
 *
 * @param home - Guild root path.
 * @param eventId - Specific event id to process, or undefined for next pending.
 * @returns Processing result, or null if no events to process.
 */
export async function clockTick(home: string, eventId?: string): Promise<TickResult | null> {
  if (eventId != null) {
    const event = readEvent(home, eventId);
    if (!event) {
      throw new Error(`Event #${eventId} not found.`);
    }
    return processEvent(home, event);
  }

  const pending = readPendingEvents(home);
  if (pending.length === 0) return null;

  return processEvent(home, pending[0]!);
}

/**
 * Process all pending events until the queue is empty.
 *
 * @param home - Guild root path.
 * @returns Summary of all processing.
 */
export async function clockRun(home: string): Promise<ClockRunResult> {
  const processed: TickResult[] = [];
  let totalEvents = 0;

  // Process in a loop because standing order failures may generate new events
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

// ── Daemon lifecycle ──────────────────────────────────────────────────

/** Options for starting the clockworks daemon. */
export interface ClockStartOptions {
  /** Polling interval in milliseconds. Default: 2000. */
  interval?: number;
}

/** Result of starting the clockworks daemon. */
export interface ClockStartResult {
  pid: number;
  logFile: string;
}

/** Result of stopping the clockworks daemon. */
export interface ClockStopResult {
  pid: number;
  stopped: boolean;
}

/** Current status of the clockworks daemon. */
export interface ClockStatus {
  running: boolean;
  pid?: number;
  logFile?: string;
  uptime?: number;
}

/**
 * Check if a process is alive by sending signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the PID file. Returns { pid, startedAt } or null if no file.
 */
function readPidFile(home: string): { pid: number; startedAt: string } | null {
  const pidFile = clockPidPath(home);
  if (!fs.existsSync(pidFile)) return null;
  try {
    const content = fs.readFileSync(pidFile, 'utf-8').trim();
    const lines = content.split('\n');
    const pid = parseInt(lines[0]!, 10);
    const startedAt = lines[1] ?? new Date().toISOString();
    if (isNaN(pid)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

/**
 * Clean up a stale PID file (process is dead).
 */
function cleanStalePid(home: string): void {
  const pidFile = clockPidPath(home);
  try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
}

/**
 * Start the clockworks daemon as a detached background process.
 *
 * Spawns a child process that polls the event queue at the given interval.
 * Returns immediately after the child is spawned.
 *
 * @param home - Guild root path.
 * @param options - Daemon options (interval).
 * @returns PID and log file path.
 */
export function clockStart(home: string, options?: ClockStartOptions): ClockStartResult {
  const interval = options?.interval ?? 2000;

  // Check if daemon is already running
  const existing = readPidFile(home);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Clockworks daemon is already running (PID ${existing.pid}).`);
  }

  // Clean up stale PID file if needed
  if (existing) cleanStalePid(home);

  const logFile = clockLogPath(home);

  // Open log file for append
  const logFd = fs.openSync(logFile, 'a');

  // Resolve the daemon script from this module's directory.
  // clock-daemon lives alongside clockworks in the same package.
  // When running from source it's .ts; when running from dist it's .js.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const daemonScript = fs.existsSync(path.join(thisDir, 'clock-daemon.ts'))
    ? path.join(thisDir, 'clock-daemon.ts')
    : path.join(thisDir, 'clock-daemon.js');

  // Use --experimental-transform-types for .ts, not needed for .js
  const nodeArgs = daemonScript.endsWith('.ts')
    ? ['--disable-warning=ExperimentalWarning', '--experimental-transform-types']
    : [];

  const child = spawn(
    process.execPath,
    [
      ...nodeArgs,
      daemonScript,
      home,
      String(interval),
    ],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    },
  );

  const pid = child.pid!;

  // Write PID file: line 1 = PID, line 2 = start timestamp
  const pidFile = clockPidPath(home);
  fs.writeFileSync(pidFile, `${pid}\n${new Date().toISOString()}\n`);

  // Detach from parent
  child.unref();
  fs.closeSync(logFd);

  return { pid, logFile };
}

/**
 * Stop the running clockworks daemon.
 *
 * @param home - Guild root path.
 * @returns PID that was stopped and whether the process was still alive.
 */
export function clockStop(home: string): ClockStopResult {
  const pidInfo = readPidFile(home);
  if (!pidInfo) {
    throw new Error('Clockworks daemon is not running (no PID file).');
  }

  const alive = isProcessAlive(pidInfo.pid);
  if (alive) {
    process.kill(pidInfo.pid, 'SIGTERM');
  }

  cleanStalePid(home);

  return { pid: pidInfo.pid, stopped: alive };
}

/**
 * Get the current status of the clockworks daemon.
 *
 * @param home - Guild root path.
 * @returns Daemon status including PID, log file, and uptime if running.
 */
export function clockStatus(home: string): ClockStatus {
  const pidInfo = readPidFile(home);
  if (!pidInfo) {
    return { running: false };
  }

  const alive = isProcessAlive(pidInfo.pid);
  if (!alive) {
    cleanStalePid(home);
    return { running: false };
  }

  const logFile = clockLogPath(home);
  const uptime = Date.now() - new Date(pidInfo.startedAt).getTime();

  return {
    running: true,
    pid: pidInfo.pid,
    logFile,
    uptime,
  };
}
