import { z } from 'zod';
import { guild, shortId } from '@shardworks/nexus-core';
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
 * Each row includes the short click ID in a fixed-width column between the
 * tree-drawing characters and the goal text, so Coco can pivot from `tree` to
 * `show`/`extract`/`--root-id` without a second lookup. Goals are right-padded
 * to align status indicators to a consistent column.
 */
function renderForest(forest: ClickTree[]): string {
  const lines: string[] = [];

  // First pass: compute max short-ID width so the ID column aligns even if
  // future IDs grow (e.g. once Date.now() base36 ticks to 9 chars).
  let maxIdWidth = 0;
  function measureIds(trees: ClickTree[]): void {
    for (const tree of trees) {
      const w = shortId(tree.click.id).length;
      if (w > maxIdWidth) maxIdWidth = w;
      measureIds(tree.children);
    }
  }
  measureIds(forest);

  // ID column includes a 2-space gap before the goal text.
  const idColumnWidth = maxIdWidth + 2;

  // Second pass: compute max content width (indent + ID column + goal).
  let maxContentWidth = 0;
  function measureContent(trees: ClickTree[], depth: number): void {
    for (const tree of trees) {
      // Account for indentation: 4 chars per depth level for connectors
      const indentWidth = depth * 4;
      const w = indentWidth + idColumnWidth + tree.click.goal.length;
      if (w > maxContentWidth) maxContentWidth = w;
      measureContent(tree.children, depth + 1);
    }
  }
  measureContent(forest, 0);

  // Cap column width to avoid absurdly wide output. The ID column counts
  // against this cap, so goal truncation tightens accordingly.
  const maxColumnWidth = Math.min(maxContentWidth, 72);

  function renderNode(tree: ClickTree, prefix: string, isLast: boolean, isRoot: boolean): void {
    const indicator = STATUS_INDICATORS[tree.click.status];
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    const goalText = tree.click.goal;

    const linePrefix = isRoot ? '' : prefix + connector;
    const idPadded = shortId(tree.click.id).padEnd(idColumnWidth);

    // Truncate goal if needed — goal gets whatever is left in the content
    // column after the line prefix and ID column.
    let displayGoal = goalText;
    const maxGoalLen = maxColumnWidth - linePrefix.length - idColumnWidth;
    if (maxGoalLen > 3 && displayGoal.length > maxGoalLen) {
      displayGoal = displayGoal.substring(0, maxGoalLen - 1) + '…';
    }

    const finalContentWidth = linePrefix.length + idColumnWidth + displayGoal.length;
    const padding = Math.max(2, maxColumnWidth - finalContentWidth + 2);

    lines.push(`${linePrefix}${idPadded}${displayGoal}${' '.repeat(padding)}${indicator}`);

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
    'Renders the click hierarchy as a tree with box-drawing connectors, short click IDs, ' +
    'and Unicode status indicators. Each row shows the short ID (e.g. c-mo1mq8ry) in a fixed-width ' +
    'column before the goal, so the ID can be fed directly to click-show / click-extract / --root-id. ' +
    'Shows all root clicks and their descendants by default. ' +
    'Use --root-id to show a specific subtree, --status to filter by status (prune semantics), ' +
    'and --depth to limit tree depth. ' +
    'Pass --format json to return the structured ClickTree[] forest instead of the rendered ASCII ' +
    '(the default --format text preserves the existing CLI rendering exactly).',
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
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" returns the ASCII tree (default). "json" returns the structured ClickTree[] forest.'),
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

    // JSON format: return the structured forest directly. Empty forests are
    // represented by an empty array — callers (e.g. the Oculus clicks page)
    // render their own "no clicks" state.
    if (params.format === 'json') {
      return forest;
    }

    if (forest.length === 0) {
      if (params.rootId || params.status || params.depth !== undefined) {
        return 'No clicks match the given filters.';
      }
      return 'No clicks found.';
    }

    return renderForest(forest);
  },
});
