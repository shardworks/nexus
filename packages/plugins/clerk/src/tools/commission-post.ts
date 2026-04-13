import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'commission-post',
  description: 'Post a new commission, creating a writ in open or new (draft) status',
  instructions:
    'Creates a new writ. By default the writ is placed in open status and enters the queue ' +
    'immediately. Pass draft: true to create the writ in new (draft) status instead — draft ' +
    'writs are held out of the queue until explicitly published with writ-publish. ' +
    'The writ type must be a type declared in the guild config, or the built-in type "mandate". ' +
    'If type is omitted, the guild\'s configured default type is used (defaults to "mandate"). ' +
    'Use parentId to create this writ as a child of an existing writ. The parent must be in ' +
    'new or open status.',
  params: {
    title: z.string().describe('Short human-readable title describing the work'),
    body: z.string().describe('Detail text or description'),
    type: z.string().optional().describe('Writ type (default: guild defaultType or "mandate")'),
    codex: z.string().optional().describe('Target codex name'),
    draft: z
      .boolean()
      .optional()
      .describe(
        'When true, create the writ in new (draft) status instead of open. ' +
        'Draft writs must be published before they enter the execution queue.',
      ),
    parentId: z
      .string()
      .optional()
      .describe(
        'Create this writ as a child of the specified parent writ. ' +
        'The parent must be in new or open status.',
      ),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    return clerk.post({
      title: params.title,
      body: params.body,
      type: params.type,
      codex: params.codex,
      draft: params.draft,
      parentId: params.parentId,
    });
  },
});
