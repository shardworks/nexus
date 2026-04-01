/**
 * Audit log — read-only queries for the Daybook audit trail.
 *
 * Write operations happen inline in the modules that produce audit entries
 * (commission.ts, anima.ts, work.ts, etc.). This module provides the
 * read surface for dashboard and forensic queries.
 */
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';

// ── Types ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  timestamp: string;
}

export interface ListAuditLogOptions {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Maximum number of results. */
  limit?: number;
}

// ── Functions ──────────────────────────────────────────────────────────

/**
 * List audit log entries with optional filters.
 * Ordered by timestamp descending (newest first).
 */
export function listAuditLog(home: string, opts: ListAuditLogOptions = {}): AuditEntry[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT id, actor, action, target_type, target_id, detail, timestamp FROM audit_log`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.actor) {
      conditions.push(`actor = ?`);
      params.push(opts.actor);
    }
    if (opts.action) {
      conditions.push(`action = ?`);
      params.push(opts.action);
    }
    if (opts.targetType) {
      conditions.push(`target_type = ?`);
      params.push(opts.targetType);
    }
    if (opts.targetId) {
      conditions.push(`target_id = ?`);
      params.push(opts.targetId);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY timestamp DESC`;

    if (opts.limit) {
      query += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string; actor: string; action: string;
      target_type: string | null; target_id: string | null;
      detail: string | null; timestamp: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      timestamp: r.timestamp,
    }));
  } finally {
    db.close();
  }
}
