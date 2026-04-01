/**
 * Document types for the nexus-clockworks plugin.
 *
 * These are the TypeScript shapes stored in the Books (SQLite JSON documents).
 * Both types satisfy the Books requirement that `id: string` is a top-level field.
 *
 * SQL → TypeScript conventions:
 *   snake_case → camelCase
 *   TEXT NOT NULL DEFAULT (datetime('now')) → string (ISO-8601)
 *   INTEGER 0/1 (processed flag) → boolean
 *   TEXT nullable → string | null
 */

/**
 * A guild event — an immutable fact recorded in the event queue.
 *
 * Stored in the `events` book. `processed` tracks whether the Clockworks
 * runner has dispatched all matching standing orders for this event.
 *
 * Maps from legacy SQL table: `events`
 */
export interface EventDoc {
  /** Prefixed hex ID, e.g. "evt-a3f7b2c1". */
  id: string;
  /** Event name, e.g. "writ.ready" or "code.reviewed". */
  name: string;
  /** Arbitrary JSON payload — the event's context data. */
  payload: unknown;
  /** Who emitted the event: an anima name, engine name, or "framework". */
  emitter: string;
  /** ISO-8601 timestamp of when the event was signalled. */
  firedAt: string;
  /** True once the Clockworks runner has processed all matching standing orders. */
  processed: boolean;
}

/**
 * A record of one standing order execution triggered by an event.
 *
 * Stored in the `dispatches` book. Linked to an EventDoc by `eventId`.
 * Created by `recordDispatch()` after each engine invocation.
 *
 * Maps from legacy SQL table: `event_dispatches`
 */
export interface DispatchDoc {
  /** Prefixed hex ID, e.g. "ed-b4e8c3d2". */
  id: string;
  /** ID of the EventDoc that triggered this dispatch. */
  eventId: string;
  /** Whether the handler was an engine or an anima summon. */
  handlerType: 'engine' | 'anima';
  /** Name of the engine or role that handled the event. */
  handlerName: string;
  /** Role targeted by a summon dispatch, if applicable. */
  targetRole: string | null;
  /** Notice type for anima summons ("summon" | "brief"). Null for engine dispatches. */
  noticeType: string | null;
  /** ISO-8601 timestamp when dispatch began. */
  startedAt: string | null;
  /** ISO-8601 timestamp when dispatch ended. */
  endedAt: string | null;
  /** Outcome: "success" | "error". Null if the dispatch hasn't completed. */
  status: 'success' | 'error' | null;
  /** Error message if status is "error". */
  error: string | null;
}
