import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';

/**
 * Create a top-level vision. Visions have no parent; the typed API
 * rejects any non-empty `parentId`, so the tool does not even expose
 * the flag (D1: parent-shape encoded in the schema). Lands the writ at
 * `phase: new` and the companion doc at `stage: draft` (D14 — no
 * auto-transition; the patron runs `vision-transition` to advance).
 */
export default tool({
  name: 'vision-create',
  description: 'Create a new top-level vision',
  instructions:
    'Creates a vision (top-level patron-owned writ). The writ lands in `phase: new` ' +
    'and the companion doc in `stage: draft`. Use `vision-transition` to advance the ' +
    'lifecycle. Title and body live on the writ row; edit them via `nsg writ edit`.',
  params: {
    title: z.string().describe('Short human-readable title describing the vision'),
    body: z.string().describe('Long-form vision text, stored on the writ body'),
    codex: z.string().optional().describe('Optional target codex'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    return cartograph.createVision({
      title: params.title,
      body: params.body,
      ...(params.codex !== undefined ? { codex: params.codex } : {}),
    });
  },
});
