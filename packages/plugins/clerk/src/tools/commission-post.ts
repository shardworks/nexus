import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

/**
 * Minimal structural subset of the codexes apparatus's `ScriptoriumApi`
 * that the commission-post handler relies on. Declared locally to keep
 * the codexes apparatus a soft (`recommends`) dependency — clerk does
 * not pull `@shardworks/codexes-apparatus` into its dependency graph.
 */
interface CodexRegistry {
  list(): Promise<Array<{ name: string }>>;
}

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
    'new or open phase. ' +
    'When codex is omitted: if parentId is provided, the codex is inherited from the parent ' +
    'writ; otherwise, when the guild has exactly one registered codex it is selected ' +
    'automatically, when the guild has two or more registered codexes the call fails with ' +
    'an error naming the candidates, and when no codexes are registered the call fails ' +
    'asking the operator to install or declare one.',
  params: {
    title: z.string().describe('Short human-readable title describing the work'),
    body: z.string().describe('Detail text or description'),
    type: z.string().optional().describe('Writ type (default: guild defaultType or "mandate")'),
    codex: z
      .string()
      .optional()
      .describe(
        'Target codex name. Optional. When omitted: inherited from parentId when provided; ' +
        'otherwise defaulted to the single registered codex when the guild has exactly one; ' +
        'rejected at post time when the guild has two or more (error names the candidates) or ' +
        'when no codexes are registered.',
      ),
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

    // Resolve codex up-front when the caller did not supply one and is
    // not relying on parent inheritance. Two cases collapse to a hard
    // error here so that no codex-less writ enters the queue: a guild
    // with multiple registered codexes (ambiguous default) and a guild
    // with none (nothing to inherit from). A guild with exactly one
    // registered codex defaults silently. When parentId is supplied we
    // skip resolution entirely and let clerk.post()'s existing parent-
    // inheritance branch fire.
    let resolvedCodex = params.codex;
    if (resolvedCodex === undefined && resolvedParentId === undefined) {
      const codexes = guild().tryApparatus<CodexRegistry>('codexes');
      const registered = codexes ? await codexes.list() : [];
      const names = registered
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      if (names.length === 1) {
        resolvedCodex = names[0];
      } else if (names.length === 0) {
        throw new Error(
          'no codexes are registered; install a codex package or declare one in guild.json before posting commissions',
        );
      } else {
        throw new Error(
          `commission-post: --codex is required when the guild has multiple codexes (registered: ${names.join(', ')})`,
        );
      }
    }

    const writ = await clerk.post({
      title: params.title,
      body: params.body,
      type: params.type,
      codex: resolvedCodex,
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
