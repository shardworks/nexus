/**
 * draft-list tool — list active draft bindings.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ScriptoriumApi } from '../types.ts';

export default tool({
  name: 'draft-list',
  description: 'List active draft bindings, optionally filtered by codex',
  permission: 'read',
  params: {
    codexName: z.string().optional().describe('Filter by codex name'),
  },
  handler: async ({ codexName }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes');
    return api.listDrafts(codexName);
  },
});
