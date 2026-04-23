import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi, ClickStatus } from '../types.ts';

export default tool({
  name: 'click-show',
  description: 'Show full detail for a click including links, parent, and children',
  instructions:
    'Returns the complete click record enriched with outbound/inbound links, ' +
    'parent context, and children. The `children.summary` field is a status-keyed ' +
    'count of the entire descendant subtree beneath this click (grandchildren and ' +
    'deeper included; the click itself is excluded). The `children.items` list stays ' +
    'scoped to direct children only.',
  params: {
    id: z.string().describe('Click ID or prefix'),
  },
  permission: 'read',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    const [click, links, summary] = await Promise.all([
      ratchet.get(resolvedId),
      ratchet.links(resolvedId),
      ratchet.countDescendantsByStatus(resolvedId),
    ]);

    // Parent context
    let parent: { id: string; goal: string; status: ClickStatus } | null = null;
    if (click.parentId) {
      const parentClick = await ratchet.get(click.parentId);
      parent = { id: parentClick.id, goal: parentClick.goal, status: parentClick.status };
    }

    // Direct-children list — `items` stays direct-children-only. The subtree-wide
    // status tally lives in `summary` (computed via ratchet.countDescendantsByStatus).
    const childClicks = await ratchet.list({ parentId: click.id, limit: 1000 });
    const items: Array<{ id: string; goal: string; status: ClickStatus }> = [];
    for (const child of childClicks) {
      items.push({ id: child.id, goal: child.goal, status: child.status });
    }

    return {
      ...click,
      links,
      parent,
      children: { summary, items },
    };
  },
});
