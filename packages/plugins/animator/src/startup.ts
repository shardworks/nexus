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
import type { SessionDoc, TranscriptDoc } from './types.ts';
import { handleSessionRecord, type SessionRecordParams } from './session-record-handler.ts';

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

// ── Orphan recovery ─────────────────────────────────────────────────

/**
 * Find sessions stuck in 'running' and check if their process is still alive.
 *
 * For each running session with a PID in cancelMetadata:
 * - If the process is dead (ESRCH): mark as failed with an orphan error.
 * - If alive or no PID: skip (legitimately running or pre-detached).
 *
 * Runs after DLQ drain so DLQ'd results are processed first (a DLQ'd
 * result might resolve what would otherwise look like an orphan).
 */
export async function recoverOrphans(sessions: Book<SessionDoc>): Promise<number> {
  const runningSessions = await sessions.find({
    where: [['status', '=', 'running']],
  });

  if (runningSessions.length === 0) return 0;

  let recovered = 0;
  for (const doc of runningSessions) {
    const pid = doc.cancelMetadata?.pid;
    if (typeof pid !== 'number') {
      // No PID — pre-detached session or session without cancel metadata. Skip.
      continue;
    }

    if (isProcessAlive(pid)) {
      // Process is still running — legitimate session. Skip.
      continue;
    }

    // Process is dead — mark as failed.
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(doc.startedAt).getTime();

    const updated: SessionDoc = {
      ...doc,
      status: 'failed',
      endedAt,
      durationMs,
      exitCode: 1,
      error: 'Session process died unexpectedly (orphaned)',
    };

    try {
      await sessions.put(updated);
      recovered++;
    } catch (err) {
      console.warn(
        `[animator] Failed to recover orphaned session ${doc.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (recovered > 0) {
    console.log(`[animator] Orphan recovery: marked ${recovered} dead sessions as failed`);
  }

  return recovered;
}

/**
 * Check if a process with the given PID is alive.
 *
 * Uses process.kill(pid, 0) which sends signal 0 (no-op) to check
 * existence. Returns true if alive, false if dead (ESRCH).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // No such process — it's dead.
      return false;
    }
    // EPERM means the process exists but we can't signal it.
    // Treat as alive — it's not our orphan.
    return true;
  }
}
