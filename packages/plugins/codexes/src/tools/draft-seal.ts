/**
 * draft-seal tool — seal a draft into the codex.
 *
 * Incorporates the draft's inscriptions into the sealed binding via
 * ff-only merge. If ff is not possible, rebases and retries. Fails
 * hard on conflicts — no merge commits, no auto-resolution.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ScriptoriumApi } from '../types.ts';

export default tool({
  name: 'draft-seal',
  description: 'Seal a draft binding into the codex (ff-only merge or rebase; no merge commits)',
  permission: 'write',
  params: {
    codexName: z.string().describe('Codex name'),
    sourceBranch: z.string().describe('Draft branch to seal'),
    targetBranch: z.string().optional().describe('Target branch (default: codex default branch)'),
    maxRetries: z.number().optional().describe('Max rebase retries under contention (default: 3)'),
    keepDraft: z.boolean().optional().describe('Keep draft after sealing (default: false)'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes');
    return api.seal(params);
  },
});
