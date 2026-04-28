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
import type { SessionDoc } from './types.ts';
import { handleSessionRecord, type SessionRecordParams } from './session-record-handler.ts';
import { emitSessionEnded, emitSessionRecordFailed } from './session-emission.ts';
import { reduceSessionTransition } from './session-reducer.ts';

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
    // Legacy record without lastActivityAt — backfill via the reducer's
    // heartbeat-touch variant. Legacy-row backfill rule (D17): pre-
    // reducer rows are missing the lastActivityAt field; touching them
    // through the reducer keeps the merge semantics in one place
    // instead of having a bespoke patch path here. The doc is already
    // in hand from the find() iteration, so the read+reduce+put is one
    // round-trip.
    if (!doc.lastActivityAt) {
      try {
        const touched = reduceSessionTransition(doc, {
          kind: 'heartbeat-touch',
          id: doc.id,
          lastActivityAt: new Date().toISOString(),
        });
        await sessions.put(touched);
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

    // Session is stale — mark as failed via the reducer's orphan-failed
    // variant (lastActivityAt is intentionally NOT refreshed: the host
    // is presumed dead, so the existing field tells the truth).
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(doc.startedAt).getTime();
    const updated = reduceSessionTransition(doc, {
      kind: 'orphan-failed',
      id: doc.id,
      endedAt,
      durationMs,
      exitCode: 1,
      error: `No heartbeat received for ${Math.round(effectiveSilence / 1000)}s — session host presumed dead (reconciled)`,
    });

    try {
      await sessions.put(updated);
      recovered++;
      // Orphan recovery is a terminal session site — fire
      // `animator.session.ended`.
      await emitSessionEnded(updated);
    } catch (err) {
      console.warn(
        `[animator] Failed to recover stale session ${doc.id}: ${err instanceof Error ? err.message : err}`,
      );
      // The session-doc rewrite failed — fire
      // `animator.session.record-failed` so standing orders bound to
      // it can react. CDC won't observe this case (no row was
      // authoritatively written). Phase `'update-row'` per the
      // catalog: orphan recovery overwrites an existing running row to
      // its terminal failed state.
      await emitSessionRecordFailed(doc.id, 'update-row', err);
    }
  }

  if (recovered > 0) {
    console.log(`[animator] Reconciler: marked ${recovered} dead sessions as failed`);
  }

  return recovered;
}
