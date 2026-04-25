/**
 * session-heartbeat tool — refresh session liveness timestamp.
 *
 * Called periodically by session babysitters to assert liveness.
 * Updates lastActivityAt to the guild wall-clock time.
 * Not intended for patron or anima use.
 *
 * See: docs/architecture/detached-sessions.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SessionDoc } from '../types.ts';
import { TERMINAL_STATUSES, reduceSessionTransition } from '../session-reducer.ts';

export default tool({
  name: 'session-heartbeat',
  description: 'Refresh session liveness timestamp',
  instructions:
    'Called periodically by session babysitters to assert liveness. ' +
    'Updates lastActivityAt to the guild wall-clock time. ' +
    'Not intended for patron or anima use.',
  params: {
    sessionId: z.string().describe('The session ID'),
  },
  callableBy: 'anima',
  permission: 'write',
  handler: async (params) => {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const sessions = stacks.book<SessionDoc>('animator', 'sessions');

    const doc = await sessions.get(params.sessionId);
    if (!doc) {
      return { ok: false, error: 'Session not found' };
    }

    // Only refresh for non-terminal sessions. The reducer's
    // terminal-immutability rule would also produce this no-op, but the
    // call site needs the early return to keep the `status` field in
    // the response body for callers that branch on it.
    if (TERMINAL_STATUSES.has(doc.status)) {
      return { ok: true, sessionId: params.sessionId, status: doc.status };
    }

    // Convert from sessions.patch() to read+reduce+put per D5 — uniform
    // funnel through the reducer module. The extra round-trip on a
    // ~30s heartbeat cadence is not a hot path.
    const next = reduceSessionTransition(doc, {
      kind: 'heartbeat-touch',
      id: params.sessionId,
      lastActivityAt: new Date().toISOString(),
    });
    await sessions.put(next);

    return { ok: true, sessionId: params.sessionId };
  },
});
