import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-extract',
  description: 'Extract a click tree as markdown or JSON',
  instructions:
    'Extracts the click and all its descendants as a hierarchical document. ' +
    'By default, only goals are shown (conclusions are omitted). Pass --full to include conclusions. ' +
    'Markdown format renders headings by depth. JSON returns nested ClickTree objects.',
  params: {
    id: z.string().describe('Root click ID or prefix'),
    format: z.enum(['md', 'json']).default('md').describe('Output format (default: md)'),
    full: z.boolean().optional().describe('Include conclusions in output (default: goals only)'),
  },
  permission: 'read',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.extract(resolvedId, { format: params.format, full: params.full });
  },
});
