/**
 * Shared handler for session-record logic.
 *
 * Used by both the session-record tool and the DLQ drain on startup.
 * Extracted so the same logic applies regardless of entry point.
 */

import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type {
  SessionDoc,
  SessionTerminationTag,
  TerminationDiagnostic,
  TranscriptDoc,
  TranscriptMessage,
} from './types.ts';

// ── Back-off machine hook ───────────────────────────────────────────

/**
 * Callback interface the Animator apparatus registers during startup.
 *
 * session-record-handler is imported both by the animator plugin itself
 * and by the DLQ drain path; both enter through `handleSessionRecord`.
 * Rather than reaching back into `guild().apparatus('animator')` — which
 * would create a circular invocation during startup — we accept a
 * registered hook and invoke it from the handler after a terminal write.
 *
 * `null` means the apparatus has not started yet (e.g. unit tests that
 * exercise handleSessionRecord in isolation); the handler silently
 * skips the observation in that case.
 */
export interface BackoffObserver {
  observeTerminal(params: {
    sessionId: string;
    status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'rate-limited';
    terminationTag?: SessionTerminationTag;
  }): Promise<void>;
}

let backoffObserver: BackoffObserver | null = null;

/**
 * Register (or clear) the back-off observer invoked after every
 * terminal session recording. The Animator apparatus calls this during
 * start(); tests that need isolation can pass null to reset.
 */
export function setBackoffMachine(observer: BackoffObserver | null): void {
  backoffObserver = observer;
}

// ── Lifecycle emitter hook ──────────────────────────────────────────

/**
 * Callback shape the Animator apparatus registers during startup so the
 * session-record-handler can fire `session.end` (and the failed-write
 * companions) without re-resolving `guild()` per call.
 *
 * The handler runs from two entry points (the `session-record` tool and
 * the DLQ drain) — both inside the apparatus context AND from
 * pre-startup boot in the case of the DLQ drain. Threading the emitter
 * through a `setEmitter` hook mirrors `setBackoffMachine` so the same
 * pattern handles both observers.
 *
 * `null` means the apparatus has not started yet (or this is a unit
 * test); the handler silently skips emission in that case.
 */
export interface SessionLifecycleEmitter {
  emitSessionEnded(doc: SessionDoc): Promise<void>;
  emitSessionRecordFailed(
    sessionId: string,
    phase: 'session-doc' | 'transcript',
    error: unknown,
  ): Promise<void>;
}

let emitter: SessionLifecycleEmitter | null = null;

/**
 * Register (or clear) the session-lifecycle emitter invoked after every
 * terminal session recording. The Animator apparatus calls this during
 * start(); tests that need isolation can pass null to reset.
 */
export function setEmitter(next: SessionLifecycleEmitter | null): void {
  emitter = next;
}

export interface SessionRecordParams {
  sessionId: string;
  status: 'completed' | 'failed' | 'timeout' | 'rate-limited';
  exitCode: number;
  error?: string;
  costUsd?: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  output?: string;
  providerSessionId?: string;
  conversationId?: string;
  transcript?: TranscriptMessage[];
  /**
   * Structured termination tag set by the provider when the terminal
   * status reflects a specific detected condition (today: rate-limit).
   * Persisted on the SessionDoc and forwarded to the Animator's back-off
   * state machine as the load-bearing signal — consumers do not need to
   * pattern-match on `error` text.
   */
  terminationTag?: SessionTerminationTag;
  /**
   * Passive diagnostic set by the provider when the terminal status is
   * exactly `'failed'` — non-zero exit, no structured termination tag,
   * no cancel override. Informational only; the back-off machine does
   * not consume this field. See TerminationDiagnostic.
   */
  terminationDiagnostic?: TerminationDiagnostic;
}

/** Terminal statuses recognized by the session-record handler. */
const TERMINAL_STATUSES: ReadonlySet<SessionDoc['status']> = new Set([
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'rate-limited',
]);

export async function handleSessionRecord(
  params: SessionRecordParams,
): Promise<{ ok: boolean; sessionId: string; status: string }> {
  const stacks = guild().apparatus<StacksApi>('stacks');
  const sessions = stacks.book<SessionDoc>('animator', 'sessions');
  const transcripts = stacks.book<TranscriptDoc>('animator', 'transcripts');

  // Step 1: Check if session is already in a terminal state — don't overwrite.
  const currentDoc = await sessions.get(params.sessionId);
  if (currentDoc && TERMINAL_STATUSES.has(currentDoc.status)) {
    // Session already terminal — don't overwrite. Write transcript if provided.
    console.log(
      `[animator] Dropping duplicate session-record for ${params.sessionId} (already ${currentDoc.status})`,
    );
    if (params.transcript && params.transcript.length > 0) {
      try {
        await transcripts.put({ id: params.sessionId, messages: params.transcript });
      } catch (err) {
        console.warn(
          `[animator] Failed to record transcript for terminal session ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { ok: true, sessionId: params.sessionId, status: currentDoc.status };
  }

  // Step 2: Build and write the SessionDoc.
  const endedAt = new Date().toISOString();
  const startedAt = currentDoc?.startedAt ?? endedAt;
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  const doc: SessionDoc = {
    id: params.sessionId,
    status: params.status,
    startedAt,
    endedAt,
    durationMs,
    provider: currentDoc?.provider ?? 'unknown',
    exitCode: params.exitCode,
    // Refresh lastActivityAt — the terminal report is a lifecycle signal.
    lastActivityAt: new Date().toISOString(),
    ...(params.error ? { error: params.error } : {}),
    ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
    ...(params.tokenUsage ? { tokenUsage: params.tokenUsage } : {}),
    ...(params.output ? { output: params.output } : {}),
    ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    // Preserve metadata and cancelHandle from the running doc.
    ...(currentDoc?.metadata ? { metadata: currentDoc.metadata } : {}),
    ...(currentDoc?.cancelHandle ? { cancelHandle: currentDoc.cancelHandle } : {}),
    // Propagate any structured termination tag — load-bearing signal
    // for the Animator's back-off state machine and Spider's tryCollect
    // branch on rate-limited sessions.
    ...(params.terminationTag ? { terminationTag: params.terminationTag } : {}),
    // Passive diagnostic for `'failed'` terminations that had no
    // structured tag. Written through as-is; never read by the back-off
    // machine.
    ...(params.terminationDiagnostic ? { terminationDiagnostic: params.terminationDiagnostic } : {}),
  };

  let sessionDocWritten = false;
  try {
    await sessions.put(doc);
    sessionDocWritten = true;
  } catch (err) {
    console.warn(
      `[animator] Failed to write terminal session record ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
    );
    if (emitter) {
      try {
        await emitter.emitSessionRecordFailed(params.sessionId, 'session-doc', err);
      } catch { /* best-effort */ }
    }
  }

  // Step 3: Write transcript if provided.
  if (params.transcript && params.transcript.length > 0) {
    try {
      await transcripts.put({ id: params.sessionId, messages: params.transcript });
    } catch (err) {
      console.warn(
        `[animator] Failed to record transcript for ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
      );
      if (emitter) {
        try {
          await emitter.emitSessionRecordFailed(params.sessionId, 'transcript', err);
        } catch { /* best-effort */ }
      }
    }
  }

  // Step 3.5: Emit `session.end` (and possibly
  // `commission.session.ended`) for the detached terminal path. Skipped
  // when the SessionDoc write itself failed — the operator already
  // received `session.record-failed`.
  if (sessionDocWritten && emitter) {
    try {
      await emitter.emitSessionEnded(doc);
    } catch { /* best-effort */ }
  }

  // Step 4: Notify the back-off machine. Never throws — a status-book
  // write failure must not mask the terminal session record.
  if (backoffObserver) {
    try {
      await backoffObserver.observeTerminal({
        sessionId: params.sessionId,
        status: params.status,
        terminationTag: params.terminationTag,
      });
    } catch (err) {
      console.warn(
        `[animator] Back-off observer failed for ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { ok: true, sessionId: params.sessionId, status: params.status };
}
