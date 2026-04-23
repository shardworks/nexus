import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';

import type { LatticeApi, PulseDoc } from '../types.ts';

export default tool({
  name: 'pulse-show',
  description: 'Show full detail for a pulse',
  instructions:
    'Returns the complete pulse record including source, trigger type, summary, ' +
    'context payload, delivery state, and optional delivery error. Accepts a prefix ' +
    'of the pulse id and resolves it via LatticeApi.resolveId.',
  params: {
    id: z.string().describe('Pulse id (full or unique prefix).'),
  },
  permission: 'lattice:read',
  handler: async (params): Promise<PulseDoc> => {
    const lattice = guild().apparatus<LatticeApi>('lattice');
    const resolvedId = await lattice.resolveId(params.id);
    return lattice.show(resolvedId);
  },
});
