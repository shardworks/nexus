/**
 * commission — core logic for posting commissions to the guild.
 *
 * Creates a commission record in the Ledger and signals commission.posted
 * for the Clockworks. Everything downstream (worktree setup, anima summoning,
 * post-session merge) is handled by standing orders.
 */
import Database from 'better-sqlite3';
import { booksPath } from './nexus-home.ts';
import { readGuildConfig } from './guild-config.ts';
import { signalEvent } from './events.ts';
import { generateId } from './id.ts';
import { createWrit, failWrit } from './writ.ts';

export interface CommissionOptions {
  /** Absolute path to the guild root. */
  home: string;
  /** Commission specification — what needs to be done. */
  spec: string;
  /** Target workshop for the commission. */
  workshop: string;
}

export interface CommissionResult {
  /** The ID of the created commission. */
  commissionId: string;
}

/**
 * Update a commission's status and reason in the Ledger.
 */
export function updateCommissionStatus(
  home: string,
  commissionId: string,
  status: string,
  reason: string,
): void {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    db.prepare(
      `UPDATE commissions SET status = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(status, reason, commissionId);

    // When a commission fails, cascade failure to its mandate writ.
    // Mirror of completeMandateCommission() in writ.ts — the failure bridge.
    if (status === 'failed') {
      const row = db.prepare(
        `SELECT writ_id FROM commissions WHERE id = ?`,
      ).get(commissionId) as { writ_id: string | null } | undefined;

      if (row?.writ_id) {
        // Close db before calling failWrit (it opens its own connection)
        db.close();
        try {
          failWrit(home, row.writ_id);
        } catch {
          // Writ may already be in a terminal state — that's fine
        }
        return;
      }
    }
  } finally {
    try { db.close(); } catch { /* already closed in failure cascade path */ }
  }
}

/**
 * Read a commission record from the Ledger.
 */
export function readCommission(
  home: string,
  commissionId: string,
): { id: string; content: string; status: string; workshop: string; statusReason: string | null } | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT id, content, status, workshop, status_reason FROM commissions WHERE id = ?`,
    ).get(commissionId) as {
      id: string;
      content: string;
      status: string;
      workshop: string;
      status_reason: string | null;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      content: row.content,
      status: row.status,
      workshop: row.workshop,
      statusReason: row.status_reason,
    };
  } finally {
    db.close();
  }
}

// ── Completion Check Types ──────────────────────────────────────────────

export interface CompletionCheck {
  complete: boolean;
  total: number;
  done: number;
  pending: number;
  failed: number;
}

export interface CompletionResult {
  changed: boolean;
  newStatus: string;
}

// ── List / Show ────────────────────────────────────────────────────────

export interface CommissionSummary {
  id: string;
  content: string;
  status: string;
  workshop: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Extended commission detail with assignments and linked sessions. */
export interface CommissionDetail {
  id: string;
  content: string;
  status: string;
  workshop: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  assignments: Array<{ animaId: string; animaName: string; assignedAt: string }>;
  sessions: Array<{ sessionId: string; animaId: string; startedAt: string; endedAt: string | null }>;
}

export interface ListCommissionsOptions {
  status?: string;
  workshop?: string;
}

/**
 * List commissions with optional filters.
 */
export function listCommissions(home: string, opts: ListCommissionsOptions = {}): CommissionSummary[] {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    let query = `SELECT id, content, status, workshop, status_reason, created_at, updated_at FROM commissions`;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.status) {
      conditions.push(`status = ?`);
      params.push(opts.status);
    }
    if (opts.workshop) {
      conditions.push(`workshop = ?`);
      params.push(opts.workshop);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY created_at DESC`;

    const rows = db.prepare(query).all(...params) as {
      id: string; content: string; status: string; workshop: string;
      status_reason: string | null; created_at: string; updated_at: string;
    }[];

    return rows.map(row => ({
      id: row.id,
      content: row.content,
      status: row.status,
      workshop: row.workshop,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } finally {
    db.close();
  }
}

/**
 * Show detailed commission information, including assignments and linked sessions.
 */
export function showCommission(
  home: string,
  commissionId: string,
): CommissionDetail | null {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const row = db.prepare(
      `SELECT id, content, status, workshop, status_reason, created_at, updated_at
       FROM commissions WHERE id = ?`,
    ).get(commissionId) as {
      id: string; content: string; status: string; workshop: string;
      status_reason: string | null; created_at: string; updated_at: string;
    } | undefined;

    if (!row) return null;

    const assignments = db.prepare(
      `SELECT ca.anima_id, a.name, ca.assigned_at
       FROM commission_assignments ca
       JOIN animas a ON a.id = ca.anima_id
       WHERE ca.commission_id = ?
       ORDER BY ca.assigned_at`,
    ).all(commissionId) as Array<{ anima_id: string; name: string; assigned_at: string }>;

    const sessions = db.prepare(
      `SELECT cs.session_id, s.anima_id, s.started_at, s.ended_at
       FROM commission_sessions cs
       JOIN sessions s ON s.id = cs.session_id
       WHERE cs.commission_id = ?
       ORDER BY s.started_at`,
    ).all(commissionId) as Array<{ session_id: string; anima_id: string; started_at: string; ended_at: string | null }>;

    return {
      id: row.id,
      content: row.content,
      status: row.status,
      workshop: row.workshop,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      assignments: assignments.map(a => ({ animaId: a.anima_id, animaName: a.name, assignedAt: a.assigned_at })),
      sessions: sessions.map(s => ({ sessionId: s.session_id, animaId: s.anima_id, startedAt: s.started_at, endedAt: s.ended_at })),
    };
  } finally {
    db.close();
  }
}

/**
 * Check commission completion via its mandate writ's children.
 *
 * @deprecated Commission completion is now handled automatically by the writ
 * system's completion rollup. When a mandate writ completes, the framework
 * marks the corresponding commission as completed. This function is retained
 * for backward compatibility with existing tools.
 */
export function checkCommissionCompletion(home: string, commissionId: string): CompletionCheck {
  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    // Find the mandate writ for this commission
    const commission = db.prepare(
      `SELECT writ_id FROM commissions WHERE id = ?`,
    ).get(commissionId) as { writ_id: string | null } | undefined;

    if (!commission?.writ_id) {
      return { complete: false, total: 0, done: 0, pending: 0, failed: 0 };
    }

    const rows = db.prepare(
      `SELECT status, COUNT(*) as cnt FROM writs WHERE parent_id = ? GROUP BY status`,
    ).all(commission.writ_id) as Array<{ status: string; cnt: number }>;

    let total = 0, done = 0, pending = 0, failed = 0;
    for (const r of rows) {
      total += r.cnt;
      if (r.status === 'completed' || r.status === 'cancelled') done += r.cnt;
      else if (r.status === 'failed') failed += r.cnt;
      else pending += r.cnt;
    }

    return { complete: total > 0 && pending === 0 && failed === 0, total, done, pending, failed };
  } finally {
    db.close();
  }
}

/**
 * @deprecated Commission completion is now handled by writ completion rollup.
 * When a mandate writ completes, the framework marks the commission as completed.
 */
export function completeCommissionIfReady(home: string, commissionId: string): CompletionResult {
  const check = checkCommissionCompletion(home, commissionId);
  if (!check.complete || check.total === 0) {
    const current = readCommission(home, commissionId);
    return { changed: false, newStatus: current?.status ?? 'unknown' };
  }

  const current = readCommission(home, commissionId);
  if (!current || current.status === 'completed') {
    return { changed: false, newStatus: current?.status ?? 'unknown' };
  }

  updateCommissionStatus(home, commissionId, 'completed', 'all writs completed');
  signalEvent(home, 'commission.completed', { commissionId }, 'framework');
  return { changed: true, newStatus: 'completed' };
}

/**
 * Post a commission to the guild.
 *
 * Creates a commission in the Ledger with status "posted" and signals
 * commission.posted for the Clockworks to pick up. Everything downstream
 * is driven by standing orders.
 */
export function commission(opts: CommissionOptions): CommissionResult {
  const { home, spec, workshop } = opts;

  // Validate workshop exists in guild.json
  const config = readGuildConfig(home);
  if (!(workshop in config.workshops)) {
    const available = Object.keys(config.workshops).join(', ') || '(none)';
    throw new Error(
      `Workshop "${workshop}" not found in guild.json. Available workshops: ${available}`,
    );
  }

  const db = new Database(booksPath(home));
  db.pragma('foreign_keys = ON');

  try {
    const statusReason = 'posted by patron';
    const commissionId = generateId('c');

    // Create commission
    db.prepare(
      `INSERT INTO commissions (id, content, status, status_reason, workshop) VALUES (?, ?, ?, ?, ?)`,
    ).run(commissionId, spec, 'posted', statusReason, workshop);

    // Audit log
    db.prepare(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      generateId('aud'),
      'patron',
      'commission_posted',
      'commission',
      commissionId,
      JSON.stringify({ workshop }),
    );

    // Signal for Clockworks — commission system event (pre-writ)
    signalEvent(home, 'commission.posted', { commissionId, workshop }, 'framework');

    // Create the mandate writ — bridges commission system to writ system.
    // Events are FIFO: commission.posted handlers (e.g. workshop-prepare) run
    // before mandate.ready handlers (e.g. summon artificer).
    const title = spec.split('\n')[0]!.substring(0, 200);
    const mandate = createWrit(home, {
      type: 'mandate',
      title,
      description: spec,
    });

    // Link commission to its mandate writ
    db.prepare(
      `UPDATE commissions SET writ_id = ? WHERE id = ?`,
    ).run(mandate.id, commissionId);

    return { commissionId };
  } finally {
    db.close();
  }
}
