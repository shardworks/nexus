import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { createWrit } from '@shardworks/nexus-core/legacy/1';
import { z } from 'zod';

export default tool({
  name: 'create-writ',
  description: 'Create a child writ to decompose work into sub-items',
  instructions:
    'Use this to break your work into trackable sub-items. Each child writ fires a ' +
    '<type>.ready event that can trigger standing orders (e.g. summon an artificer for a task). ' +
    'If parentId is omitted, the child is created under the current session writ. ' +
    'Type defaults to "writ" if omitted; use a guild-declared type if the guild has defined custom types.',
  params: {
    type: z.string().optional().describe('Writ type (defaults to "writ"; guild-declared types also accepted)'),
    title: z.string().describe('Short title describing what needs to be done'),
    description: z.string().optional().describe('Detailed description of the work'),
    parentId: z.string().optional().describe('Parent writ ID (defaults to current session writ)'),
    workshop: z.string().optional().describe('Workshop name (inherits from parent if omitted)'),
  },
  handler: (params) => {
    const { home } = guild();
    const resolvedParent = params.parentId ?? process.env.NEXUS_WRIT_ID ?? undefined;

    return createWrit(home, {
      type: params.type,
      title: params.title,
      description: params.description,
      parentId: resolvedParent,
      workshop: params.workshop,
      sourceType: 'anima',
      // sourceId would be the anima's ID, but no anima ID is available in
      // the tool execution context — only the writ ID (NEXUS_WRIT_ID) is
      // injected, and storing that here would be semantically wrong.
      // Left null until session context exposes the anima identity.
    });
  },
});
