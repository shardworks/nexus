/**
 * Writ — the unified work tracking primitive.
 *
 * Replaces the rigid four-level hierarchy (work, piece, job, stroke) with
 * a single typed, tree-structured model. Every summon gets a writ. Writs
 * are the system's memory of outstanding obligations.
 *
 * Status lifecycle:
 *   ready → active → completed
 *                  → failed
 *                  → pending → ready (cycle)
 *          → cancelled
 *
 * See docs/writs.md for the full design.
 */
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';
import { generateId } from './id.ts';
import { signalEvent } from './events.ts';

// ── Types ──────────────────────────────────────────────────────────────

export type WritStatus = 'ready' | 'active' | 'pending' | 'completed' | 'failed' | 'cancelled';

export interface WritRecord {
  id: string;
  type: string;
  title: string;
  description: string | null;
  status: WritStatus;
  parentId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWritOptions {
  type: string;
  title: string;
  description?: string;
  parentId?: string;
}

export interface ListWritsOptions {
  parentId?: string;
  type?: string;
  status?: WritStatus;
}

export interface WritChildSummary {
  id: string;
  type: string;
  title: string;
  status: WritStatus;
  childCount: number;
  completedCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Built-in writ types that don't need guild.json declaration. */
export const BUILTIN_WRIT_TYPES = ['mandate', 'summon'] as const;

// ── Internal helpers ───────────────────────────────────────────────────

interface WritRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  parent_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: WritRow): WritRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status as WritStatus,
    parentId: row.parent_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS = `id, type, title, description, status, parent_id, session_id, created_at, updated_at`;

function readWritById(db: Database.Database, writId: string): WritRecord | null {
  const row = db.prepare(
    `SELECT ${SELECT_COLS} FROM writs WHERE id = ?`,
  ).get(writId) as WritRow | undefined;
  return row ? rowToRecord(row) : null;
}

// ── Type Validation ────────────────────────────────────────────────────

/**
 * Validate that a writ type is declared in guild.json or is a built-in type.
 * Throws if the type is unknown.
 */
export function validateWritType(home: string, type: string): void {
  if ((BUILTIN_WRIT_TYPES as readonly string[]).includes(type)) return;
  const config = readGuildConfig(home);
  const declared = config.writTypes ?? {};
  if (!Object.hasOwn(declared, type)) {
    const available = [
      ...BUILTIN_WRIT_TYPES,
      ...Object.keys(declared),
    ];
    throw new Error(
      `Writ type "${type}" is not declared in guild.json writTypes. ` +
      `Available types: ${available.join(', ')}`,
    );
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a writ. Validates type against guild.json. Fires `<type>.ready`.
 */
export function createWrit(home: string, opts: CreateWritOptions): WritRecord {
  validateWritType(home, opts.type);

  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const id = generateId('wrt');

    db.prepare(
      `INSERT INTO writs (id, type, title, description, parent_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, opts.type, opts.title, opts.description ?? null, opts.parentId ?? null);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_created', 'writ', id, JSON.stringify(opts));

    const record = readWritById(db, id)!;

    signalEvent(home, `${opts.type}.ready`, {
      writId: id,
      parentId: opts.parentId ?? null,
      type: opts.type,
    }, 'framework');

    return record;
  } finally {
    db.close();
  }
}

/**
 * Read a single writ by ID.
 */
export function readWrit(home: string, writId: string): WritRecord | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    return readWritById(db, writId);
  } finally {
    db.close();
  }
}

/**
 * List writs with optional filters.
 */
export function listWrits(home: string, opts: ListWritsOptions = {}): WritRecord[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    let query = `SELECT ${SELECT_COLS} FROM writs`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.parentId !== undefined) {
      if (opts.parentId === null) {
        conditions.push(`parent_id IS NULL`);
      } else {
        conditions.push(`parent_id = ?`);
        params.push(opts.parentId);
      }
    }
    if (opts.type) {
      conditions.push(`type = ?`);
      params.push(opts.type);
    }
    if (opts.status) {
      conditions.push(`status = ?`);
      params.push(opts.status);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ` ORDER BY created_at DESC`;

    const rows = db.prepare(query).all(...params) as WritRow[];
    return rows.map(rowToRecord);
  } finally {
    db.close();
  }
}

// ── Status Transitions ─────────────────────────────────────────────────

/**
 * Activate a writ: ready → active. Sets session_id. No event fired.
 */
export function activateWrit(home: string, writId: string, sessionId: string): WritRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const current = readWritById(db, writId);
    if (!current) throw new Error(`Writ "${writId}" not found.`);
    if (current.status !== 'ready') {
      throw new Error(`Cannot activate writ "${writId}" — status is "${current.status}", expected "ready".`);
    }

    db.prepare(
      `UPDATE writs SET status = 'active', session_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(sessionId, writId);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_activated', 'writ', writId, JSON.stringify({ sessionId }));

    return readWritById(db, writId)!;
  } finally {
    db.close();
  }
}

/**
 * Complete a writ. Called by complete-session.
 * - No children or all children complete → completed, fires <type>.completed, triggers rollup.
 * - Incomplete children exist → pending. No event fired.
 */
export function completeWrit(home: string, writId: string): WritRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const current = readWritById(db, writId);
    if (!current) throw new Error(`Writ "${writId}" not found.`);
    if (current.status !== 'active') {
      throw new Error(`Cannot complete writ "${writId}" — status is "${current.status}", expected "active".`);
    }

    // Check children
    const children = db.prepare(
      `SELECT status FROM writs WHERE parent_id = ?`,
    ).all(writId) as { status: string }[];

    const hasIncomplete = children.some(c =>
      c.status !== 'completed' && c.status !== 'cancelled',
    );

    if (children.length > 0 && hasIncomplete) {
      // Incomplete children → pending
      db.prepare(
        `UPDATE writs SET status = 'pending', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(writId);

      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(generateId('aud'), 'framework', 'writ_pending', 'writ', writId,
        JSON.stringify({ reason: 'incomplete children', childCount: children.length }));

      return readWritById(db, writId)!;
    }

    // No children or all complete → completed
    db.prepare(
      `UPDATE writs SET status = 'completed', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(writId);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_completed', 'writ', writId, null);

    // Fire completion event
    signalEvent(home, `${current.type}.completed`, {
      writId,
      parentId: current.parentId,
      type: current.type,
    }, 'framework');

    // Handle mandate → commission completion
    if (current.type === 'mandate') {
      completeMandateCommission(db, home, writId);
    }

    // Trigger rollup on parent
    if (current.parentId) {
      rollupParent(home, current.parentId);
    }

    return readWritById(db, writId)!;
  } finally {
    db.close();
  }
}

/**
 * Fail a writ. Terminal. Cascades cancellation to incomplete children.
 */
export function failWrit(home: string, writId: string): WritRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const current = readWritById(db, writId);
    if (!current) throw new Error(`Writ "${writId}" not found.`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(`Cannot fail writ "${writId}" — status is "${current.status}" (terminal).`);
    }

    db.prepare(
      `UPDATE writs SET status = 'failed', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(writId);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_failed', 'writ', writId, null);

    // Fire failure event
    signalEvent(home, `${current.type}.failed`, {
      writId,
      parentId: current.parentId,
      type: current.type,
    }, 'framework');

    // Handle mandate → commission failure
    if (current.type === 'mandate') {
      failMandateCommission(db, home, writId);
    }

    // Cascade: cancel incomplete children (not active ones — let them finish)
    cascadeCancelChildren(db, home, writId);

    return readWritById(db, writId)!;
  } finally {
    db.close();
  }
}

/**
 * Cancel a writ. Cascades cancellation to incomplete children.
 */
export function cancelWrit(home: string, writId: string): WritRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const current = readWritById(db, writId);
    if (!current) throw new Error(`Writ "${writId}" not found.`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
      throw new Error(`Cannot cancel writ "${writId}" — status is "${current.status}" (terminal).`);
    }

    db.prepare(
      `UPDATE writs SET status = 'cancelled', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(writId);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_cancelled', 'writ', writId, null);

    signalEvent(home, `${current.type}.cancelled`, {
      writId,
      parentId: current.parentId,
      type: current.type,
    }, 'framework');

    cascadeCancelChildren(db, home, writId);

    return readWritById(db, writId)!;
  } finally {
    db.close();
  }
}

/**
 * Interrupt a writ: active → ready. Session ended without complete-session
 * or fail-writ. Fires <type>.ready for re-dispatch.
 */
export function interruptWrit(home: string, writId: string): WritRecord {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const current = readWritById(db, writId);
    if (!current) throw new Error(`Writ "${writId}" not found.`);
    if (current.status !== 'active') {
      throw new Error(`Cannot interrupt writ "${writId}" — status is "${current.status}", expected "active".`);
    }

    db.prepare(
      `UPDATE writs SET status = 'ready', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(writId);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_interrupted', 'writ', writId, null);

    // Fire ready event for re-dispatch
    signalEvent(home, `${current.type}.ready`, {
      writId,
      parentId: current.parentId,
      type: current.type,
    }, 'framework');

    return readWritById(db, writId)!;
  } finally {
    db.close();
  }
}

// ── Completion Rollup ──────────────────────────────────────────────────

/**
 * Completion rollup. When a child completes, check the parent:
 * - Parent is pending and all siblings complete → parent transitions to ready
 *   (if standing order exists for <type>.ready) or auto-completes (if not).
 * - Parent is pending and siblings remain incomplete → no action.
 */
export function rollupParent(home: string, parentId: string): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const parent = readWritById(db, parentId);
    if (!parent) return;
    if (parent.status !== 'pending') return;

    // Check if all children are complete
    const children = db.prepare(
      `SELECT status FROM writs WHERE parent_id = ?`,
    ).all(parentId) as { status: string }[];

    const hasIncomplete = children.some(c =>
      c.status !== 'completed' && c.status !== 'cancelled',
    );

    if (hasIncomplete) return;

    // All children complete. Check if a standing order exists for <type>.ready
    const config = readGuildConfig(home);
    const standingOrders = config.clockworks?.standingOrders ?? [];
    const hasStandingOrder = standingOrders.some(so => so.on === `${parent.type}.ready`);

    if (hasStandingOrder) {
      // Transition to ready for re-dispatch (final integration pass)
      db.prepare(
        `UPDATE writs SET status = 'ready', updated_at = datetime('now') WHERE id = ?`,
      ).run(parentId);

      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(generateId('aud'), 'framework', 'writ_rollup_ready', 'writ', parentId,
        JSON.stringify({ reason: 'all children complete, standing order exists' }));

      signalEvent(home, `${parent.type}.ready`, {
        writId: parentId,
        parentId: parent.parentId,
        type: parent.type,
      }, 'framework');
    } else {
      // Container auto-complete: no standing order, so auto-complete
      db.prepare(
        `UPDATE writs SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
      ).run(parentId);

      db.prepare(
        `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(generateId('aud'), 'framework', 'writ_auto_completed', 'writ', parentId,
        JSON.stringify({ reason: 'all children complete, no standing order for type' }));

      signalEvent(home, `${parent.type}.completed`, {
        writId: parentId,
        parentId: parent.parentId,
        type: parent.type,
      }, 'framework');

      // Handle mandate → commission completion
      if (parent.type === 'mandate') {
        completeMandateCommission(db, home, parentId);
      }

      // Continue rollup up the tree
      if (parent.parentId) {
        // Close this db before recursing (avoids holding multiple connections)
        db.close();
        rollupParent(home, parent.parentId);
        return; // db already closed
      }
    }
  } finally {
    try { db.close(); } catch { /* already closed in recursive case */ }
  }
}

// ── Children & Progress ────────────────────────────────────────────────

/**
 * Get direct children of a writ with nested child counts.
 */
export function getWritChildren(home: string, writId: string): WritChildSummary[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');
  try {
    const rows = db.prepare(
      `SELECT w.id, w.type, w.title, w.status,
              (SELECT COUNT(*) FROM writs c WHERE c.parent_id = w.id) as child_count,
              (SELECT COUNT(*) FROM writs c WHERE c.parent_id = w.id AND c.status IN ('completed', 'cancelled')) as completed_count
       FROM writs w
       WHERE w.parent_id = ?
       ORDER BY w.created_at ASC`,
    ).all(writId) as Array<{
      id: string; type: string; title: string; status: string;
      child_count: number; completed_count: number;
    }>;

    return rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      status: r.status as WritStatus,
      childCount: r.child_count,
      completedCount: r.completed_count,
    }));
  } finally {
    db.close();
  }
}

/**
 * Build a markdown progress appendix for resumed sessions.
 * Returns null if the writ has no children.
 */
export function buildProgressAppendix(home: string, writId: string): string | null {
  const children = getWritChildren(home, writId);
  if (children.length === 0) return null;

  const lines = [
    '## Prior Progress',
    'This is a continuation of prior work. Current state of sub-items:',
    '',
  ];

  for (const child of children) {
    let icon: string;
    switch (child.status) {
      case 'completed': icon = '✓'; break;
      case 'failed': icon = '✗'; break;
      case 'cancelled': icon = '⊘'; break;
      case 'active': icon = '→'; break;
      default: icon = '○'; break; // ready, pending
    }

    let suffix = `(${child.status})`;
    if (child.childCount > 0) {
      suffix = `(${child.childCount} ${child.type}s: ${child.completedCount} completed, ${child.childCount - child.completedCount} remaining)`;
    }

    lines.push(`- ${icon} ${child.title} ${suffix}`);
  }

  return lines.join('\n');
}

// ── Prompt Template Hydration ──────────────────────────────────────────

/**
 * Hydrate a prompt template by substituting variables from event payload
 * and writ fields. Returns null if no template provided.
 *
 * Scopes:
 *   {{field}}             — event payload
 *   {{writ.field}}        — bound writ (camelCase)
 *   {{writ.parent.field}} — parent writ (one level up)
 */
export function hydratePromptTemplate(
  home: string,
  template: string | undefined,
  payload: Record<string, unknown>,
  writId: string,
): string | null {
  if (!template) return null;

  const writ = readWrit(home, writId);
  const parent = writ?.parentId ? readWrit(home, writ.parentId) : null;

  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const k = key.trim();

    if (k.startsWith('writ.parent.')) {
      const field = k.slice('writ.parent.'.length);
      if (!parent) return '';
      return String((parent as unknown as Record<string, unknown>)[field] ?? '');
    }
    if (k.startsWith('writ.')) {
      const field = k.slice('writ.'.length);
      if (!writ) return '';
      return String((writ as unknown as Record<string, unknown>)[field] ?? '');
    }
    // Direct payload field
    return String(payload[k] ?? '');
  });
}

// ── Internal Helpers ───────────────────────────────────────────────────

/**
 * Cancel all non-terminal children of a writ (recursive).
 * Active children are left alone — they'll be cancelled when their session reports back.
 */
function cascadeCancelChildren(db: Database.Database, home: string, parentId: string): void {
  const children = db.prepare(
    `SELECT id, type, status FROM writs WHERE parent_id = ?`,
  ).all(parentId) as Array<{ id: string; type: string; status: string }>;

  for (const child of children) {
    if (child.status === 'completed' || child.status === 'failed' || child.status === 'cancelled') {
      continue; // terminal — leave it
    }
    if (child.status === 'active') {
      continue; // let active sessions finish; they'll be cancelled on report-back
    }

    // Cancel ready or pending children
    db.prepare(
      `UPDATE writs SET status = 'cancelled', session_id = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(child.id);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'writ_cascade_cancelled', 'writ', child.id,
      JSON.stringify({ reason: 'parent failed/cancelled' }));

    signalEvent(home, `${child.type}.cancelled`, {
      writId: child.id,
      parentId,
      type: child.type,
    }, 'framework');

    // Recurse into this child's children
    cascadeCancelChildren(db, home, child.id);
  }
}

/**
 * When a mandate writ completes, mark its commission as completed.
 */
function completeMandateCommission(db: Database.Database, home: string, writId: string): void {
  const row = db.prepare(
    `SELECT id FROM commissions WHERE writ_id = ?`,
  ).get(writId) as { id: string } | undefined;

  if (row) {
    db.prepare(
      `UPDATE commissions SET status = 'completed', status_reason = 'mandate completed', updated_at = datetime('now') WHERE id = ?`,
    ).run(row.id);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'commission_completed', 'commission', row.id,
      JSON.stringify({ mandateWritId: writId }));

    signalEvent(home, 'commission.completed', { commissionId: row.id }, 'framework');
  }
}

/**
 * When a mandate writ fails, mark its commission as failed.
 * Mirror of completeMandateCommission.
 */
function failMandateCommission(db: Database.Database, home: string, writId: string): void {
  const row = db.prepare(
    `SELECT id FROM commissions WHERE writ_id = ?`,
  ).get(writId) as { id: string } | undefined;

  if (row) {
    db.prepare(
      `UPDATE commissions SET status = 'failed', status_reason = 'mandate failed', updated_at = datetime('now') WHERE id = ?`,
    ).run(row.id);

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId('aud'), 'framework', 'commission_failed', 'commission', row.id,
      JSON.stringify({ mandateWritId: writId }));

    signalEvent(home, 'commission.failed', { commissionId: row.id }, 'framework');
  }
}
