/**
 * Revise engine — stub (Increment 1).
 *
 * Returns a completed result with mock yields so the full pipeline can be
 * tested end-to-end. Increment 3 replaces this with real Animator-backed
 * quick engine execution.
 */

import type { EngineDesign } from '@shardworks/fabricator-apparatus';

const reviseEngine: EngineDesign = {
  id: 'revise',

  async run(_givens, _context) {
    return {
      status: 'completed',
      yields: {
        sessionId: 'stub',
        sessionStatus: 'completed',
      },
    };
  },
};

export default reviseEngine;
