/**
 * Animator startup routines — DLQ drain and orphan recovery.
 *
 * These run during the Animator apparatus start() phase, after books are
 * initialized. They handle cases where detached session babysitters
 * couldn't deliver results (guild was down) or where sessions were
 * orphaned (both guild and babysitter died).
 *
 * See: docs/architecture/detached-sessions.md
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Book } from '@shardworks/stacks-apparatus';
import type { AnimatorStatusDoc, SessionDoc, TranscriptDoc } from './types.ts';
import { handleSessionRecord, type SessionRecordParams } from './session-record-handler.ts';
import { DISPATCH_STATUS_DOC_ID } from './rate-limit-backoff.ts';

// ── DLQ drain ───────────────────────────────────────────────────────

/**
 * Scan .nexus/dlq/ for pending session-record payloads and process them.
 *
 * Each file is a JSON object matching the session-record tool's params schema.
 * Filename format: {sessionId}.json.
 *
 * Files are deleted after successful processing. Failures are logged as
 * warnings — the file remains on disk for manual inspection.
 */
export async function drainDlq(guildHome: string): Promise<number> {
  const dlqDir = path.join(guildHome, '.nexus', 'dlq');

  // Ensure the directory exists.
  try {
    fs.mkdirSync(dlqDir, { recursive: true });
  } catch {
    // Best-effort — if we can't create it, there's nothing to drain.
  }

  let files: string[];
  try {
    files = fs.readdirSync(dlqDir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }

  if (files.length === 0) return 0;

  let processed = 0;
  for (const file of files) {
    const filePath = path.join(dlqDir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const payload = JSON.parse(raw) as SessionRecordParams;

      await handleSessionRecord(payload);

      // Delete the file after successful processing.
      fs.unlinkSync(filePath);
      processed++;
    } catch (err) {
      console.warn(
        `[animator] Failed to process DLQ file ${file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (processed > 0) {
    console.log(`[animator] DLQ drain: processed ${processed} of ${files.length} pending session results`);
  }

  return processed;
}

// ── Legacy `animator/status` book cleanup ───────────────────────────

/**
 * Drop the orphan `books_animator_status` table left behind on installs
 * that ran the Animator before commit 6cb832a relocated the dispatch
 * status doc into the shared `animator/state` book.
 *
 * The original commit deliberately left the orphan in place ("no
 * migration shim"), but the stale row carries a misleading doc id
 * (`'current'`) and a `lastTriggeringSession` value that no longer
 * reflects reality, which has burned at least one debugging session
 * (the operator reads the orphan and assumes the back-off machine has
 * been recording state, when in fact the new doc id `'dispatch-status'`
 * lives in a different book entirely).
 *
 * Migration step:
 *  1. If the new `dispatch-status` doc does not yet exist in
 *     `animator/state`, port the old `'current'` doc forward by
 *     rewriting its id (preserves audit fields like `backoffLastHitAt`
 *     for installs that observed a real rate-limit terminal under the
 *     old code path). Skip if the new doc is already present.
 *  2. Drop the orphan `books_animator_status` table.
 *
 * Idempotent: a no-op on fresh installs (no orphan table) and on
 * already-cleaned installs (table dropped, new doc present). Failures
 * are logged but never throw — the migration must not block startup.
 *
 * Uses better-sqlite3 directly because Stacks does not expose a
 * drop-table primitive and the orphan book is no longer referenced by
 * any registered owner.
 */
export async function cleanupLegacyStatusBook(
  guildHome: string,
  stateBook: Book<AnimatorStatusDoc>,
): Promise<void> {
  const dbPath = path.join(guildHome, '.nexus', 'nexus.db');
  if (!fs.existsSync(dbPath)) return;

  let Database: typeof import('better-sqlite3');
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    // Native module unavailable in this test/runtime — skip silently.
    return;
  }

  let raw: import('better-sqlite3').Database | null = null;
  try {
    raw = new Database(dbPath);
    const exists = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='books_animator_status'",
      )
      .get() as { name?: string } | undefined;
    if (!exists?.name) return;

    // Best-effort port-forward: if the new doc is missing and the old
    // 'current' doc carries audit fields worth preserving, write it to
    // the new location with the new id. Done outside the better-sqlite3
    // handle so the write goes through the Stacks book and any CDC
    // watchers see a normal row materialization.
    let portForward: AnimatorStatusDoc | null = null;
    const existingNew = await stateBook.get(DISPATCH_STATUS_DOC_ID);
    if (!existingNew) {
      const row = raw
        .prepare("SELECT content FROM books_animator_status WHERE id = 'current'")
        .get() as { content?: string } | undefined;
      if (row?.content) {
        try {
          const parsed = JSON.parse(row.content) as AnimatorStatusDoc;
          portForward = { ...parsed, id: DISPATCH_STATUS_DOC_ID };
        } catch {
          // Malformed orphan row — drop the table without porting forward.
        }
      }
    }

    raw.exec('DROP TABLE IF EXISTS books_animator_status');
    raw.close();
    raw = null;

    if (portForward) {
      try {
        await stateBook.put(portForward);
      } catch (err) {
        console.warn(
          `[animator] Failed to port-forward legacy dispatch-status doc: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log('[animator] Dropped orphan books_animator_status table (post-rename cleanup).');
  } catch (err) {
    console.warn(
      `[animator] Legacy status-book cleanup failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    if (raw) {
      try { raw.close(); } catch { /* already closed */ }
    }
  }
}

// ── Heartbeat-based reconciliation ──────────────────────────────────

/** Staleness threshold: sessions silent for longer than this are presumed dead. */
const STALENESS_THRESHOLD_MS = 90_000;

/**
 * Reconcile non-terminal sessions using heartbeat-based staleness detection.
 *
 * Scans sessions in `pending` and `running` states. When a session's
 * `lastActivityAt` is older than the staleness threshold (90s), accounting
 * for any downtime credit from guild restart, the session is transitioned
 * to `failed`.
 *
 * Sessions without `lastActivityAt` (legacy records) are backfilled with
 * the current time and skipped for the current pass, giving them one
 * staleness window to heartbeat.
 *
 * Runs after DLQ drain so DLQ'd results are processed first (a DLQ'd
 * result might resolve what would otherwise look like a stale session).
 */
export async function recoverOrphans(
  sessions: Book<SessionDoc>,
  downtimeCreditMs: number = 0,
): Promise<number> {
  const activeSessions = await sessions.find({
    where: [['status', 'IN', ['pending', 'running']]],
  });

  const now = Date.now();
  let recovered = 0;

  for (const doc of activeSessions) {
    // Legacy record without lastActivityAt — backfill and skip this pass.
    if (!doc.lastActivityAt) {
      try {
        await sessions.patch(doc.id, { lastActivityAt: new Date().toISOString() });
        console.log(`[animator] Backfilled lastActivityAt for legacy session ${doc.id}`);
      } catch (err) {
        console.warn(
          `[animator] Failed to backfill lastActivityAt for ${doc.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
      continue;
    }

    const silence = now - new Date(doc.lastActivityAt).getTime();
    const effectiveSilence = silence - downtimeCreditMs;

    if (effectiveSilence <= STALENESS_THRESHOLD_MS) {
      continue;
    }

    // Session is stale — mark as failed.
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(doc.startedAt).getTime();

    const updated: SessionDoc = {
      ...doc,
      status: 'failed',
      endedAt,
      durationMs,
      exitCode: 1,
      error: `No heartbeat received for ${Math.round(effectiveSilence / 1000)}s — session host presumed dead (reconciled)`,
    };

    try {
      await sessions.put(updated);
      recovered++;
    } catch (err) {
      console.warn(
        `[animator] Failed to recover stale session ${doc.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (recovered > 0) {
    console.log(`[animator] Reconciler: marked ${recovered} dead sessions as failed`);
  }

  return recovered;
}
