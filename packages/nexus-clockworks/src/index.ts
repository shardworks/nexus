/**
 * nexus-clockworks — Rig export and TypeScript API.
 *
 * ## Rig export (default)
 *
 * The default export satisfies the `Rig` interface. Arbor reads it
 * at startup to register tools and create Books tables.
 *
 * ## TypeScript API (named exports)
 *
 * These functions are the internal API surface for other framework modules
 * (writ.ts, session.ts, etc.) that need to signal events or read the event
 * queue without a full RigContext. They accept `home: string` directly.
 *
 * Once those modules are also riggified, callers should migrate to using
 * RigContext.rigBook('nexus-clockworks', 'events') for read access, and
 * importing signalEvent with a RigContext for write access.
 */

import type { Rig, ToolDefinition } from '@shardworks/nexus-core';
import { books } from './books.ts';

// ── Tools ─────────────────────────────────────────────────────────────

import signalTool from './tools/signal.ts';
import eventListTool from './tools/event-list.ts';
import eventShowTool from './tools/event-show.ts';
import clockTickTool from './tools/clock-tick.ts';
import clockRunTool from './tools/clock-run.ts';
import clockStartTool from './tools/clock-start.ts';
import clockStopTool from './tools/clock-stop.ts';
import clockStatusTool from './tools/clock-status.ts';

// ── Rig export ────────────────────────────────────────────────────────

export default {
  tools: [
    signalTool,
    eventListTool,
    eventShowTool,
    clockTickTool,
    clockRunTool,
    clockStartTool,
    clockStopTool,
    clockStatusTool,
  ] as ToolDefinition[],
  books,
} satisfies Rig;

// ── TypeScript API — event read/write ─────────────────────────────────

export {
  signalEvent,
  validateCustomEvent,
  isFrameworkEvent,
  readPendingEvents,
  readEvent,
  markEventProcessed,
  recordDispatch,
  listEvents,
  listDispatches,
  type ListEventsOptions,
  type ListDispatchesOptions,
  type RecordDispatchOptions,
} from './lib/events-api.ts';

// ── TypeScript API — runner ────────────────────────────────────────────

export {
  clockTick,
  clockRun,
  desugarOrder,
  extractParams,
  type TickResult,
  type DispatchSummary,
  type ClockRunResult,
} from './lib/runner.ts';

// ── TypeScript API — daemon control ───────────────────────────────────

export {
  clockStart,
  clockStop,
  clockStatus,
  type ClockStartOptions,
  type ClockStartResult,
  type ClockStopResult,
  type ClockStatus,
} from './daemon-ctrl.ts';

// ── Document types ────────────────────────────────────────────────────

export type { EventDoc, DispatchDoc } from './types.ts';
