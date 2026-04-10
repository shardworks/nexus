/**
 * planning-mra — Merged Reader/Analyst experimental rig template.
 *
 * Collapses the separate `reader` and `analyst` anima-session stages into a
 * single `reader-analyst` stage that produces inventory, scope, decisions, and
 * observations in one session. All other stages (plan-init, draft,
 * inventory-check, decision-review, spec-writer, spec-publish, seal) are
 * unchanged from the production `planning` template.
 *
 * Hypothesis: merging reader and analyst into a single session cuts total
 * astrolabe cost by ~50% without quality loss, because profiling shows the two
 * stages do substantially overlapping codebase navigation work.
 *
 * Writ type: `brief-mra` → `astrolabe.planning-mra`.
 * See: experiments/data/2026-04-10-astrolabe-profile.md (Intervention B).
 */

import type { RigTemplate } from '@shardworks/spider-apparatus';

// ── Combined reader-analyst prompt ──────────────────────────────────

const readerAnalystPrompt =
  'MODE: READER-ANALYST\n\n' +
  'Plan ID: ${yields.plan-init.planId}\n\n' +
  'You are performing a combined read-and-analyze pass in a single session. ' +
  'Your goal is to inventory the relevant codebase AND produce scope, ' +
  'decisions, and observations — all in one pass.\n\n' +
  '## Process\n\n' +
  '1. Call `plan-show` with your planId to read the plan and understand the brief.\n' +
  '2. Read the codebase — but let your growing understanding of the change guide ' +
  'which files you read. You do not need to do a full repo walk followed by a ' +
  'separate analysis turn. As you read, you will naturally form scope boundaries, ' +
  'identify decision points, and notice observations. Let that understanding ' +
  'steer your exploration.\n' +
  '3. Write the codebase inventory using `inventory-write`. The inventory must ' +
  'meet the same quality bar as a dedicated reader: affected files, types, ' +
  'interfaces, functions, test files, adjacent patterns, conventions, existing ' +
  'context, and doc/code discrepancies. Be exhaustive for directly affected ' +
  'code; capture key observations for adjacent code.\n' +
  '4. Write scope items using `scope-write`. Break the brief into coarse, ' +
  'independently deliverable capabilities. Each item should be something the ' +
  'patron might include or exclude.\n' +
  '5. Write decisions using `decisions-write`. Be exhaustive — capture every ' +
  'design question including ones where the answer seems obvious from codebase ' +
  'conventions. Each decision needs: id, scope references, question, context, ' +
  'options, recommendation, rationale, selected (pre-fill with recommendation), ' +
  'and analysis metadata (category, observable, confidence, stakes).\n' +
  '6. Write observations using `observations-write`. Record refactoring ' +
  'opportunities, risks, suboptimal conventions, doc/code discrepancies, and ' +
  'potential bugs noticed during your pass.\n\n' +
  'You may interleave reading and writing — for example, write partial inventory ' +
  'as you go and refine it, or write scope items as they become clear and adjust ' +
  'later. The key constraint is that when you finish, all four artifacts ' +
  '(inventory, scope, decisions, observations) must be complete and written ' +
  'to the plan via the write tools.\n\n' +
  'The same quality bar applies as for dedicated reader and analyst stages. ' +
  'The difference is efficiency: you are doing both jobs in one session, ' +
  'avoiding redundant codebase navigation.';

// ── Template ────────────────────────────────────────────────────────

export const planningMraTemplate: RigTemplate = {
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
        role: 'astrolabe.sage',
        prompt: readerAnalystPrompt,
        cwd: '${yields.draft.path}',
        writ: '${writ}',
        metadata: { engineId: 'reader-analyst' },
      },
    },
    {
      id: 'inventory-check',
      designId: 'astrolabe.inventory-check',
      upstream: ['reader-analyst'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['inventory-check'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'spec-writer',
      designId: 'anima-session',
      upstream: ['decision-review'],
      givens: {
        role: 'astrolabe.sage',
        prompt:
          'MODE: WRITER\n\nPlan ID: ${yields.plan-init.planId}\n\n' +
          'You are beginning a new conversation. Use plan-show to read the full ' +
          'plan including patron-reviewed decisions, then write the specification using spec-write.' +
          '\n\nDecision summary:\n${yields.decision-review.decisionSummary}',
        cwd: '${yields.draft.path}',
        writ: '${writ}',
      },
    },
    {
      id: 'spec-publish',
      designId: 'astrolabe.spec-publish',
      upstream: ['spec-writer'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
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
