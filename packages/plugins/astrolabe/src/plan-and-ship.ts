/**
 * Plan-and-ship rig template (`astrolabe.plan-and-ship`).
 *
 * Combined planning + implementation rig. Carries a single brief writ
 * through the full pipeline — plan, decision review, spec drafting,
 * implementation, review, revise, seal — without posting an intermediate
 * mandate writ. The brief writ itself reaches `completed` only after the
 * implementation seal succeeds, which restores correct blocked_by
 * dependency gating for downstream writs.
 *
 * Stages: plan-init → draft → reader-analyst → inventory-check →
 *         decision-review → spec-writer → plan-finalize → implement →
 *         review → revise → seal.
 *
 * The `draft` engine is shared across both phases (D6 in the commission
 * spec): every downstream engine reads the same `upstream['draft']`
 * worktree. The `seal` engine runs without `abandon: true` — the seal is
 * real. `implement.givens.prompt` is wired to `${yields.plan-finalize.spec}`
 * so the implementing anima works from the planning spec instead of the
 * brief's raw body (the old path through spec-publish posting a mandate is
 * not used here).
 */

import type { RigTemplate } from '@shardworks/spider-apparatus';

export const planAndShipRigTemplate: RigTemplate = {
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
      id: 'plan-finalize',
      designId: 'astrolabe.plan-finalize',
      upstream: ['spec-writer'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'implement',
      designId: 'implement',
      upstream: ['plan-finalize'],
      givens: {
        writ: '${writ}',
        role: '${vars.role}',
        prompt: '${yields.plan-finalize.spec}',
      },
    },
    {
      id: 'review',
      designId: 'review',
      upstream: ['implement'],
      givens: {
        writ: '${writ}',
        role: 'reviewer',
        buildCommand: '${vars.buildCommand}',
        testCommand: '${vars.testCommand}',
      },
    },
    {
      id: 'revise',
      designId: 'revise',
      upstream: ['review'],
      givens: { writ: '${writ}', role: '${vars.role}' },
    },
    {
      id: 'seal',
      designId: 'seal',
      upstream: ['revise'],
      givens: {},
    },
  ],
  resolutionEngine: 'seal',
};
