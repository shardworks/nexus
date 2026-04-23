import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-amend',
  description: 'Amend the goal of a live click, preserving the prior value in goalHistory',
  instructions:
    'Replaces the goal text of a click while it is live. The prior goal is appended ' +
    'to the click\'s goalHistory as a new entry. Amend is refused on parked, concluded, ' +
    'or dropped clicks — the goal seals on transition to any non-live status. ' +
    'A non-empty goal string is required; submitting the current goal text verbatim ' +
    'is a no-op and produces no history entry.',
  params: {
    id: z.string().describe('Click ID or prefix'),
    goal: z.string().describe('The new goal text (non-empty)'),
    sessionId: z.string().optional().describe('Session ID that performed this amend'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.amend(resolvedId, {
      goal: params.goal,
      sessionId: params.sessionId,
    });
  },
});
