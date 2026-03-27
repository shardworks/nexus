import { tool } from '@shardworks/nexus-core';
import { createWrit } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'create-writ',
  description: 'Create a child writ to decompose work into sub-items',
  instructions:
    'Use this to break your work into trackable sub-items. Each child writ fires a ' +
    '<type>.ready event that can trigger standing orders (e.g. summon an artificer for a task). ' +
    'If parentId is omitted, the child is created under the current session writ.',
  params: {
    type: z.string().describe('Writ type (must be declared in guild.json writTypes)'),
    title: z.string().describe('Short title describing what needs to be done'),
    description: z.string().optional().describe('Detailed description of the work'),
    parentId: z.string().optional().describe('Parent writ ID (defaults to current session writ)'),
    workshop: z.string().optional().describe('Workshop name (inherits from parent if omitted)'),
  },
  handler: (params, { home }) => {
    const resolvedParent = params.parentId ?? process.env.NEXUS_WRIT_ID ?? undefined;

    // Resolve source ID from the calling anima's session writ
    const sourceId = process.env.NEXUS_WRIT_ID ?? null;

    return createWrit(home, {
      type: params.type,
      title: params.title,
      description: params.description,
      parentId: resolvedParent,
      workshop: params.workshop,
      sourceType: 'anima',
      sourceId: sourceId ?? undefined,
    });
  },
});
