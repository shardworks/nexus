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
 *         patron-anima → decision-review → spec-writer → plan-finalize →
 *         observation-lift → implement → review → revise → seal.
 *
 * The `observation-lift` engine runs after `plan-finalize` has transitioned
 * the plan to `completed` but while the brief writ itself is still `open`.
 * It lifts each record in `plan.observations` into a draft child writ under
 * the brief, so a curator (human or overseer) can promote it later. The
 * engine internally no-ops on empty or legacy-string observations, so it is
 * wired unconditionally (no `when:` guard).
 *
 * The `reader-analyst` slot uses the astrolabe-owned
 * `astrolabe.reader-analyst` engine, which selects the primer role at
 * engine-run time from live guild config: `sage-primer-attended` when
 * `astrolabe.patronRole` is non-empty (every decision gets pre-filled so
 * the downstream patron-anima principle-checks them all), `sage-primer-
 * solo` otherwise (the primer carries the razor itself and only leaves
 * razor-matched decisions unset for the patron).
 *
 * `patron-anima` consults a configured Patron Anima to pre-fill or
 * confirm decisions on behalf of the patron. When `astrolabe.patronRole`
 * is unset or empty, the engine no-ops and `decision-review` proceeds as
 * it did before the engine existed. The `cwd` given is the shared draft
 * worktree so the anima can inspect the codebase if its role instructions
 * allow it.
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
      id: 'patron-anima',
      designId: 'astrolabe.patron-anima',
      upstream: ['inventory-check'],
      givens: {
        planId: '${yields.plan-init.planId}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
      },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['patron-anima'],
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
      id: 'observation-lift',
      designId: 'astrolabe.observation-lift',
      upstream: ['plan-finalize'],
      givens: { planId: '${yields.plan-init.planId}' },
    },
    {
      id: 'implement',
      designId: 'implement',
      upstream: ['observation-lift'],
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
