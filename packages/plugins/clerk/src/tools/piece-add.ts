import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

/**
 * Build a task XML body from structured fields, matching the task-manifest format.
 */
function buildTaskXml(params: {
  name: string;
  action: string;
  files?: string;
  verify?: string;
  done?: string;
}): string {
  // Generate a simple id based on timestamp to ensure uniqueness
  const id = `t-${Date.now().toString(36)}`;
  const lines: string[] = [];
  lines.push(`<task id="${id}">`);
  lines.push(`    <name>${params.name}</name>`);
  if (params.files) {
    lines.push(`    <files>${params.files}</files>`);
  }
  lines.push(`    <action>${params.action}</action>`);
  if (params.verify) {
    lines.push(`    <verify>${params.verify}</verify>`);
  }
  if (params.done) {
    lines.push(`    <done>${params.done}</done>`);
  }
  lines.push(`</task>`);
  return lines.join('\n');
}

export default tool({
  name: 'piece-add',
  description: 'Add a new piece (atomic task) to a mandate for sequential execution',
  instructions:
    'Creates a new piece writ as a child of the specified mandate. The piece is created ' +
    'in open phase and will be picked up by the implement-loop engine after the current ' +
    'piece session completes. The body is structured as a <task> XML element matching the ' +
    'task-manifest format used by the spec writer. ' +
    'Requires an explicit mandateId — the mandate must be in new, open, or stuck phase.',
  callableBy: ['anima', 'patron'],
  params: {
    mandateId: z.string().describe('ID of the parent mandate writ'),
    name: z.string().describe('Short name for the task'),
    action: z.string().describe('Description of what to do'),
    files: z.string().optional().describe('Predicted affected files (orientation hint)'),
    verify: z.string().optional().describe('Command to verify completion'),
    done: z.string().optional().describe('Criterion for task completion'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedMandateId = await clerk.resolveId(params.mandateId);
    const body = buildTaskXml(params);

    const piece = await clerk.post({
      type: 'piece',
      title: params.name,
      body,
      parentId: resolvedMandateId,
    });
    // Auto-publish to match the tool's documented behaviour: the piece
    // enters the queue immediately. `post()` always lands the writ in its
    // type's declared initial state; the tool layer carries the UX
    // auto-advance in the same spirit as `commission-post` for mandates.
    return clerk.transition(piece.id, 'open');
  },
});
