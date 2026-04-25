/**
 * nsg clock — operator-facing Clockworks CLI.
 *
 * Three subcommands under `nsg clock` that compose on top of
 * `ClockworksApi.processEvents` and a direct read of the
 * `clockworks/events` book:
 *
 *   - `nsg clock list` — print pending events (or, with
 *     `--include-processed`, every event), one event per two-line
 *     block (or a single line when payload is null), in id-ascending
 *     order. `--limit N` caps output at N entries.
 *   - `nsg clock tick [id]` — process a single event. Without `id`,
 *     the next pending event in id order; with `id`, exactly that
 *     event after a CLI-side pre-check that it exists and is still
 *     pending. Prints per-dispatch summary lines via the
 *     `processEvents({ onDispatch })` observer.
 *   - `nsg clock run` — loop `processEvents()` until the dispatcher
 *     reports zero processed events for an iteration. No sleep, no
 *     daemon — finite drain. Mid-sweep arrivals are picked up on the
 *     next iteration.
 *
 * The CLI package deliberately does not depend on the clockworks or
 * stacks plugin packages — apparatus interfaces are declared inline
 * and resolved at runtime via `guild().apparatus<T>(name)`. This
 * mirrors the discipline practiced by `signal` and `start`.
 *
 * Hand-written rather than auto-built because:
 *   - `tick [id]` is an optional positional, which the auto-builder
 *     cannot express.
 *   - `--include-processed` and `--limit <N>` need locally-validated
 *     parsing.
 *   - Exit-code semantics are nontrivial: nonzero only when at least
 *     one dispatch recorded `status: error`, plus the
 *     missing-event-id and already-processed-event branches.
 *
 * See commission c-mody57g7 decisions D1–D20.
 */

import { Command } from 'commander';
import { guild } from '@shardworks/nexus-core';
import {
  clockStart,
  clockStatus,
  clockStop,
  runForegroundDaemonFromGuild,
  type ClockStatus,
} from '@shardworks/clockworks-apparatus';

import { getStartedGuild } from '../started-guild.ts';

// ── Local apparatus interface shims ──────────────────────────────────
//
// Matches the surface the CLI actually exercises — a strict subset of
// the real ClockworksApi / StacksApi / Book contracts.

interface DispatchObservationLike {
  eventId: string;
  eventName: string;
  handlerName: string;
  /**
   * Mirrors `DispatchObservation.status` from the clockworks
   * apparatus. The `'skipped'` variant covers loop-guard
   * suppression — the relay was not invoked, no SOF was emitted, and
   * `error` carries the loop-guard reason. Skipped rows must not
   * count toward operator error metrics or the CLI exit code.
   */
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  error: string | null;
}

interface ProcessEventsOptionsLike {
  eventId?: string;
  max?: number;
  onDispatch?: (observation: DispatchObservationLike) => void;
}

interface ProcessEventsSummaryLike {
  processedEvents: number;
  dispatches: number;
  errors: number;
  /**
   * Subset of `dispatches` whose status is `'skipped'`. Reported
   * separately from `errors` so the CLI exit code stays based on
   * real failures only — loop-guard skips are policy decisions, not
   * problems the operator needs to act on.
   */
  skipped: number;
}

interface ClockworksApiLike {
  processEvents(opts?: ProcessEventsOptionsLike): Promise<ProcessEventsSummaryLike>;
}

interface EventDocLike {
  id: string;
  name: string;
  payload: unknown;
  emitter: string;
  firedAt: string;
  processed: boolean;
}

interface BookLike<T> {
  get(id: string): Promise<T | null | undefined>;
  find(query: {
    where?: Array<[string, string, unknown]>;
    orderBy?: Array<[string, 'asc' | 'desc']>;
    limit?: number;
  }): Promise<T[]>;
  list(options?: {
    orderBy?: Array<[string, 'asc' | 'desc']>;
    limit?: number;
  }): Promise<T[]>;
}

interface StacksApiLike {
  book<T>(plugin: string, name: string): BookLike<T>;
}

// ── Constants (D9, D10, D13, D14, D15, D19) ──────────────────────────

/** Maximum payload-preview length for `list` (D19). */
const PAYLOAD_PREVIEW_MAX = 120;

/** Empty-queue messages — one per command (D13). */
const EMPTY_LIST = 'No pending events.';
const EMPTY_TICK = 'Queue is empty; nothing to process.';
const EMPTY_RUN = 'Queue is empty; processed 0 events.';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the loaded guild or throw the canonical no-guild error so
 * the action wrapper can convert it to an `Error: …` exit-1 line.
 */
function requireGuild(): ReturnType<typeof guild> {
  try {
    return guild();
  } catch {
    throw new Error('Not inside a guild. Run `nsg init` to create one first.');
  }
}

/**
 * Build the daemon-coexistence warning when the Clockworks daemon is
 * already running. Returns `null` when the daemon is not running so
 * callers can append it conditionally.
 *
 * The warning is non-fatal: `nsg clock tick` and `nsg clock run` keep
 * working even when the daemon is up. SQLite handles concurrent access
 * safely; the warning exists only so operators understand they may
 * see the daemon process the same events first.
 */
function daemonCoexistenceWarning(home: string): string | null {
  const status = clockStatus(home);
  if (!status.running) return null;
  return (
    `Warning: clockworks daemon is running (pid ${status.pid}); ` +
    `this manual invocation will run concurrently. SQLite handles ` +
    `concurrent access safely.`
  );
}

/**
 * Render the payload preview for `list`. Returns null when the
 * payload is exactly null (D19 — payload line omitted entirely);
 * otherwise returns a truncated JSON string.
 */
export function renderPayloadPreview(payload: unknown): string | null {
  if (payload === null) return null;
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    json = '<unserializable>';
  }
  if (json === undefined) return null;
  if (json.length <= PAYLOAD_PREVIEW_MAX) return json;
  // Reserve one char for the trailing ellipsis.
  return json.slice(0, PAYLOAD_PREVIEW_MAX - 1) + '…';
}

/**
 * Format a single event for `nsg clock list`. Two lines when payload
 * is non-null; single line otherwise.
 */
export function formatEventBlock(event: EventDocLike): string {
  const head = `${event.id}  ${event.name}  ${event.emitter}  ${event.firedAt}`;
  const preview = renderPayloadPreview(event.payload);
  if (preview === null) return head;
  return `${head}\n  payload: ${preview}`;
}

/**
 * Format a single dispatch observation for the per-dispatch summary
 * line emitted by `tick` and `run`. Per D10:
 *   `[<handlerName>] <status> <durationMs>ms`
 * With `: <error>` appended on the same line when `status` is error.
 *
 * Loop-guard `'skipped'` rows render as
 *   `[<handlerName>] skipped: <loop-guard reason>`
 * — the same colon-then-message convention as the error arm so output
 * stays parseable. Skipped lines do NOT include a duration (the
 * dispatcher never invoked the relay; surfacing `0ms` would only
 * mislead operators).
 */
export function formatDispatchLine(obs: DispatchObservationLike): string {
  if (obs.status === 'skipped') {
    const head = `[${obs.handlerName}] skipped`;
    return obs.error ? `${head}: ${obs.error}` : head;
  }
  const head = `[${obs.handlerName}] ${obs.status} ${obs.durationMs}ms`;
  if (obs.status === 'error' && obs.error) {
    return `${head}: ${obs.error}`;
  }
  return head;
}

// ── list ─────────────────────────────────────────────────────────────

export interface ListInput {
  /** Include processed events in addition to pending ones. */
  includeProcessed?: boolean;
  /** Cap output at this many entries; no default — undefined prints all. */
  limit?: number;
}

export interface ListOutput {
  /** Lines to print (already formatted). */
  lines: string[];
  /** Number of events rendered (after the limit cap, after the filter). */
  count: number;
  /** Whether the queue (matching the filter) was empty. */
  empty: boolean;
}

/**
 * Read events for `nsg clock list` and render them.
 *
 * The book read uses `find` with a `where` filter when only pending
 * events are wanted (the common case); otherwise `list` with no
 * filter (the `--include-processed` path).
 */
export async function runList(input: ListInput): Promise<ListOutput> {
  const g = requireGuild();
  const stacks = g.apparatus<StacksApiLike>('stacks');
  const events = stacks.book<EventDocLike>('clockworks', 'events');

  const orderBy: Array<[string, 'asc' | 'desc']> = [['id', 'asc']];

  let rows: EventDocLike[];
  if (input.includeProcessed) {
    const opts: { orderBy: Array<[string, 'asc' | 'desc']>; limit?: number } = { orderBy };
    if (input.limit !== undefined) opts.limit = input.limit;
    rows = await events.list(opts);
  } else {
    const query: {
      where: Array<[string, string, unknown]>;
      orderBy: Array<[string, 'asc' | 'desc']>;
      limit?: number;
    } = {
      where: [['processed', '=', false]],
      orderBy,
    };
    if (input.limit !== undefined) query.limit = input.limit;
    rows = await events.find(query);
  }

  if (rows.length === 0) {
    return { lines: [EMPTY_LIST], count: 0, empty: true };
  }

  const lines: string[] = [];
  for (const row of rows) {
    lines.push(formatEventBlock(row));
  }
  return { lines, count: rows.length, empty: false };
}

// ── tick ─────────────────────────────────────────────────────────────

export interface TickInput {
  /** Optional event id to process. When omitted, the next pending event. */
  eventId?: string;
}

export interface TickOutput {
  /** Lines to print (in order). */
  lines: string[];
  /** Whether at least one dispatch row recorded `status: error`. */
  hadError: boolean;
  /** Whether the targeted/queue lookup found nothing to do. */
  empty: boolean;
  /** Set when an explicit eventId was supplied but does not exist. */
  notFound: boolean;
  /** Set when an explicit eventId was supplied but is already processed. */
  alreadyProcessed: boolean;
  /**
   * Warning lines to write to stderr before the main output. Currently
   * carries the daemon-coexistence warning when `nsg clock start` is
   * already running.
   */
  warnings: string[];
}

/**
 * Process a single event via `processEvents({ eventId })` or
 * `processEvents({ max: 1 })` and capture the per-dispatch summary
 * lines via the observer.
 *
 * The `events.get(id)` pre-check happens here per D4: missing-id and
 * already-processed cases never reach the dispatcher.
 */
export async function runTick(input: TickInput): Promise<TickOutput> {
  const g = requireGuild();
  const clockworks = g.apparatus<ClockworksApiLike>('clockworks');
  const stacks = g.apparatus<StacksApiLike>('stacks');
  const events = stacks.book<EventDocLike>('clockworks', 'events');

  // Daemon-coexistence warning — emitted independently of the
  // dispatch outcome so operators always see whether they're racing
  // the daemon. Best-effort: a thrown clockStatus must not block tick.
  const warnings: string[] = [];
  try {
    const w = daemonCoexistenceWarning(g.home);
    if (w) warnings.push(w);
  } catch {
    // ignore — diagnostic warning, not load-bearing
  }

  const lines: string[] = [];

  // Capture the targeted event row (or the next-pending one) so we can
  // surface the no-match line per D16 without re-reading the book
  // after the sweep.
  let targetEvent: EventDocLike | null | undefined;

  if (input.eventId !== undefined) {
    targetEvent = await events.get(input.eventId);
    if (!targetEvent) {
      return {
        lines: [`Error: clockworks: event "${input.eventId}" not found in events book.`],
        hadError: true,
        empty: false,
        notFound: true,
        alreadyProcessed: false,
        warnings,
      };
    }
    if (targetEvent.processed) {
      return {
        lines: [
          `Warning: clockworks: event "${input.eventId}" has already been processed.`,
        ],
        hadError: true,
        empty: false,
        notFound: false,
        alreadyProcessed: true,
        warnings,
      };
    }
  } else {
    // Next-pending mode: peek ahead so we know which event the
    // dispatcher will pick up. Using the same id-ascending order as
    // the dispatcher's own find call so the peek matches.
    const peek = await events.find({
      where: [['processed', '=', false]],
      orderBy: [['id', 'asc']],
      limit: 1,
    });
    targetEvent = peek[0] ?? null;
    if (!targetEvent) {
      return {
        lines: [EMPTY_TICK],
        hadError: false,
        empty: true,
        notFound: false,
        alreadyProcessed: false,
        warnings,
      };
    }
  }

  const observedEventIds = new Set<string>();
  const opts: ProcessEventsOptionsLike = {
    onDispatch: (obs) => {
      observedEventIds.add(obs.eventId);
      lines.push(formatDispatchLine(obs));
    },
  };
  if (input.eventId !== undefined) {
    opts.eventId = input.eventId;
  } else {
    opts.max = 1;
  }

  const summary = await clockworks.processEvents(opts);

  // The empty-queue branch is handled above for the next-pending mode.
  // For the explicit-id mode, summary.processedEvents will be 1 — the
  // pre-check already eliminated the missing/already-processed cases.
  // Defensive fall-through: if somehow nothing was processed, treat
  // it like an empty queue.
  if (summary.processedEvents === 0) {
    return {
      lines: [EMPTY_TICK],
      hadError: false,
      empty: true,
      notFound: false,
      alreadyProcessed: false,
      warnings,
    };
  }

  // D16: a processed event with zero dispatch observations means
  // there were no matching standing orders. Surface a single visibility
  // line so operators don't see silence.
  if (targetEvent && !observedEventIds.has(targetEvent.id)) {
    lines.push(
      `${targetEvent.id} ${targetEvent.name} (no matching standing orders)`,
    );
  }

  // D20: zero matching standing orders → exit 0.
  return {
    lines,
    hadError: summary.errors > 0,
    empty: false,
    notFound: false,
    alreadyProcessed: false,
    warnings,
  };
}

// ── run ──────────────────────────────────────────────────────────────

export interface RunOutput {
  /** Lines to print (in dispatch order, plus the final count). */
  lines: string[];
  /** Whether at least one dispatch row across every iteration was an error. */
  hadError: boolean;
  /** Total events processed across all iterations. */
  totalProcessed: number;
  /** Whether the very first iteration found an empty queue. */
  empty: boolean;
  /**
   * Warning lines to write to stderr before the main output. Currently
   * carries the daemon-coexistence warning when `nsg clock start` is
   * already running.
   */
  warnings: string[];
}

/**
 * Drain the queue. Loop `processEvents()` until it reports zero
 * processed events for an iteration. No sleep, no daemon. Per-dispatch
 * summary lines emit as they happen via the observer; the final
 * `processed N events` line goes out at the end.
 */
export async function runRun(): Promise<RunOutput> {
  const g = requireGuild();
  const clockworks = g.apparatus<ClockworksApiLike>('clockworks');
  const stacks = g.apparatus<StacksApiLike>('stacks');
  const events = stacks.book<EventDocLike>('clockworks', 'events');

  // Daemon-coexistence warning — emitted independently of the drain
  // outcome.
  const warnings: string[] = [];
  try {
    const w = daemonCoexistenceWarning(g.home);
    if (w) warnings.push(w);
  } catch {
    // ignore — diagnostic warning, not load-bearing
  }

  const lines: string[] = [];
  let totalProcessed = 0;
  let totalErrors = 0;
  let firstIterationEmpty = false;

  // Track which event ids produced at least one dispatch row this
  // process so we can surface "(no matching standing orders)" for the
  // ones that didn't.
  const seenDispatchEventIds = new Set<string>();

  for (;;) {
    // D16: capture the set of events the dispatcher will see this
    // sweep so we can surface "(no matching standing orders)" lines
    // for events that produced zero dispatch observations. `run` has
    // no max cap, so every event in this snapshot will be flipped
    // before the sweep returns.
    const pendingBefore = await events.find({
      where: [['processed', '=', false]],
      orderBy: [['id', 'asc']],
    });

    const summary = await clockworks.processEvents({
      onDispatch: (obs) => {
        seenDispatchEventIds.add(obs.eventId);
        lines.push(formatDispatchLine(obs));
      },
    });

    if (summary.processedEvents === 0) {
      if (totalProcessed === 0) firstIterationEmpty = true;
      break;
    }

    for (const ev of pendingBefore) {
      if (!seenDispatchEventIds.has(ev.id)) {
        lines.push(`${ev.id} ${ev.name} (no matching standing orders)`);
        // Defensive: prevent re-emission if a later sweep would see
        // the same id (it shouldn't — the row is now processed —
        // but the guard keeps the line idempotent).
        seenDispatchEventIds.add(ev.id);
      }
    }

    totalProcessed += summary.processedEvents;
    totalErrors += summary.errors;
  }

  if (firstIterationEmpty) {
    return {
      lines: [EMPTY_RUN],
      hadError: false,
      totalProcessed: 0,
      empty: true,
      warnings,
    };
  }

  lines.push(`processed ${totalProcessed} events`);

  return {
    lines,
    hadError: totalErrors > 0,
    totalProcessed,
    empty: false,
    warnings,
  };
}

// ── start / stop / status ────────────────────────────────────────────

export interface StartInput {
  /** Polling interval in milliseconds. Forwarded to `clockStart`. */
  interval?: number;
  /**
   * When `true`, run the inline foreground daemon body instead of
   * spawning a detached child. The detached `clock start` re-execs
   * itself with this flag.
   */
  foreground?: boolean;
}

export interface StartOutput {
  /** Lines to print. */
  lines: string[];
}

/**
 * Handle `nsg clock start`. Without `--foreground`, calls
 * `clockStart(home)`, which spawns a detached child and blocks until
 * the daemon is verified running. With `--foreground`, calls
 * `runForegroundDaemonFromGuild` — the inline daemon body that the
 * detached spawn re-execs into. The function returns only when the
 * daemon shuts down (under SIGTERM or SIGINT).
 */
export async function runStart(input: StartInput): Promise<StartOutput> {
  const g = requireGuild();

  if (input.foreground) {
    // Inline foreground daemon body. `runForegroundDaemonFromGuild`
    // installs SIGTERM/SIGINT handlers and returns once shutdown is
    // signaled. Once it returns we exit cleanly.
    //
    // Pass the StartedGuild deposited by program.ts so the daemon's
    // shutdown path runs `guildInstance.shutdown()` — and therefore
    // every started apparatus's optional `stop()` — before
    // process.exit(0).
    const startedGuild = getStartedGuild();
    const opts: Parameters<typeof runForegroundDaemonFromGuild>[0] = {
      onShutdown: () => process.exit(0),
    };
    if (input.interval !== undefined) opts.intervalMs = input.interval;
    if (startedGuild) opts.startedGuild = startedGuild;
    await runForegroundDaemonFromGuild(opts);
    // Unreachable — onShutdown exits the process.
    return { lines: [] };
  }

  const startOpts: { interval?: number } = {};
  if (input.interval !== undefined) startOpts.interval = input.interval;
  const result = await clockStart(g.home, startOpts);
  return {
    lines: [
      `Clockworks daemon started (pid: ${result.pid})`,
      `  Log file: ${result.logFile}`,
    ],
  };
}

export interface StopOutput {
  /** Lines to print. */
  lines: string[];
}

/**
 * Handle `nsg clock stop`. Thin wrapper around `clockStop`.
 *
 * Per spec: missing-pidfile and stale-pidfile cases exit zero with a
 * message — they are not errors. The success-path message comes from
 * the core API result so the three branches (`'signaled'`,
 * `'no-pidfile'`, `'stale'`) stay aligned across CLI / programmatic
 * consumers.
 */
export async function runStop(): Promise<StopOutput> {
  const g = requireGuild();
  const result = await clockStop(g.home);
  return { lines: [result.message] };
}

export interface StatusInput {
  /** Emit JSON instead of multi-line plain text. */
  json?: boolean;
}

export interface StatusOutput {
  /** Lines to print. */
  lines: string[];
  /** The structured status, included unconditionally so tests can assert it. */
  status: ClockStatus;
}

/**
 * Handle `nsg clock status`. Defaults to multi-line plain text;
 * `--json` emits the structured shape verbatim. The output mirrors
 * the `clock-status` MCP tool's payload so the surfaces stay aligned.
 */
export function runStatus(input: StatusInput): StatusOutput {
  const g = requireGuild();
  const status = clockStatus(g.home);

  if (input.json) {
    return { lines: [JSON.stringify(status, null, 2)], status };
  }

  if (!status.running) {
    if (status.stalePidfile) {
      return {
        lines: [
          'Clockworks daemon: not running.',
          '  (Stale pidfile detected and removed.)',
        ],
        status,
      };
    }
    return { lines: ['Clockworks daemon: not running.'], status };
  }

  const lines = [
    'Clockworks daemon: running',
    `  PID:       ${status.pid}`,
    `  Log file:  ${status.logFile}`,
    `  Uptime:    ${formatUptime(status.uptime ?? 0)}`,
  ];
  return { lines, status };
}

/** Format a millisecond uptime as a short human-readable string. */
function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h${remMinutes}m${remSeconds}s`;
}

// ── Commander Command ────────────────────────────────────────────────

/**
 * Parse and validate the `--limit <N>` flag for `list`. Commander
 * surfaces flag values as strings; we want a positive integer.
 */
function parseLimitOption(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`clock list: --limit must be a positive integer, got "${raw}".`);
  }
  return n;
}

/**
 * Parse and validate the `--interval <ms>` flag for `start`. Mirrors
 * the fail-loud pattern of `parseLimitOption`.
 */
function parseIntervalOption(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`clock start: --interval must be a positive integer (ms), got "${raw}".`);
  }
  return n;
}

/**
 * Build the `nsg clock` Commander Command — the parent group plus the
 * three subcommands. Each subcommand's action wrapper translates the
 * structured handler output to printed lines and `process.exit(N)` per
 * commission decision D8.
 */
export function buildClockCommand(): Command {
  const cmd = new Command('clock').description('Clockworks operator commands');

  // ── list ──────────────────────────────────────────────────────────

  const list = new Command('list')
    .description('List events in the Clockworks events book.')
    .option(
      '--include-processed',
      'Include processed events in addition to pending ones.',
    )
    .option(
      '--limit <n>',
      'Cap output at N entries. Without this flag, every matching event prints.',
      parseLimitOption,
    )
    .action(
      async (opts: { includeProcessed?: boolean; limit?: number }) => {
        try {
          const out = await runList({
            includeProcessed: opts.includeProcessed,
            limit: opts.limit,
          });
          for (const line of out.lines) console.log(line);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );

  // ── tick ──────────────────────────────────────────────────────────

  const tick = new Command('tick')
    .description(
      'Process a single event (next pending, or the supplied id).',
    )
    .argument('[id]', 'Event id to process. Omit to take the next pending event.')
    .action(async (id: string | undefined) => {
      try {
        const out = await runTick({ eventId: id });
        // Daemon-coexistence warning(s) go to stderr first so the
        // operator notices them ahead of the dispatch summary.
        for (const w of out.warnings) console.error(w);
        // D8: print first, then explicitly exit non-zero — keeps the
        // structured summary intact ahead of any "Error: …" prefix.
        for (const line of out.lines) {
          if (line.startsWith('Error:') || line.startsWith('Warning:')) {
            console.error(line);
          } else {
            console.log(line);
          }
        }
        if (out.notFound || out.alreadyProcessed) {
          process.exit(1);
        }
        if (out.hadError) {
          process.exit(1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── run ───────────────────────────────────────────────────────────

  const run = new Command('run')
    .description(
      'Drain the queue. Loops processEvents() until zero events are processed.',
    )
    .action(async () => {
      try {
        const out = await runRun();
        for (const w of out.warnings) console.error(w);
        for (const line of out.lines) console.log(line);
        if (out.hadError) {
          process.exit(1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── start ─────────────────────────────────────────────────────────

  const start = new Command('start')
    .description('Start the Clockworks daemon (detached background process).')
    .option(
      '--interval <ms>',
      'Polling interval in milliseconds (default 2000).',
      parseIntervalOption,
    )
    .option(
      '-f, --foreground',
      'Run the daemon body inline in this process (used by the detached re-exec).',
    )
    .action(async (opts: { interval?: number; foreground?: boolean }) => {
      try {
        const input: StartInput = {};
        if (opts.interval !== undefined) input.interval = opts.interval;
        if (opts.foreground) input.foreground = true;
        const out = await runStart(input);
        for (const line of out.lines) console.log(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── stop ──────────────────────────────────────────────────────────

  const stop = new Command('stop')
    .description('Stop the Clockworks daemon (graceful SIGTERM with SIGKILL escalation).')
    .action(async () => {
      try {
        const out = await runStop();
        for (const line of out.lines) console.log(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── status ────────────────────────────────────────────────────────

  const status = new Command('status')
    .description('Show whether the Clockworks daemon is running.')
    .option('--json', 'Output the structured status as JSON.')
    .action((opts: { json?: boolean }) => {
      try {
        const input: StatusInput = {};
        if (opts.json) input.json = true;
        const out = runStatus(input);
        for (const line of out.lines) console.log(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  cmd.addCommand(list);
  cmd.addCommand(tick);
  cmd.addCommand(run);
  cmd.addCommand(start);
  cmd.addCommand(stop);
  cmd.addCommand(status);

  return cmd;
}
