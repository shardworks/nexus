import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi } from '../types.ts';

export default tool({
  name: 'writ-edit',
  description: 'Edit a writ, updating its title, body, type, or codex',
  instructions:
    'Updates one or more fields of a writ. Title and body can be edited regardless of status. ' +
    'Type and codex can only be changed while the writ is in "new" (draft) status. ' +
    'At least one field (title, body, type, or codex) must be provided. ' +
    'The type field, if provided, must be a valid declared writ type. ' +
    'Pass an empty string for codex to clear it. Returns the updated writ.',
  params: {
    id: z.string().describe('Writ id'),
    title: z.string().optional().describe('New title for the writ'),
    body: z.string().optional().describe('New body text for the writ'),
    type: z.string().optional().describe('New writ type (must be a valid declared type)'),
    codex: z.string().optional().describe('New target codex name (empty string to clear)'),
  },
  permission: 'write',
  handler: async (params) => {
    // Ensure at least one editable field is provided
    if (
      params.title === undefined &&
      params.body === undefined &&
      params.type === undefined &&
      params.codex === undefined
    ) {
      throw new Error('At least one field (title, body, type, or codex) must be provided.');
    }

    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    return clerk.edit({
      id: resolvedId,
      title: params.title,
      body: params.body,
      type: params.type,
      codex: params.codex,
    });
  },
});
