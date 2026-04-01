/**
 * codex-show tool — show details of a specific codex including active drafts.
 */

import { tool } from '@shardworks/tools-apparatus';
import { guild } from '@shardworks/nexus-core';
import { z } from 'zod';
import type { ScriptoriumApi } from '../types.ts';

export default tool({
  name: 'codex-show',
  description: 'Show details of a registered codex including active draft bindings',
  permission: 'read',
  params: {
    name: z.string().describe('Codex name'),
  },
  handler: async ({ name }) => {
    const api = guild().apparatus<ScriptoriumApi>('codexes');
    return api.show(name);
  },
});
