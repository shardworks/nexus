/**
 * dispatch-next tool — find the oldest ready writ and dispatch it.
 *
 * The primary entry point for running guild work. Picks the oldest ready
 * writ (FIFO order), opens a draft on its codex (if any), summons an anima
 * to fulfill it, and transitions the writ to completed or failed based on
 * the session outcome.
 *
 * Usage:
 *   nsg dispatch-next
 *   nsg dispatch-next --role scribe
 *   nsg dispatch-next --dry-run
 *
 * See: docs/architecture/apparatus/dispatch.md
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { DispatchApi } from '../types.ts';

export default tool({
  name: 'dispatch-next',
  description: 'Find the oldest ready writ and dispatch it',
  instructions:
    'Finds the oldest ready writ (FIFO order), opens a draft binding on its codex ' +
    'if specified, summons an anima to fulfill the commission, and transitions the ' +
    'writ to completed or failed based on the session outcome. Returns null if no ' +
    'ready writs exist. Use dryRun to preview which writ would be dispatched.',
  params: {
    role: z.string().optional()
      .describe('Role to summon (default: "artificer")'),
    dryRun: z.boolean().optional().default(false)
      .describe('If true, find and report the writ but do not dispatch'),
  },
  callableBy: 'cli',
  permission: 'dispatch:write',
  handler: async (params) => {
    const dispatch = guild().apparatus<DispatchApi>('dispatch');
    const result = await dispatch.next({
      role: params.role,
      dryRun: params.dryRun,
    });

    if (!result) {
      return { status: 'idle', message: 'No ready writs found.' };
    }

    return result;
  },
});
