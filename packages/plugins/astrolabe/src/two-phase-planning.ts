/**
 * Two-phase planning rig template.
 *
 * Merges the reader and scoping-primer stages into a single
 * `reader-analyst` slot, driven by the astrolabe-owned
 * `astrolabe.reader-analyst` engine. The engine selects between the
 * solo and attended primer variants at run time from live guild config:
 * `sage-primer-attended` when `astrolabe.patronRole` is non-empty,
 * `sage-primer-solo` otherwise. One pass produces inventory, scope,
 * decisions, and observations. Stages: plan-init → draft →
 * reader-analyst → inventory-check → decision-review → spec-writer →
 * spec-publish → observation-lift → seal.
 *
 * The `observation-lift` engine runs after `spec-publish` transitions the
 * plan to `completed` but while the brief writ is still `open` (seal is
 * what transitions the brief). It lifts each record in `plan.observations`
 * into a draft child writ under the brief. The engine internally no-ops on
 * empty or legacy-string observations, so it is wired unconditionally (no
 * `when:` guard).
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
      designId: 'astrolabe.reader-analyst',
      upstream: ['draft'],
      givens: {
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
      id: 'observation-lift',
      designId: 'astrolabe.observation-lift',
      upstream: ['spec-publish'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'seal',
      designId: 'seal',
      upstream: ['observation-lift'],
      givens: { abandon: true },
    },
  ],
  resolutionEngine: 'spec-writer',
};
