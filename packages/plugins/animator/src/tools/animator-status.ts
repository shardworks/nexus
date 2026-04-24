/**
 * animator-status tool — show the Animator's current rate-limit state.
 *
 * Returns the `'dispatch-status'` document from the Animator's shared
 * `state` book verbatim as JSON. The CLI auto-printer pretty-prints the
 * object at the terminal; HTTP / MCP consumers receive the same shape
 * the Animator's in-process API returns.
 *
 * Permission is `read`; no mutation paths here.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import type { AnimatorApi } from '../types.ts';

export default tool({
  name: 'animator-status',
  description: "Show the Animator's current rate-limit pause state",
  instructions:
    "Returns the rate-limit back-off state document verbatim as JSON. " +
    "The CLI auto-printer renders it as pretty-printed JSON at the terminal.",
  callableBy: ['patron'],
  params: {},
  permission: 'read',
  handler: async () => {
    const animator = guild().apparatus<AnimatorApi>('animator');
    return animator.getStatus();
  },
});
