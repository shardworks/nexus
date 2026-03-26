/**
 * commission tool.
 *
 * Posts a commission to the guild and signals commission.posted for the
 * Clockworks. Everything downstream (worktree setup, anima summoning,
 * merge) is handled by standing orders.
 */
import { tool, commission } from '@shardworks/nexus-core';
import { z } from 'zod';

export default tool({
  name: 'commission-create',
  description: 'Post a commission to the guild for an artificer to work on',
  instructionsFile: './instructions/commission-create.md',
  params: {
    spec: z.string().describe('Commission specification — what needs to be done'),
    workshop: z.string().describe('Target workshop for the commission'),
  },
  handler: (params, { home }) => {
    return commission({ home, ...params });
  },
});
