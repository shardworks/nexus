/**
 * surveyor-create-mandate — single-mandate creation tool for surveyor rigs.
 *
 * D20: Uses `clerk.post({ type: 'mandate', ... })` then `reckoner.petition(writId, ext)`
 * stamp-only form, wrapped in one outer `stacks.transaction`. Mandates skip
 * `ext['surveyor']` (mandates are not cartograph types and aren't surveyed).
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

export default tool({
  name: 'surveyor-create-mandate',
  description: 'Create a single mandate and petition it to the Reckoner (surveyor rig tool)',
  instructions:
    'Creates a mandate writ and immediately stamps it with ext["reckoner"] via the ' +
    'Reckoner petition stamp-only form, inside one atomic transaction. ' +
    'The `source` field is required and must be the surveyor\'s petition source id ' +
    '(e.g. "scaffold-surveyor.survey-charge"). ' +
    'Use surveyor-create-mandates for batch creation.',
  params: {
    parentId:   z.string().describe('Parent charge or piece id'),
    title:      z.string().describe('Short human-readable title for the mandate'),
    body:       z.string().describe('Brief content — instructions to the implementer rig'),
    codex:      z.string().optional().describe("Target codex (defaults to parent's codex)"),
    source:     z.string().describe('Reckoner source id for this mandate (e.g. "scaffold-surveyor.survey-charge")'),
    priority:   prioritySchema.describe('Optional Reckoner priority overrides'),
    complexity: z.enum(['mechanical', 'bounded', 'exploratory', 'open-ended']).optional()
      .describe('Optional complexity hint'),
    payload:    z.unknown().optional().describe('Opaque petitioner-defined payload'),
    labels:     z.record(z.string(), z.string()).optional().describe('Additive metadata labels'),
  },
  permission: 'create-mandate',
  callableBy: ['anima'],
  handler: async (params) => {
    const clerk    = guild().apparatus<ClerkApi>('clerk');
    const reckoner = guild().apparatus<ReckonerApi>('reckoner');
    const stacks   = guild().apparatus<StacksApi>('stacks');

    return stacks.transaction(async () => {
      const writ = await clerk.post({
        type:     'mandate',
        title:    params.title,
        body:     params.body,
        parentId: params.parentId,
        ...(params.codex !== undefined ? { codex: params.codex } : {}),
      });

      const extRequest: PetitionExtRequest = {
        source: params.source,
        ...(params.priority !== undefined ? { priority: params.priority } : {}),
        ...(params.complexity !== undefined ? { complexity: params.complexity } : {}),
        ...(params.payload !== undefined ? { payload: params.payload } : {}),
        ...(params.labels !== undefined ? { labels: params.labels } : {}),
      };

      await reckoner.petition(writ.id, extRequest);
      return writ;
    });
  },
});
