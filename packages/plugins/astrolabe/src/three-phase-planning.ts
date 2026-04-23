/**
 * Three-phase planning rig template.
 *
 * Separates reading and scoping into distinct anima-session stages:
 * the `reader` primer (inventory) and the `analyst` primer (scope,
 * decisions, observations). The `analyst` slot id is preserved for
 * backward compatibility with downstream yield references even though
 * the role it summons is now `sage-primer-scoping`.
 * Stages: plan-init → draft → reader → inventory-check → analyst →
 * decision-review → spec-writer → spec-publish → observation-lift → seal.
 *
 * The `observation-lift` engine runs after `spec-publish` transitions the
 * plan to `completed` but while the brief writ is still `open` (seal is
 * what transitions the brief). It lifts each record in `plan.observations`
 * into a draft child writ under the brief. The engine internally no-ops on
 * empty or legacy-string observations, so it is wired unconditionally (no
 * `when:` guard).
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
        role: 'astrolabe.sage-primer-reader',
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
        role: 'astrolabe.sage-primer-scoping',
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
