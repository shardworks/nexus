import { z } from 'zod';
import { guild, shortId } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritWithPresentation } from '../types.ts';
import { derivePresentation } from '../writ-presentation.ts';

/**
 * Render a tabular text view of `writ-list` rows. Columns: `type | state |
 * id | title | created` (D2). Each column is padded to the widest cell so
 * the human-readable view stays aligned across heterogeneous writ types.
 *
 * The header row uses the literal column names; data rows render the
 * writ's state name verbatim from its type config, so any registered
 * writ type's vocabulary surfaces without hardcoded mandate phase
 * literals.
 */
function renderTable(rows: WritWithPresentation[]): string {
  if (rows.length === 0) return 'No writs found.';

  const headers: [keyof WritWithPresentation | 'state' | 'created', string][] = [
    ['type', 'TYPE'],
    ['state', 'STATE'],
    ['id', 'ID'],
    ['title', 'TITLE'],
    ['created', 'CREATED'],
  ];

  function cell(row: WritWithPresentation, col: typeof headers[number][0]): string {
    if (col === 'state') return row.phase ?? '';
    if (col === 'created') return row.createdAt ?? '';
    if (col === 'id') return shortId(row.id);
    if (col === 'title') return row.title ?? '';
    if (col === 'type') return row.type ?? '';
    return '';
  }

  // Compute column widths (max of header label and longest cell).
  const widths = headers.map(([key, label]) => {
    let w = label.length;
    for (const row of rows) {
      const cellLen = cell(row, key).length;
      if (cellLen > w) w = cellLen;
    }
    return w;
  });

  const lines: string[] = [];
  lines.push(headers.map(([, label], i) => label.padEnd(widths[i])).join('  '));
  lines.push(headers.map((_, i) => '─'.repeat(widths[i])).join('  '));
  for (const row of rows) {
    lines.push(headers.map(([key], i) => cell(row, key).padEnd(widths[i])).join('  '));
  }
  return lines.join('\n');
}

export default tool({
  name: 'writ-list',
  description: 'List writs with optional filters',
  instructions:
    'Returns writ summaries ordered by createdAt descending (newest first). ' +
    'Filter by phase or type to narrow results. The default `--format text` ' +
    'renders a tabular view (TYPE | STATE | ID | TITLE | CREATED); pass ' +
    '`--format json` to receive the structured rows with `classification` ' +
    'and `allowedTransitions` embedded on every entry.',
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
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" returns the tabular view (default). "json" returns the structured rows.'),
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

    if (params.format === 'json') {
      return rows;
    }

    return renderTable(rows);
  },
});
