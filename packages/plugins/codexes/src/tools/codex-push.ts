/**
 * codex-push tool — push a branch to the codex's remote.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ScriptoriumApi } from '../types.ts';

export default tool({
  name: 'codex-push',
  description: 'Push a branch to the codex remote',
  permission: 'write',
  params: {
    codexName: z.string().describe('Codex name'),
    branch: z.string().optional().describe('Branch to push (default: codex default branch)'),
  },
  handler: async (params) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes');
    return api.push(params);
  },
});
