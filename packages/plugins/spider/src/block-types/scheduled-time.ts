/**
 * Built-in block type: scheduled-time.
 *
 * Blocks until a specified ISO 8601 timestamp is reached.
 * Condition: { resumeAt: string }
 */

import { z } from 'zod';
import type { BlockType, CheckResult } from '../types.ts';

const conditionSchema = z.object({
  resumeAt: z.string(),
});

const scheduledTimeBlockType: BlockType = {
  id: 'scheduled-time',
  conditionSchema,
  pollIntervalMs: 30_000,
  async check(condition: unknown): Promise<CheckResult> {
    const { resumeAt } = conditionSchema.parse(condition);
    return Date.now() >= Date.parse(resumeAt) ? { status: 'cleared' } : { status: 'pending' };
  },
};

export default scheduledTimeBlockType;
