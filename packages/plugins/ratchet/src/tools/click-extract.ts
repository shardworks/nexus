import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { RatchetApi } from '../types.ts';

export default tool({
  name: 'click-extract',
  description: 'Extract a click tree as markdown or JSON',
  instructions:
    'Extracts the click and all its descendants as a hierarchical document, including conclusions for any concluded or dropped clicks. ' +
    'Markdown format renders headings by depth. JSON returns nested ClickTree objects.',
  params: {
    id: z.string().describe('Root click ID or prefix'),
    format: z.enum(['md', 'json']).default('md').describe('Output format (default: md)'),
    depth: z.number().optional().describe('Maximum tree depth to display (0 = roots only)'),
  },
  permission: 'read',
  handler: async (params) => {
    const ratchet = guild().apparatus<RatchetApi>('ratchet');
    const resolvedId = await ratchet.resolveId(params.id);
    return ratchet.extract(resolvedId, {
      format: params.format,
      full: true,
      depth: params.depth,
    });
  },
});
