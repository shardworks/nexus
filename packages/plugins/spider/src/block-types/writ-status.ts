/**
 * Built-in block type: writ-status.
 *
 * Blocks until a specific writ reaches a target status.
 * Condition: { writId: string; targetStatus: string }
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { BlockType, CheckResult } from '../types.ts';

const conditionSchema = z.object({
  writId: z.string(),
  targetStatus: z.string(),
});

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const writStatusBlockType: BlockType = {
  id: 'writ-status',
  conditionSchema,
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<CheckResult> {
    const { writId, targetStatus } = conditionSchema.parse(condition);
    const stacks = guild().apparatus<StacksApi>('stacks');
    const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
    const results = await writsBook.find({ where: [['id', '=', writId]], limit: 1 });
    if (results.length === 0) return { status: 'failed', reason: 'Writ not found' };
    const writ = results[0];
    if (writ.status === targetStatus) return { status: 'cleared' };
    if (TERMINAL_STATUSES.has(writ.status)) {
      return { status: 'failed', reason: `Writ reached terminal status "${writ.status}" instead of "${targetStatus}"` };
    }
    return { status: 'pending' };
  },
};

export default writStatusBlockType;
