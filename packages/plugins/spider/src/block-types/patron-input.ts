/**
 * Built-in block type: patron-input.
 *
 * Blocks until a patron answers all questions in an input request.
 * Condition: { requestId: string }
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { BlockType, CheckResult, InputRequestDoc } from '../types.ts';

const conditionSchema = z.object({
  requestId: z.string(),
});

const patronInputBlockType: BlockType = {
  id: 'patron-input',
  conditionSchema,
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<CheckResult> {
    const { requestId } = conditionSchema.parse(condition);
    const stacks = guild().apparatus<StacksApi>('stacks');
    const book = stacks.readBook<InputRequestDoc>('spider', 'input-requests');
    const doc = await book.get(requestId);
    if (doc === null) return { status: 'failed', reason: 'Input request not found' };
    if (doc.status === 'completed') return { status: 'cleared' };
    if (doc.status === 'rejected') {
      return { status: 'failed', reason: doc.rejectionReason ?? 'Request rejected by patron' };
    }
    return { status: 'pending' };
  },
};

export default patronInputBlockType;
