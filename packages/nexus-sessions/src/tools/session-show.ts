/**
 * session-show tool — show full details of a specific session.
 *
 * Replaces the stdlib session-show tool that called showSession() from
 * @shardworks/nexus-core. The rig now owns this operation.
 */

import { tool, guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import { showSession } from '../lib/session-api.js';

export default tool({
  name: 'session-show',
  description: 'Show full details of a specific session',
  instructions:
    'Returns the complete session record including token usage, cost, duration, ' +
    'curriculum/temperament snapshot, and roles at session time.',
  params: {
    id: z.string().describe('Session ID'),
  },
  handler: (params) => {
    const { home } = guild();
    const result = showSession(home, params.id);
    if (!result) throw new Error(`Session "${params.id}" not found.`);
    return result;
  },
});
