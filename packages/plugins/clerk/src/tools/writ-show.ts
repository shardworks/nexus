import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritPhase } from '../types.ts';

export default tool({
  name: 'writ-show',
  description: 'Show full detail for a writ',
  instructions:
    'Returns the complete writ record including its current phase, timestamps, body text, ' +
    'resolution, parent context, and children. The `children.summary` field is a ' +
    'phase-keyed count of the entire descendant subtree beneath this writ (grandchildren ' +
    'and deeper included; the writ itself is excluded). The `children.items` list stays ' +
    'scoped to direct children only.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    const [writ, links, summary] = await Promise.all([
      clerk.show(resolvedId),
      clerk.links(resolvedId),
      clerk.countDescendantsByPhase(resolvedId),
    ]);

    // Parent context
    let parent: { id: string; title: string; phase: WritPhase } | null = null;
    if (writ.parentId) {
      const parentWrit = await clerk.show(writ.parentId);
      parent = { id: parentWrit.id, title: parentWrit.title, phase: parentWrit.phase };
    }

    // Direct-children list — `items` stays direct-children-only. The subtree-wide
    // phase tally lives in `summary` (computed via clerk.countDescendantsByPhase).
    const childWrits = await clerk.list({ parentId: writ.id, limit: 1000 });
    const items: Array<{ id: string; title: string; phase: WritPhase }> = [];
    for (const child of childWrits) {
      items.push({ id: child.id, title: child.title, phase: child.phase });
    }

    return {
      ...writ,
      links,
      parent,
      children: { summary, items },
    };
  },
});
