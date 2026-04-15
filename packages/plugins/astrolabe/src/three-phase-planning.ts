/**
 * Three-phase planning rig template.
 *
 * Separates reading and analysis into distinct anima-session stages:
 * reader (inventory) and analyst (scope, decisions, observations).
 * Stages: plan-init → draft → reader → inventory-check → analyst →
 * decision-review → spec-writer → spec-publish → seal.
 */

import type { RigTemplate } from '@shardworks/spider-apparatus';

export const threePhaseRigTemplate: RigTemplate = {
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
      id: 'reader',
      designId: 'anima-session',
      upstream: ['draft'],
      givens: {
        role: 'astrolabe.sage-reader',
        prompt: 'Plan ID: ${yields.plan-init.planId}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
        metadata: { engineId: 'reader' },
      },
    },
    {
      id: 'inventory-check',
      designId: 'astrolabe.inventory-check',
      upstream: ['reader'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'analyst',
      designId: 'anima-session',
      upstream: ['inventory-check'],
      givens: {
        role: 'astrolabe.sage-analyst',
        prompt: 'Plan ID: ${yields.plan-init.planId}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
        metadata: { engineId: 'analyst' },
      },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['analyst'],
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
