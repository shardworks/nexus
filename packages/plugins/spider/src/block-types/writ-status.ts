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
import type { BlockType } from '../types.ts';

const conditionSchema = z.object({
  writId: z.string(),
  targetStatus: z.string(),
});

const writStatusBlockType: BlockType = {
  id: 'writ-status',
  conditionSchema,
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<boolean> {
    const { writId, targetStatus } = conditionSchema.parse(condition);
    const stacks = guild().apparatus<StacksApi>('stacks');
    const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
    const results = await writsBook.find({ where: [['id', '=', writId]], limit: 1 });
    if (results.length === 0) return false;
    return results[0].status === targetStatus;
  },
};

export default writStatusBlockType;
