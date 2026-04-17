import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritPhase } from '../types.ts';

export default tool({
  name: 'writ-show',
  description: 'Show full detail for a writ',
  instructions:
    'Returns the complete writ record including its current phase, timestamps, body text, ' +
    'resolution, parent context, and children summary.',
  params: {
    id: z.string().describe('Writ id'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    const [writ, links] = await Promise.all([
      clerk.show(resolvedId),
      clerk.links(resolvedId),
    ]);

    // Parent context
    let parent: { id: string; title: string; phase: WritPhase } | null = null;
    if (writ.parentId) {
      const parentWrit = await clerk.show(writ.parentId);
      parent = { id: parentWrit.id, title: parentWrit.title, phase: parentWrit.phase };
    }

    // Children context
    const childWrits = await clerk.list({ parentId: writ.id, limit: 1000 });
    const summary: Record<string, number> = {};
    const items: Array<{ id: string; title: string; phase: WritPhase }> = [];
    for (const child of childWrits) {
      summary[child.phase] = (summary[child.phase] ?? 0) + 1;
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
