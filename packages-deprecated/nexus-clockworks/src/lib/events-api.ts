/**
 * Events library — the write/read API for the Clockworks event queue.
 *
 * These functions are the TypeScript API surface for the nexus-clockworks plugin.
 * They accept `home: string` (the guild root path) so they can be called from
 * anywhere — including writ.ts and session.ts — without requiring a PluginContext.
 *
 * Internal implementation note: library functions use raw SQLite against the
 * Books tables (books_nexus_clockworks_events, books_nexus_clockworks_dispatches)
 * rather than going through the Books API. This allows partial updates
 * (markEventProcessed), LIKE-based filtering (listEvents), and avoids the
 * overhead of creating a full PluginContext for each call.
 *
 * Callers outside this plugin that need read-only access should use the
 * plugin book API once cross-plugin access is supported.
 */

import { randomBytes } from 'node:crypto';
import { readGuildConfig } from '@shardworks/nexus-core';
import { openDb, EVENTS_TABLE, DISPATCHES_TABLE } from './db.ts';
import type { EventDoc, DispatchDoc } from '../types.ts';

// ── ID generation ──────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

// ── Framework event namespace guard ───────────────────────────────────

/**
 * Reserved event namespaces. Animas cannot signal events in these namespaces.
 * The framework signals them as part of its own lifecycle.
 */
const FRAMEWORK_NAMESPACES = [
  'anima.',
  'writ.',
  'summon.',
  'tool.',
  'migration.',
  'guild.',
  'standing-order.',
  'session.',
];

/** Check if an event name is in a reserved framework namespace. */
export function isFrameworkEvent(name: string): boolean {
  return FRAMEWORK_NAMESPACES.some(ns => name.startsWith(ns));
}

/**
 * Validate that a custom event name is declared in guild.json and is not
 * in a reserved framework namespace. Throws if validation fails.
 *
 * @param home - Guild root path.
 * @param name - Event name to validate.
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

// ── Write path ─────────────────────────────────────────────────────────

/**
 * Signal an event — persist it to the Clockworks event queue.
 *
 * Does NOT process the event. The Clockworks runner handles processing
 * separately via `clock-tick` or `clock-run`.
 *
 * This is the primary TypeScript API for signalling events. It accepts
 * `home: string` so it can be called from anywhere, including from
 * writ.ts and session.ts before those modules are riggified.
 *
 * @param home - Absolute path to the guild root.
 * @param name - Event name (e.g. "writ.ready", "code.reviewed").
 * @param payload - Event-specific data (JSON-serializable).
 * @param emitter - Who signalled it: anima name, engine name, or "framework".
 * @returns The new event's id.
 */
export function signalEvent(
  home: string,
  name: string,
  payload: unknown,
  emitter: string,
): string {
  const db = openDb(home);
  try {
    const id = generateId('evt');
    const doc: EventDoc = {
      id,
      name,
      payload,
      emitter,
      firedAt: new Date().toISOString(),
      processed: false,
    };
    db.prepare(
      `INSERT INTO "${EVENTS_TABLE}" (id, content) VALUES (?, ?)`,
    ).run(id, JSON.stringify(doc));
    return id;
  } finally {
    db.close();
  }
}

/**
 * Read all pending (unprocessed) events, ordered by firedAt then insertion order.
 * Used by the Clockworks runner to drain the queue.
 */
export function readPendingEvents(home: string): EventDoc[] {
  const db = openDb(home);
  try {
    // json_extract returns 0 for JSON false, 1 for JSON true
    const rows = db.prepare(
      `SELECT content FROM "${EVENTS_TABLE}"
       WHERE json_extract(content, '$.processed') = 0
       ORDER BY json_extract(content, '$.firedAt'), rowid`,
    ).all() as { content: string }[];
    return rows.map(r => JSON.parse(r.content) as EventDoc);
  } finally {
    db.close();
  }
}

/**
 * Read a single event by id.
 * Returns null if the event does not exist.
 */
export function readEvent(home: string, id: string): EventDoc | null {
  const db = openDb(home);
  try {
    const row = db.prepare(
      `SELECT content FROM "${EVENTS_TABLE}" WHERE id = ?`,
    ).get(id) as { content: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.content) as EventDoc;
  } finally {
    db.close();
  }
}

/**
 * Mark an event as processed.
 *
 * Uses a read-modify-write transaction rather than a raw JSON_SET update
 * to avoid any dependency on SQLite's JSON patch functions and to keep
 * the document shape canonical.
 */
export function markEventProcessed(home: string, eventId: string): void {
  const db = openDb(home);
  try {
    const trx = db.transaction(() => {
      const row = db.prepare(
        `SELECT content FROM "${EVENTS_TABLE}" WHERE id = ?`,
      ).get(eventId) as { content: string } | undefined;
      if (!row) return; // event already gone — silent no-op
      const doc = JSON.parse(row.content) as EventDoc;
      doc.processed = true;
      db.prepare(
        `UPDATE "${EVENTS_TABLE}" SET content = ? WHERE id = ?`,
      ).run(JSON.stringify(doc), eventId);
    });
    trx();
  } finally {
    db.close();
  }
}

// ── Dispatch records ───────────────────────────────────────────────────

/** Options for recordDispatch(). */
export interface RecordDispatchOptions {
  eventId: string;
  handlerType: 'engine' | 'anima';
  handlerName: string;
  targetRole?: string;
  noticeType?: 'summon' | 'brief';
  startedAt: string;
  endedAt: string;
  status: 'success' | 'error';
  error?: string;
}

/**
 * Record a dispatch outcome in the dispatches book.
 * Called by the Clockworks runner after each engine invocation.
 */
export function recordDispatch(home: string, opts: RecordDispatchOptions): void {
  const db = openDb(home);
  try {
    const id = generateId('ed');
    const doc: DispatchDoc = {
      id,
      eventId: opts.eventId,
      handlerType: opts.handlerType,
      handlerName: opts.handlerName,
      targetRole: opts.targetRole ?? null,
      noticeType: opts.noticeType ?? null,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      status: opts.status,
      error: opts.error ?? null,
    };
    db.prepare(
      `INSERT INTO "${DISPATCHES_TABLE}" (id, content) VALUES (?, ?)`,
    ).run(id, JSON.stringify(doc));
  } finally {
    db.close();
  }
}

// ── Dashboard read functions ───────────────────────────────────────────

/** Options for listEvents(). */
export interface ListEventsOptions {
  /** Filter by event name pattern (SQL LIKE — use % for wildcards). */
  name?: string;
  /** Filter by emitter. */
  emitter?: string;
  /**
   * Filter by processed state.
   * true → only unprocessed; false → only processed; omit → all.
   */
  pending?: boolean;
  /** Maximum number of results. */
  limit?: number;
}

/**
 * List events with optional filters. Returns events ordered by firedAt
 * descending (newest first).
 */
export function listEvents(home: string, opts: ListEventsOptions = {}): EventDoc[] {
  const db = openDb(home);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.name) {
      conditions.push(`json_extract(content, '$.name') LIKE ?`);
      params.push(opts.name);
    }
    if (opts.emitter) {
      conditions.push(`json_extract(content, '$.emitter') = ?`);
      params.push(opts.emitter);
    }
    if (opts.pending === true) {
      conditions.push(`json_extract(content, '$.processed') = 0`);
    } else if (opts.pending === false) {
      conditions.push(`json_extract(content, '$.processed') = 1`);
    }

    let sql = `SELECT content FROM "${EVENTS_TABLE}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY json_extract(content, '$.firedAt') DESC, rowid DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as { content: string }[];
    return rows.map(r => JSON.parse(r.content) as EventDoc);
  } finally {
    db.close();
  }
}

/** Options for listDispatches(). */
export interface ListDispatchesOptions {
  eventId?: string;
  handlerType?: string;
  handlerName?: string;
  status?: string;
  /** Maximum number of results. */
  limit?: number;
}

/**
 * List dispatch records with optional filters.
 */
export function listDispatches(home: string, opts: ListDispatchesOptions = {}): DispatchDoc[] {
  const db = openDb(home);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.eventId) {
      conditions.push(`json_extract(content, '$.eventId') = ?`);
      params.push(opts.eventId);
    }
    if (opts.handlerType) {
      conditions.push(`json_extract(content, '$.handlerType') = ?`);
      params.push(opts.handlerType);
    }
    if (opts.handlerName) {
      conditions.push(`json_extract(content, '$.handlerName') = ?`);
      params.push(opts.handlerName);
    }
    if (opts.status) {
      conditions.push(`json_extract(content, '$.status') = ?`);
      params.push(opts.status);
    }

    let sql = `SELECT content FROM "${DISPATCHES_TABLE}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY json_extract(content, '$.startedAt') DESC`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(sql).all(...params) as { content: string }[];
    return rows.map(r => JSON.parse(r.content) as DispatchDoc);
  } finally {
    db.close();
  }
}
