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
  },
  handler: (params, { home }) => {
    const resolvedParent = params.parentId ?? process.env.NEXUS_WRIT_ID ?? undefined;
    return createWrit(home, {
      type: params.type,
      title: params.title,
      description: params.description,
      parentId: resolvedParent,
    });
  },
});
