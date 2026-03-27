import { tool } from '@shardworks/nexus-core';
import { createWrit, signalEvent } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'post-writ',
  description: 'Post a top-level writ that enters the Clockworks pipeline',
  instructions:
    'Post a new writ on behalf of the patron. This creates a writ with sourceType "patron" and ' +
    'signals the writ.posted event so the Clockworks pipeline fires (workshop preparation, ' +
    'artificer summoning, etc.). Use this for top-level work items — not for child writ ' +
    'decomposition (use create-writ for that).',
  params: {
    title: z.string().describe('Short title describing what needs to be done'),
    description: z.string().optional().describe('Detailed description of the work'),
    workshop: z.string().optional().describe('Target workshop (workspace-bound work)'),
    type: z.string().optional().describe('Writ type (defaults to "writ")'),
  },
  handler: (params, { home }) => {
    const writ = createWrit(home, {
      type: params.type,
      title: params.title,
      description: params.description,
      workshop: params.workshop,
      sourceType: 'patron',
    });

    signalEvent(home, 'writ.posted', {
      writId: writ.id,
      workshop: writ.workshop,
    }, 'framework');

    return writ;
  },
});
