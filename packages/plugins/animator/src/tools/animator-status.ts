/**
 * animator-status tool — show the Animator's current rate-limit state.
 *
 * Returns the `'dispatch-status'` document from the Animator's shared
 * `state` book plus a server-computed `dispatchable` boolean derived from
 * the canonical `isDispatchable(doc)` helper at request time. The CLI
 * auto-printer pretty-prints the object at the terminal; HTTP / MCP
 * consumers receive the same enriched shape.
 *
 * The persisted `AnimatorStatusDoc` shape is unchanged — `dispatchable`
 * is a presentation-layer field on the *response*, computed from `now()`
 * each time the tool is invoked. It is NOT written to the status row.
 *
 * Permission is `read`; no mutation paths here.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import type { AnimatorApi } from '../types.ts';
import { isDispatchable } from '../rate-limit-backoff.ts';

export default tool({
  name: 'animator-status',
  description: "Show the Animator's current rate-limit pause state",
  instructions:
    "Returns the rate-limit back-off state document plus a server-computed " +
    "`dispatchable` boolean (derived from the canonical isDispatchable(doc) " +
    "helper). The CLI auto-printer renders it as pretty-printed JSON at the " +
    "terminal.",
  callableBy: ['patron'],
  params: {},
  permission: 'read',
  handler: async () => {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const status = await animator.getStatus();
    return { ...status, dispatchable: isDispatchable(status) };
  },
});
