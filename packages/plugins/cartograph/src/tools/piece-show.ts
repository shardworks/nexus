import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import { composeShow, renderShowJson, renderShowText } from './render.ts';

/**
 * Show a piece by writ id. Composes the cartograph projection with the
 * writ row (D7) and returns either the lifecycle-aware text block (D18)
 * or the structured `{ ...doc, writ: { ... } }` JSON (D8).
 */
export default tool({
  name: 'piece-show',
  description: 'Show full detail for a piece',
  instructions:
    'Returns the piece projection joined with its underlying writ row, including ' +
    'parent reference, descendants summary, direct children, and links. The default ' +
    '`--format text` renders a lifecycle-aware block (state classification + attrs, ' +
    'allowed transitions, descendants summary, links). Pass `--format json` for the ' +
    'structured `{ ...doc, writ: { ... } }` shape.',
  params: {
    id: z.string().describe('Piece id (or short prefix)'),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" renders the lifecycle-aware block (default). "json" returns the structured response.'),
  },
  permission: 'read',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    const doc = await cartograph.showPiece(resolvedId);
    const result = await composeShow(doc, resolvedId, clerk);
    if (params.format === 'json') return renderShowJson(result);
    return renderShowText('Piece', result);
  },
});
