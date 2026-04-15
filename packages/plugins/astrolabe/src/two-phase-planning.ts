/**
 * Two-phase planning rig template.
 *
 * Merges the reader and analyst stages into a single `reader-analyst`
 * anima-session, producing inventory, scope, decisions, and observations
 * in one pass. Stages: plan-init → draft → reader-analyst →
 * inventory-check → decision-review → spec-writer → spec-publish → seal.
 */

import type { RigTemplate } from '@shardworks/spider-apparatus';

export const twoPhaseRigTemplate: RigTemplate = {
  engines: [
    {
      id: 'plan-init',
      designId: 'astrolabe.plan-init',
      upstream: [],
      givens: { writ: '${writ}' },
    },
    {
      id: 'draft',
      designId: 'draft',
      upstream: ['plan-init'],
      givens: { writ: '${writ}' },
    },
    {
      id: 'reader-analyst',
      designId: 'anima-session',
      upstream: ['draft'],
      givens: {
        role: 'astrolabe.sage-reading-analyst',
        prompt: 'Plan ID: ${yields.plan-init.planId}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
        metadata: { engineId: 'reader-analyst' },
      },
    },
    {
      id: 'inventory-check',
      designId: 'astrolabe.inventory-check',
      upstream: ['reader-analyst'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['inventory-check'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'spec-writer',
      designId: 'anima-session',
      upstream: ['decision-review'],
      givens: {
        role: 'astrolabe.sage-writer',
        prompt:
          'Plan ID: ${yields.plan-init.planId}\n\n' +
          'Decision summary:\n${yields.decision-review.decisionSummary}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
        metadata: { engineId: 'spec-writer' },
      },
    },
    {
      id: 'spec-publish',
      designId: 'astrolabe.spec-publish',
      upstream: ['spec-writer'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'seal',
      designId: 'seal',
      upstream: ['spec-publish'],
      givens: { abandon: true },
    },
  ],
  resolutionEngine: 'spec-writer',
};
