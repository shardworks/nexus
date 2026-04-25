import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'commission-post',
  description: 'Post a new commission, creating a writ in open or new (draft) phase',
  instructions:
    'Creates a new writ. By default the writ is placed in open phase and enters the queue ' +
    'immediately. Pass draft: true to create the writ in new (draft) phase instead — draft ' +
    'writs are held out of the queue until explicitly published with writ-publish. ' +
    'The writ type must be a type declared in the guild config, or the built-in type "mandate". ' +
    'If type is omitted, the guild\'s configured default type is used (defaults to "mandate"). ' +
    'Use parentId to create this writ as a child of an existing writ. The parent must be in ' +
    'new or open phase.',
  params: {
    title: z.string().describe('Short human-readable title describing the work'),
    body: z.string().describe('Detail text or description'),
    type: z.string().optional().describe('Writ type (default: guild defaultType or "mandate")'),
    codex: z.string().optional().describe('Target codex name'),
    draft: z
      .boolean()
      .optional()
      .describe(
        'When true, create the writ in new (draft) phase instead of open. ' +
        'Draft writs must be published before they enter the execution queue.',
      ),
    parentId: z
      .string()
      .optional()
      .describe(
        'Create this writ as a child of the specified parent writ. ' +
        'The parent must be in new or open phase.',
      ),
  },
  permission: 'write',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedParentId = params.parentId
      ? await clerk.resolveId(params.parentId)
      : undefined;
    const writ = await clerk.post({
      title: params.title,
      body: params.body,
      type: params.type,
      codex: params.codex,
      parentId: resolvedParentId,
    });

    // Auto-publish for mandate writs: `post()` always lands the writ in its
    // type's declared initial state, which for mandate is `new` (draft).
    // The commission-post tool preserves its prior UX — by default the
    // posted writ enters the queue immediately — by transitioning the
    // writ to `open` here when the caller did not request a draft. The
    // auto-advance is deliberately confined to mandate: for other
    // plugin-registered types the initial state is the caller's only
    // landing spot, and advancing without a type-specific tool would be
    // silent coupling.
    if (params.draft !== true && writ.type === 'mandate') {
      return clerk.transition(writ.id, 'open');
    }
    return writ;
  },
});
