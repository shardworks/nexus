import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritWithPresentation } from '../types.ts';
import { derivePresentation } from '../writ-presentation.ts';

export default tool({
  name: 'writ-list',
  description: 'List writs with optional filters',
  instructions:
    'Returns writ summaries ordered by createdAt descending (newest first). ' +
    'Filter by phase or type to narrow results.',
  params: {
    phase: z
      .union([
        z.enum(['new', 'open', 'stuck', 'completed', 'failed', 'cancelled']),
        z
          .array(z.enum(['new', 'open', 'stuck', 'completed', 'failed', 'cancelled']))
          .min(1),
      ])
      .optional()
      .describe('Filter by writ phase (repeatable — pass multiple to match any)'),
    type: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('Filter by writ type (repeatable — pass multiple to match any)'),
    parentId: z.string().optional().describe('Filter to children of this parent writ'),
    limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
    offset: z.number().optional().describe('Number of results to skip'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const writs = await clerk.list({
      phase: params.phase,
      type: params.type,
      parentId: params.parentId,
      limit: params.limit,
      offset: params.offset,
    });
    // Embed the presentation projection on every row so renderers (the
    // CLI text mode, the Oculus page) can pick badge classes / glyphs /
    // action affordances without consulting the type-config registry per
    // row. T2 contract: every shape that carries a writ phase also
    // carries `classification` and `allowedTransitions`.
    const rows: WritWithPresentation[] = writs.map((w) => {
      const projection = derivePresentation(w, (name) => clerk.getWritTypeConfig(name));
      return {
        ...w,
        classification: projection.classification,
        allowedTransitions: projection.allowedTransitions,
      };
    });
    return rows;
  },
});
