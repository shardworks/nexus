import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { CartographApi } from '../types.ts';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import { composeListRows, renderListTable } from './render.ts';

/** Stage enum values for pieces (mirrors `PieceStage` from `../types.ts`). */
const PIECE_STAGES = ['draft', 'active', 'done', 'dropped'] as const;

/**
 * List pieces ordered by createdAt descending. Filter args mirror the
 * typed API exactly (D10): `--stage`, `--codex`, `--limit`, `--offset`,
 * plus the read-only `--format` flag. Parent-filtered listing falls back
 * to `nsg writ list --type piece --parent-id <charge>`.
 */
export default tool({
  name: 'piece-list',
  description: 'List pieces with optional filters',
  instructions:
    'Returns piece summaries ordered by createdAt descending (newest first). ' +
    'Filter by stage or codex to narrow results. Parent-filtered listing falls ' +
    'back to `nsg writ list --type piece --parent-id <charge|piece>`. The default ' +
    '`--format text` renders a tabular view (STAGE | ID | CODEX | TITLE | CREATED) ' +
    'with per-row titles fetched from the writ rows; pass `--format json` for the ' +
    'raw doc array.',
  params: {
    stage: z.enum(PIECE_STAGES).optional().describe('Filter by stage'),
    codex: z.string().optional().describe('Filter by codex'),
    limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
    offset: z.number().optional().describe('Number of results to skip'),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" renders the tabular view (default). "json" returns the raw doc array.'),
  },
  permission: 'read',
  callableBy: ['patron'],
  handler: async (params) => {
    const cartograph = guild().apparatus<CartographApi>('cartograph');
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const docs = await cartograph.listPieces({
      ...(params.stage !== undefined ? { stage: params.stage } : {}),
      ...(params.codex !== undefined ? { codex: params.codex } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    });
    if (params.format === 'json') return docs;
    const rows = await composeListRows(docs, clerk);
    return renderListTable(rows);
  },
});
