import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Patch a piece's mutable fields. Per D6 the only mutable field today
 * is `codex` — title/body live on the writ row and are edited via
 * `nsg writ edit`. Per D5 the `--stage` flag is intentionally absent;
 * stage transitions go through `piece-transition`. Codex updates route
 * through `clerk.edit` (D2 — single source of truth for codex on
 * `writ.codex`).
 */
export default tool({
  name: 'piece-patch',
  description: "Patch a piece's mutable fields",
  instructions:
    "Updates a piece's mutable fields. The only patchable field today is `codex`. " +
    'Title/body live on the writ row — edit them via `nsg writ edit`. Stage updates go ' +
    "through `piece-transition` so the writ phase and `ext['cartograph'].stage` move " +
    'in one atomic step.',
  params: {
    id: z.string().describe('Piece id (or short prefix)'),
    codex: z.string().optional().describe('New target codex (empty string to clear)'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    if (params.codex === undefined) {
      throw new Error('piece-patch requires at least one mutable field (currently `--codex`).');
    }
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return cartograph.patchPiece(resolvedId, {
      codex: params.codex,
    });
  },
});
