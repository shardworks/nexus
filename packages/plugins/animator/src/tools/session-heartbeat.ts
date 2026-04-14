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

/** Terminal status values — any of these means the session is done. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

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

    // Only refresh for non-terminal sessions.
    if (TERMINAL_STATUSES.has(doc.status)) {
      return { ok: true, sessionId: params.sessionId, status: doc.status };
    }

    await sessions.patch(params.sessionId, {
      lastActivityAt: new Date().toISOString(),
    });

    return { ok: true, sessionId: params.sessionId };
  },
});
