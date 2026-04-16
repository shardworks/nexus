import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-create',
  description: 'Create a new click for tracking a task or goal',
  instructions:
    'Creates a new click in live status. Optionally nest under a parent click ' +
    'by providing parentId. The parent must exist.',
  params: {
    goal: z.string().describe('Short description of the task or goal'),
    parentId: z.string().optional().describe('Parent click ID to nest under'),
    createdSessionId: z.string().optional().describe('Session ID that created this click'),
  },
  permission: 'write',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    return ratchet.create({
      goal: params.goal,
      parentId: params.parentId,
      createdSessionId: params.createdSessionId,
    });
  },
});
