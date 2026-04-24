/**
 * animator-status tool — show the Animator's current rate-limit state.
 *
 * Reads the `current` document from the Animator's status book (the
 * single-row table owned by the back-off state machine). Returns a
 * human-readable multi-line summary by default, or the raw status doc
 * as JSON when `--json` is passed.
 *
 * Modeled on `session-show` and on the framework `status` tool (the
 * text-default-with-`--json` convention). Permission is `read`; no
 * mutation paths here.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { AnimatorApi, AnimatorStatusDoc } from '../types.ts';

function formatStatus(doc: AnimatorStatusDoc): string {
  const lines: string[] = [];
  lines.push(`State:            ${doc.state}`);
  lines.push(`Back-off level:   ${doc.backoffLevel}`);
  if (doc.pauseReason) {
    lines.push(`Pause reason:     ${doc.pauseReason}`);
  }
  if (doc.pausedSince) {
    lines.push(`Paused since:     ${doc.pausedSince}`);
  }
  if (doc.pausedUntil) {
    const ms = new Date(doc.pausedUntil).getTime() - Date.now();
    const rel = ms > 0
      ? `${Math.ceil(ms / 1000)}s from now`
      : `${Math.abs(Math.floor(ms / 1000))}s ago`;
    lines.push(`Paused until:     ${doc.pausedUntil} (${rel})`);
  }
  if (doc.backoffLastHitAt) {
    lines.push(`Last rate-limit:  ${doc.backoffLastHitAt}`);
  }
  if (doc.lastTriggeringSession) {
    lines.push(`Triggering sess.: ${doc.lastTriggeringSession}`);
  }
  return lines.join('\n');
}

export default tool({
  name: 'animator-status',
  description: "Show the Animator's current rate-limit pause state",
  instructions:
    'Returns the rate-limit back-off state document verbatim. ' +
    'Default output is human-readable; pass --json for machine-parseable output.',
  callableBy: ['patron'],
  params: {
    json: z.boolean().optional().describe('Emit the status document as JSON'),
  },
  permission: 'read',
  handler: async (params) => {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const doc = await animator.getStatus();
    if (params.json) {
      return doc;
    }
    return formatStatus(doc);
  },
});
