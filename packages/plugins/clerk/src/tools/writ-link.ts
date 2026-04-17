import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-link',
  description: 'Link two writs with a typed relationship',
  instructions:
    'Creates a directional link from source writ to target writ. ' +
    'The type describes the relationship (e.g. "fixes", "retries", "supersedes", "duplicates"). ' +
    'The type is normalized at write time — "depends-on", "dependsOn", and "depends on" all ' +
    'collapse to the same canonical form. Idempotent — creating the same link twice returns ' +
    'the existing link. For load-bearing relationships, pass `--meaning <id>` to attach a ' +
    'registered semantic meaning; the id must appear in the kit-contributed meaning registry ' +
    '(see `writ link-meanings`).',
  params: {
    sourceId: z.string().describe('The writ that is the origin of this relationship'),
    targetId: z.string().describe('The writ that is the target of this relationship'),
    type: z.string().describe('Relationship type (e.g. "fixes", "retries", "supersedes", "duplicates") — casual label, normalized at write time'),
    meaning: z
      .string()
      .optional()
      .describe('Optional load-bearing semantic meaning id (must be registered — see `writ link-meanings`)'),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.link(params.sourceId, params.targetId, params.type, params.meaning);
  },
});
