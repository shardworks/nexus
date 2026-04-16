import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi, ClickTree, ClickStatus } from '../types.ts';

const STATUS_INDICATORS: Record<ClickStatus, string> = {
  live: '●',
  parked: '◇',
  concluded: '○',
  dropped: '✕',
};

/**
 * Render a forest of ClickTree nodes as a text tree with box-drawing connectors.
 * Right-pads goals to align status indicators to a consistent column.
 */
function renderForest(forest: ClickTree[]): string {
  const lines: string[] = [];

  // First pass: compute max goal width for alignment
  let maxGoalWidth = 0;
  function measureGoals(trees: ClickTree[], depth: number): void {
    for (const tree of trees) {
      // Account for indentation: 4 chars per depth level for connectors
      const indentWidth = depth * 4;
      const goalWidth = indentWidth + tree.click.goal.length;
      if (goalWidth > maxGoalWidth) maxGoalWidth = goalWidth;
      measureGoals(tree.children, depth + 1);
    }
  }
  measureGoals(forest, 0);

  // Cap column width to avoid absurdly wide output
  const maxColumnWidth = Math.min(maxGoalWidth, 72);

  function renderNode(tree: ClickTree, prefix: string, isLast: boolean, isRoot: boolean): void {
    const indicator = STATUS_INDICATORS[tree.click.status];
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    const goalText = tree.click.goal;

    // Compute visible text length (prefix + connector + goal)
    const linePrefix = isRoot ? '' : prefix + connector;
    const contentWidth = linePrefix.length + goalText.length;

    // Truncate if needed
    let displayGoal = goalText;
    const maxGoalLen = maxColumnWidth - linePrefix.length;
    if (maxGoalLen > 3 && displayGoal.length > maxGoalLen) {
      displayGoal = displayGoal.substring(0, maxGoalLen - 1) + '…';
    }

    const finalContentWidth = linePrefix.length + displayGoal.length;
    const padding = Math.max(2, maxColumnWidth - finalContentWidth + 2);

    lines.push(`${linePrefix}${displayGoal}${' '.repeat(padding)}${indicator}`);

    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < tree.children.length; i++) {
      renderNode(tree.children[i], childPrefix, i === tree.children.length - 1, false);
    }
  }

  for (let i = 0; i < forest.length; i++) {
    if (i > 0) lines.push('');
    renderNode(forest[i], '', true, true);
  }

  return lines.join('\n');
}

export default tool({
  name: 'click-tree',
  description: 'Display click hierarchy as a visual tree',
  instructions:
    'Renders the click hierarchy as a tree with box-drawing connectors and Unicode status indicators. ' +
    'Shows all root clicks and their descendants by default. ' +
    'Use --root-id to show a specific subtree, --status to filter by status (prune semantics), ' +
    'and --depth to limit tree depth.',
  params: {
    rootId: z.string().optional().describe('Show subtree rooted at this click ID or prefix'),
    status: z
      .union([
        z.enum(['live', 'parked', 'concluded', 'dropped']),
        z.array(z.enum(['live', 'parked', 'concluded', 'dropped'])).min(1),
      ])
      .optional()
      .describe('Filter by click status (repeatable — pass multiple to match any). Non-matching nodes and their subtrees are pruned.'),
    depth: z.number().optional().describe('Maximum tree depth to display (0 = roots only)'),
  },
  permission: 'read',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');

    const resolvedRootId = params.rootId
      ? await ratchet.resolveId(params.rootId)
      : undefined;

    const forest = await ratchet.tree({
      rootId: resolvedRootId,
      status: params.status,
      depth: params.depth,
    });

    if (forest.length === 0) {
      if (params.rootId || params.status || params.depth !== undefined) {
        return 'No clicks match the given filters.';
      }
      return 'No clicks found.';
    }

    return renderForest(forest);
  },
});
