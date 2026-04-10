/**
 * Shared handler for session-record logic.
 *
 * Used by both the session-record tool and the DLQ drain on startup.
 * Extracted so the same logic applies regardless of entry point.
 */

import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc, TranscriptDoc, TranscriptMessage } from './types.ts';

export interface SessionRecordParams {
  sessionId: string;
  status: 'completed' | 'failed' | 'timeout';
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
}

export async function handleSessionRecord(
  params: SessionRecordParams,
): Promise<{ ok: boolean; sessionId: string; status: string }> {
  const stacks = guild().apparatus<StacksApi>('stacks');
  const sessions = stacks.book<SessionDoc>('animator', 'sessions');
  const transcripts = stacks.book<TranscriptDoc>('animator', 'transcripts');

  // Step 1: Check if session was cancelled — don't overwrite.
  const currentDoc = await sessions.get(params.sessionId);
  if (currentDoc?.status === 'cancelled') {
    // Write transcript if provided, even for cancelled sessions.
    if (params.transcript && params.transcript.length > 0) {
      try {
        await transcripts.put({ id: params.sessionId, messages: params.transcript });
      } catch (err) {
        console.warn(
          `[animator] Failed to record transcript for cancelled session ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { ok: true, sessionId: params.sessionId, status: 'cancelled' };
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
    ...(params.error ? { error: params.error } : {}),
    ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
    ...(params.tokenUsage ? { tokenUsage: params.tokenUsage } : {}),
    ...(params.output ? { output: params.output } : {}),
    ...(params.providerSessionId ? { providerSessionId: params.providerSessionId } : {}),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    // Preserve metadata and cancelMetadata from the running doc.
    ...(currentDoc?.metadata ? { metadata: currentDoc.metadata } : {}),
    ...(currentDoc?.cancelMetadata ? { cancelMetadata: currentDoc.cancelMetadata } : {}),
  };

  await sessions.put(doc);

  // Step 3: Write transcript if provided.
  if (params.transcript && params.transcript.length > 0) {
    try {
      await transcripts.put({ id: params.sessionId, messages: params.transcript });
    } catch (err) {
      console.warn(
        `[animator] Failed to record transcript for ${params.sessionId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { ok: true, sessionId: params.sessionId, status: params.status };
}
