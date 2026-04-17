/**
 * Built-in block type: writ-phase.
 *
 * Blocks until a specific writ reaches a target phase.
 * Condition: { writId: string; targetPhase: string }
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { BlockType, CheckResult } from '../types.ts';

const conditionSchema = z.object({
  writId: z.string(),
  targetPhase: z.string(),
});

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

const writPhaseBlockType: BlockType = {
  id: 'writ-phase',
  conditionSchema,
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<CheckResult> {
    const { writId, targetPhase } = conditionSchema.parse(condition);
    const stacks = guild().apparatus<StacksApi>('stacks');
    const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
    const results = await writsBook.find({ where: [['id', '=', writId]], limit: 1 });
    if (results.length === 0) return { status: 'failed', reason: 'Writ not found' };
    const writ = results[0];
    if (writ.phase === targetPhase) return { status: 'cleared' };
    if (TERMINAL_PHASES.has(writ.phase)) {
      return { status: 'failed', reason: `Writ reached terminal phase "${writ.phase}" instead of "${targetPhase}"` };
    }
    return { status: 'pending' };
  },
};

export default writPhaseBlockType;
