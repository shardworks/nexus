/**
 * Event signalling — persists events to the Clockworks event queue.
 *
 * signalEvent() is the write path. It records an immutable fact in the events
 * table. It does NOT process the event — the Clockworks runner handles that
 * separately via `nsg clock`.
 */
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';
import { generateId } from './id.ts';
import type { GuildEvent } from './engine.ts';

/** Reserved framework event namespaces. Animas cannot signal these. */
const FRAMEWORK_NAMESPACES = [
  'anima.',
  'commission.',
  'mandate.',
  'summon.',
  'tool.',
  'migration.',
  'guild.',
  'standing-order.',
  'session.',
];

/**
 * Check if an event name is in a reserved framework namespace.
 */
export function isFrameworkEvent(name: string): boolean {
  return FRAMEWORK_NAMESPACES.some(ns => name.startsWith(ns));
}

/**
 * Validate that a custom event name is declared in guild.json clockworks.events.
 * Throws if the name is in a reserved namespace or not declared.
 */
export function validateCustomEvent(home: string, name: string): void {
  if (isFrameworkEvent(name)) {
    throw new Error(
      `Event "${name}" is in a reserved framework namespace. ` +
      `Animas and operators can only signal custom events declared in guild.json.`,
    );
  }

  const config = readGuildConfig(home);
  const declaredEvents = config.clockworks?.events ?? {};
  if (!Object.hasOwn(declaredEvents, name)) {
    const available = Object.keys(declaredEvents);
    throw new Error(
      `Event "${name}" is not declared in guild.json clockworks.events. ` +
      `Declared events: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }
}

/**
 * Signal an event — persist it to the Clockworks events table.
 *
 * Does not process the event. The Clockworks runner processes separately.
 *
 * @param home - Absolute path to the guild root.
 * @param name - Event name (e.g. "commission.sealed", "code.reviewed").
 * @param payload - Event-specific data (JSON-serializable).
 * @param emitter - Who signaled it: anima name, engine name, or "framework".
 * @returns The event id.
 */
export function signalEvent(
  home: string,
  name: string,
  payload: unknown,
  emitter: string,
): string {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const id = generateId('evt');
    db.prepare(
      `INSERT INTO events (id, name, payload, emitter) VALUES (?, ?, ?, ?)`,
    ).run(id, name, payload != null ? JSON.stringify(payload) : null, emitter);

    return id;
  } finally {
    db.close();
  }
}

/**
 * Read pending (unprocessed) events from the Clockworks event queue, ordered by fired_at.
 */
export function readPendingEvents(home: string): GuildEvent[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const rows = db.prepare(
      `SELECT id, name, payload, emitter, fired_at FROM events WHERE processed = 0 ORDER BY fired_at, rowid`,
    ).all() as { id: string; name: string; payload: string | null; emitter: string; fired_at: string }[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      payload: row.payload ? JSON.parse(row.payload) : null,
      emitter: row.emitter,
      firedAt: row.fired_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * Read a single event by id.
 */
export function readEvent(home: string, id: string): GuildEvent | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT id, name, payload, emitter, fired_at FROM events WHERE id = ?`,
    ).get(id) as { id: string; name: string; payload: string | null; emitter: string; fired_at: string } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      payload: row.payload ? JSON.parse(row.payload) : null,
      emitter: row.emitter,
      firedAt: row.fired_at,
    };
  } finally {
    db.close();
  }
}

/**
 * Mark an event as processed.
 */
export function markEventProcessed(home: string, eventId: string): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    db.prepare(`UPDATE events SET processed = 1 WHERE id = ?`).run(eventId);
  } finally {
    db.close();
  }
}

// ── Dashboard Read Types ────────────────────────────────────────────────

export interface ListEventsOptions {
  /** Filter by event name pattern (SQL LIKE — use % for wildcards). */
  name?: string;
  /** Filter by emitter. */
  emitter?: string;
  /** If true, only unprocessed events. If false, only processed. Omit for all. */
  pending?: boolean;
  /** Maximum number of results. */
  limit?: number;
}

export interface DispatchRecord {
  id: string;
  eventId: string;
  handlerType: string;
  handlerName: string;
  targetRole: string | null;
  noticeType: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string | null;
  error: string | null;
}

export interface ListDispatchesOptions {
  eventId?: string;
  handlerType?: string;
  handlerName?: string;
  status?: string;
  /** Maximum number of results. */
  limit?: number;
}

// ── Dashboard Read Functions ────────────────────────────────────────────

/**
 * List events with optional filters. Returns all events (not just pending),
 * ordered by fired_at descending (newest first).
 */
export function listEvents(home: string, opts: ListEventsOptions = {}): GuildEvent[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT id, name, payload, emitter, fired_at, processed FROM events`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.name) {
      conditions.push(`name LIKE ?`);
      params.push(opts.name);
    }

    if (opts.emitter) {
      conditions.push(`emitter = ?`);
      params.push(opts.emitter);
    }

    if (opts.pending === true) {
      conditions.push(`processed = 0`);
    } else if (opts.pending === false) {
      conditions.push(`processed = 1`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY fired_at DESC, rowid DESC`;

    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; name: string; payload: string | null; emitter: string; fired_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      payload: row.payload ? JSON.parse(row.payload) : null,
      emitter: row.emitter,
      firedAt: row.fired_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * List event dispatches with optional filters.
 */
export function listDispatches(home: string, opts: ListDispatchesOptions = {}): DispatchRecord[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT id, event_id, handler_type, handler_name, target_role, notice_type,
                        started_at, ended_at, status, error
                 FROM event_dispatches`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.eventId) {
      conditions.push(`event_id = ?`);
      params.push(opts.eventId);
    }
    if (opts.handlerType) {
      conditions.push(`handler_type = ?`);
      params.push(opts.handlerType);
    }
    if (opts.handlerName) {
      conditions.push(`handler_name = ?`);
      params.push(opts.handlerName);
    }
    if (opts.status) {
      conditions.push(`status = ?`);
      params.push(opts.status);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY started_at DESC`;

    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; event_id: string; handler_type: string; handler_name: string;
      target_role: string | null; notice_type: string | null;
      started_at: string | null; ended_at: string | null;
      status: string | null; error: string | null;
    }>;

    return rows.map(r => ({
      id: r.id,
      eventId: r.event_id,
      handlerType: r.handler_type,
      handlerName: r.handler_name,
      targetRole: r.target_role,
      noticeType: r.notice_type,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      error: r.error,
    }));
  } finally {
    db.close();
  }
}

/**
 * Record an event dispatch in the event_dispatches table.
 */
export function recordDispatch(
  home: string,
  opts: {
    eventId: string;
    handlerType: 'engine' | 'anima';
    handlerName: string;
    targetRole?: string;
    noticeType?: 'summon' | 'brief';
    startedAt: string;
    endedAt: string;
    status: 'success' | 'error';
    error?: string;
  },
): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    db.prepare(
      `INSERT INTO event_dispatches (id, event_id, handler_type, handler_name, target_role, notice_type, started_at, ended_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId('ed'),
      opts.eventId,
      opts.handlerType,
      opts.handlerName,
      opts.targetRole ?? null,
      opts.noticeType ?? null,
      opts.startedAt,
      opts.endedAt,
      opts.status,
      opts.error ?? null,
    );
  } finally {
    db.close();
  }
}
