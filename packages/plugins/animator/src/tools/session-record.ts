/**
 * session-record tool — record a terminal session result for a detached session.
 *
 * Called by the session babysitter when claude exits. Writes the final
 * SessionDoc and optional TranscriptDoc to the sessions/transcripts books,
 * firing CDC for both writes.
 *
 * Respects cancellation: if the session was already cancelled, the status
 * is preserved (not overwritten). Partial transcript is still recorded.
 *
 * See: docs/architecture/detached-sessions.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { z } from 'zod';
import type { SessionDoc, TranscriptDoc, TranscriptMessage } from '../types.ts';
import { handleSessionRecord } from '../session-record-handler.ts';

export default tool({
  name: 'session-record',
  description: 'Record a terminal session result for a detached session',
  instructions:
    'Called by session babysitters to record the final result of a detached session. ' +
    'Writes the SessionDoc and optional TranscriptDoc to Stacks. ' +
    'Respects cancellation — will not overwrite a cancelled status. ' +
    'Not intended for patron or anima use.',
  params: {
    sessionId: z.string().describe('The session ID'),
    status: z
      .enum(['completed', 'failed', 'timeout', 'rate-limited'])
      .describe('Terminal session status'),
    exitCode: z.number().describe('Process exit code'),
    error: z.string().optional().describe('Error message if failed'),
    costUsd: z.number().optional().describe('Cost in USD'),
    tokenUsage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    }).optional().describe('Token usage from the provider'),
    output: z.string().optional().describe('Final assistant text'),
    providerSessionId: z.string().optional().describe("Claude's session ID for --resume"),
    conversationId: z.string().optional().describe('Conversation ID'),
    transcript: z.array(z.record(z.string(), z.unknown())).optional().describe('Session transcript messages'),
    terminationTag: z
      .object({
        kind: z.literal('rate-limit'),
        source: z.literal('ndjson-result'),
        detail: z.string().optional(),
      })
      .optional()
      .describe(
        'Structured termination tag set by the provider when the terminal status ' +
          'reflects a specific detected condition (today: rate-limit).',
      ),
  },
  callableBy: 'anima',
  permission: 'write',
  handler: async (params) => {
    return handleSessionRecord(params);
  },
});
