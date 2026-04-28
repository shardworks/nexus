import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { ClerkApi, WritPhase } from '@shardworks/clerk-apparatus';

import type { LatticeApi, PulseDoc } from '../types.ts';

/** Writ phases considered still-actionable for `--live` filtering. */
const LIVE_WRIT_PHASES = new Set<WritPhase>(['stuck', 'failed']);

export default tool({
  name: 'pulse-list',
  description: 'List pulses emitted on the Lattice',
  instructions:
    'Returns pulses ordered by createdAt descending (newest first). Defaults to the ' +
    'last 24h; pass --since or --all to override. Use --live to exclude pulses whose ' +
    'referent writ is no longer in stuck or failed (drain pulses are also excluded).',
  params: {
    live: z
      .boolean()
      .optional()
      .describe(
        'Filter out pulses whose referent writ is no longer in stuck/failed. Drain pulses (null writId) are excluded entirely.',
      ),
    all: z
      .boolean()
      .optional()
      .describe('Disable the default 24h window and return every pulse.'),
    since: z
      .string()
      .optional()
      .describe('Only pulses created at or after this ISO timestamp (overrides the default 24h window).'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .default(20)
      .describe('Maximum results (default: 20).'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe('Number of results to skip (default: 0).'),
  },
  permission: 'read',
  handler: async (params): Promise<PulseDoc[]> => {
    const g = guild();
    const lattice = g.apparatus<LatticeApi>('lattice');

    const filters: Parameters<LatticeApi['list']>[0] = {
      limit: params.limit,
      offset: params.offset,
    };
    if (params.since !== undefined) {
      filters.since = params.since;
    } else if (params.all === true) {
      // Disable the default 24h window by setting an epoch lower bound.
      filters.since = new Date(0).toISOString();
    }

    const pulses = await lattice.list(filters);

    if (params.live !== true) return pulses;

    // --live: exclude drain pulses (null writId) and drop writ-scoped pulses
    // whose current writ phase is no longer stuck or failed.
    //
    // We resolve each referenced writ lazily; this is not the hot path
    // (pulse volume is low) and keeps the implementation straightforward.
    let clerk: ClerkApi | undefined;
    try {
      clerk = g.apparatus<ClerkApi>('clerk');
    } catch {
      // If clerk is absent we cannot check referent phase; fall back to
      // excluding only drain pulses (same conservative stance as "no data").
      clerk = undefined;
    }

    const filtered: PulseDoc[] = [];
    for (const pulse of pulses) {
      if (pulse.writId == null) continue;
      if (!clerk) continue;
      try {
        const writ = await clerk.show(pulse.writId);
        if (LIVE_WRIT_PHASES.has(writ.phase as WritPhase)) {
          filtered.push(pulse);
        }
      } catch {
        // Writ no longer resolvable — treat as no-longer-live.
      }
    }
    return filtered;
  },
});
