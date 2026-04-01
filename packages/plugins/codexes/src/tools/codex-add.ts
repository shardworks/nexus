/**
 * codex-add tool — register an existing git repository as a guild codex.
 *
 * Clones a bare copy to `.nexus/codexes/<name>.git` and adds the entry
 * to guild.json. Blocks until the clone completes.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ScriptoriumApi } from '../types.ts';

export default tool({
  name: 'codex-add',
  description: 'Register an existing git repository as a guild codex',
  permission: 'write',
  params: {
    name: z.string().describe('Name for the codex (unique within the guild)'),
    remoteUrl: z.string().describe('Git remote URL of the repository'),
  },
  handler: async ({ name, remoteUrl }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes');
    return api.add(name, remoteUrl);
  },
});
