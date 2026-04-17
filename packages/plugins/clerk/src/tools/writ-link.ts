import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-link',
  description: 'Link two writs with a typed relationship',
  instructions:
    'Creates a directional link from source writ to target writ. ' +
    'The label describes the relationship (e.g. "fixes", "retries", "supersedes", "duplicates"). ' +
    'The label is normalized at write time — "depends-on", "dependsOn", and "depends on" all ' +
    'collapse to the same canonical form. Idempotent — creating the same link twice returns ' +
    'the existing link. For load-bearing relationships, pass `--kind <id>` to attach a ' +
    'registered semantic meaning; the id must appear in the kit-contributed meaning registry ' +
    '(see `writ link-kinds`).',
  params: {
    sourceId: z.string().describe('The writ that is the origin of this relationship'),
    targetId: z.string().describe('The writ that is the target of this relationship'),
    label: z.string().describe('Relationship label (e.g. "fixes", "retries", "supersedes", "duplicates") — casual label, normalized at write time'),
    kind: z
      .string()
      .optional()
      .describe('Optional load-bearing link-kind id (must be registered — see `writ link-kinds`)'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const [resolvedSource, resolvedTarget] = await Promise.all([
      clerk.resolveId(params.sourceId),
      clerk.resolveId(params.targetId),
    ]);
    return clerk.link(resolvedSource, resolvedTarget, params.label, params.kind);
  },
});
