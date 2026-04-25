import { z } from 'zod';
import { guild, shortId } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritTree } from '../types.ts';
import { deriveStateIndicator } from '../writ-presentation.ts';

/**
 * Render a forest of `WritTree` nodes as a text tree with box-drawing
 * connectors, modeled directly on click-tree. Each row aligns the short id
 * column and pads the title so the phase indicator lands in a stable
 * column even with deep nesting.
 *
 * Indicators are derived per-row from the writ's classification (carried
 * on the WritTree node) plus the per-state attrs read from the writ's
 * registered type config. Tolerant of unregistered types and undeclared
 * states (D17): both surface as `?` and the walker continues.
 */
function renderForest(forest: WritTree[], clerk: ClerkApi): string {
  const lines: string[] = [];

  // Pass 1: compute max short-id width so the id column aligns.
  let maxIdWidth = 0;
  function measureIds(trees: WritTree[]): void {
    for (const tree of trees) {
      const w = shortId(tree.writ.id).length;
      if (w > maxIdWidth) maxIdWidth = w;
      measureIds(tree.children);
    }
  }
  measureIds(forest);
  // Two-space gap between id column and title.
  const idColumnWidth = maxIdWidth + 2;

  // Pass 2: compute max content width (indent + id col + title length).
  let maxContentWidth = 0;
  function measureContent(trees: WritTree[], depth: number): void {
    for (const tree of trees) {
      const indentWidth = depth * 4;
      const w = indentWidth + idColumnWidth + (tree.writ.title ?? '').length;
      if (w > maxContentWidth) maxContentWidth = w;
      measureContent(tree.children, depth + 1);
    }
  }
  measureContent(forest, 0);
  // Cap at 72 — same number ratchet uses.
  const maxColumnWidth = Math.min(maxContentWidth, 72);

  function renderNode(tree: WritTree, prefix: string, isLast: boolean, isRoot: boolean): void {
    // Look up attrs for this writ's current state — combined with the
    // classification carried on tree.writ, the deriveStateIndicator helper
    // produces the box-drawing glyph. When the type is unregistered or the
    // state undeclared, classification is `'unknown'` and the helper
    // surfaces `?` per D17 — the row still renders and the walk continues.
    const config = clerk.getWritTypeConfig(tree.writ.type);
    const stateAttrs =
      config?.states.find((s) => s.name === tree.writ.phase)?.attrs ?? [];
    const indicator = deriveStateIndicator({
      classification: tree.writ.classification,
      attrs: stateAttrs,
    }).glyph;
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    const linePrefix = isRoot ? '' : prefix + connector;
    const idPadded = shortId(tree.writ.id).padEnd(idColumnWidth);

    let title = tree.writ.title ?? '';
    const maxTitleLen = maxColumnWidth - linePrefix.length - idColumnWidth;
    if (maxTitleLen > 3 && title.length > maxTitleLen) {
      title = title.substring(0, maxTitleLen - 1) + '…';
    }

    const finalContentWidth = linePrefix.length + idColumnWidth + title.length;
    const padding = Math.max(2, maxColumnWidth - finalContentWidth + 2);

    lines.push(`${linePrefix}${idPadded}${title}${' '.repeat(padding)}${indicator}`);

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
  name: 'writ-tree',
  description: 'Display writ hierarchy as a visual tree',
  instructions:
    'Renders the writ hierarchy as a tree with box-drawing connectors, short writ IDs, ' +
    'and Unicode phase indicators. Each row shows the short ID (e.g. w-mo1mq8ry) in a fixed-width ' +
    'column before the title, so the ID can be fed directly to writ-show. ' +
    'Shows all root writs and their descendants by default. ' +
    'Use --root-id to show a specific subtree, --phase / --type to filter (prune semantics — ' +
    'a non-matching node is dropped together with its subtree), and --depth to limit tree depth. ' +
    'Pass --format json to return the structured WritTree[] forest instead of the rendered ASCII ' +
    '(the default --format text preserves the CLI rendering).',
  params: {
    rootId: z.string().optional().describe('Show subtree rooted at this writ ID or prefix'),
    phase: z
      .union([
        z.enum(['new', 'open', 'stuck', 'completed', 'failed', 'cancelled']),
        z
          .array(z.enum(['new', 'open', 'stuck', 'completed', 'failed', 'cancelled']))
          .min(1),
      ])
      .optional()
      .describe('Filter by writ phase (repeatable). Non-matching nodes and their subtrees are pruned.'),
    type: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe('Filter by writ type (repeatable). Non-matching nodes and their subtrees are pruned.'),
    classification: z
      .union([
        z.enum(['initial', 'active', 'terminal']),
        z.array(z.enum(['initial', 'active', 'terminal'])).min(1),
      ])
      .optional()
      .describe(
        'Filter by state classification (repeatable). Non-matching nodes ' +
          'and their subtrees are pruned. Type-agnostic — matches across ' +
          'every registered writ type.',
      ),
    depth: z.number().optional().describe('Maximum tree depth to display (0 = roots only)'),
    rootLimit: z.number().optional().describe('Maximum number of roots to include (forest mode)'),
    rootOffset: z.number().optional().describe('Skip this many roots before slicing (forest mode)'),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" returns the ASCII tree (default). "json" returns the structured WritTree[] forest.'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');

    const resolvedRootId = params.rootId
      ? await clerk.resolveId(params.rootId)
      : undefined;

    const forest = await clerk.tree({
      rootId: resolvedRootId,
      phase: params.phase,
      type: params.type,
      classification: params.classification,
      depth: params.depth,
      rootLimit: params.rootLimit,
      rootOffset: params.rootOffset,
    });

    if (params.format === 'json') {
      return forest;
    }

    if (forest.length === 0) {
      if (
        params.rootId ||
        params.phase ||
        params.type ||
        params.classification ||
        params.depth !== undefined
      ) {
        return 'No writs match the given filters.';
      }
      return 'No writs found.';
    }

    return renderForest(forest, clerk);
  },
});
