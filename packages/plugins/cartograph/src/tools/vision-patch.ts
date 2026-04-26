import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';

/**
 * Patch a vision's companion doc. Per D6 the only mutable companion-doc
 * field today is `codex` — title/body live on the writ row and are edited
 * via `nsg writ edit`. Per D5 the `--stage` flag is intentionally absent;
 * stage transitions go through `vision-transition` so the writ phase and
 * the doc stage stay coupled in one transaction.
 */
export default tool({
  name: 'vision-patch',
  description: "Patch a vision's companion doc",
  instructions:
    "Updates a vision's companion doc. The only patchable field today is `codex`. " +
    'Title/body live on the writ row — edit them via `nsg writ edit`. Stage updates go ' +
    'through `vision-transition` so the writ phase and the companion stage move in one ' +
    'atomic step.',
  params: {
    id: z.string().describe('Vision id (or short prefix)'),
    codex: z.string().optional().describe('New target codex (empty string to clear)'),
  },
  permission: 'write',
  callableBy: ['patron'],
  handler: async (params) => {
    if (params.codex === undefined) {
      throw new Error('vision-patch requires at least one mutable field (currently `--codex`).');
    }
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return cartograph.patchVision(resolvedId, {
      codex: params.codex,
      updatedAt: new Date().toISOString(),
    });
  },
});
