/**
 * surveyor-create-mandates — batch mandate creation tool for surveyor rigs.
 *
 * All mandates share a common parentId and source. The entire batch executes
 * inside one outer `stacks.transaction`.
 *
 * Permission: `'create-mandate'` (D9).
 * callableBy: `['anima']` (D21).
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { ReckonerApi, PetitionExtRequest } from '@shardworks/reckoner-apparatus';

const prioritySchema = z.object({
  visionRelation: z.enum(['vision-blocker', 'vision-violator', 'vision-advancer', 'vision-neutral'] as const).optional(),
  severity:       z.enum(['critical', 'serious', 'moderate', 'minor'] as const).optional(),
  scope:          z.enum(['whole-product', 'major-area', 'minor-area'] as const).optional(),
  // Both decay and deadline required when time is present (matches Priority.time shape).
  time: z.object({
    decay:    z.boolean(),
    deadline: z.string().nullable(),
  }).optional(),
  domain: z.array(z.enum([
    'security', 'compliance', 'cost', 'feature', 'quality',
    'infrastructure', 'documentation', 'research', 'ergonomics',
  ] as const)).optional(),
}).optional();

const mandateItemSchema = z.object({
  title:      z.string().describe('Short title for this mandate'),
  body:       z.string().describe('Brief content — instructions to the implementer rig'),
  codex:      z.string().optional().describe("Target codex (defaults to parent's codex)"),
  priority:   prioritySchema.describe('Optional Reckoner priority overrides for this mandate'),
  complexity: z.enum(['mechanical', 'bounded', 'exploratory', 'open-ended']).optional()
    .describe('Optional complexity hint'),
  payload:    z.unknown().optional().describe('Opaque petitioner-defined payload'),
  labels:     z.record(z.string(), z.string()).optional().describe('Additive metadata labels'),
});

export default tool({
  name: 'surveyor-create-mandates',
  description: 'Batch-create mandates and petition them to the Reckoner (surveyor rig tool)',
  instructions:
    'Creates multiple mandates under a single parent in one atomic transaction. ' +
    'All items share the same parentId and source. Returns an array of created WritDoc objects.',
  params: {
    parentId: z.string().describe('Parent charge or piece id all mandates belong to'),
    source:   z.string().describe('Reckoner source id for all mandates (e.g. "scaffold-surveyor.survey-charge")'),
    mandates: z.array(mandateItemSchema).min(1).describe('Array of mandate definitions to create'),
  },
  permission: 'create-mandate',
  callableBy: ['anima'],
  handler: async (params) => {
    const clerk    = guild().apparatus<ClerkApi>('clerk');
    const reckoner = guild().apparatus<ReckonerApi>('reckoner');
    const stacks   = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const results = [];
      for (const item of params.mandates) {
        const writ = await clerk.post({
          type:     'mandate',
          title:    item.title,
          body:     item.body,
          parentId: params.parentId,
          ...(item.codex !== undefined ? { codex: item.codex } : {}),
        });

        const extRequest: PetitionExtRequest = {
          source: params.source,
          ...(item.priority !== undefined ? { priority: item.priority } : {}),
          ...(item.complexity !== undefined ? { complexity: item.complexity } : {}),
          ...(item.payload !== undefined ? { payload: item.payload } : {}),
          ...(item.labels !== undefined ? { labels: item.labels } : {}),
        };

        await reckoner.petition(writ.id, extRequest);
        results.push(writ);
      }
      return results;
    });
  },
});
