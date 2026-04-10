/**
 * planning-ssr — Single-Shot Reader experimental rig template.
 *
 * Identical stage pipeline to `planning` (plan-init → draft → reader →
 * inventory-check → analyst → decision-review → spec-writer → spec-publish
 * → seal) with only the `reader` engine's prompt changed.
 *
 * The hypothesis: reader can produce the codebase inventory in 1–2 turns
 * (max 3) instead of ~25, cutting reader cost by ~10–20×.
 *
 * The prompt instructs the agent to:
 *  1. Batch all initial orientation (Glob/Read) into a single parallel
 *     tool-call round.
 *  2. Produce and write the full inventory via inventory-write immediately
 *     after that orientation round.
 *  3. Use at most one optional follow-up turn for targeted clarification
 *     before finalizing.
 *
 * Engine ID remains 'reader' so profiling sessions are directly comparable
 * between control (planning) and experiment (planning-ssr).
 */

import type { RigTemplate } from '@shardworks/spider-apparatus';

// ── Single-shot reader prompt ───────────────────────────────────────

const singleShotReaderPrompt = `MODE: READER

Plan ID: \${yields.plan-init.planId}

You are beginning a new planning session. Your goal is to produce a complete codebase inventory in a SINGLE response — do not explore iteratively turn-by-turn.

## Process

1. **Orientation (this turn).** Call plan-show to read the plan, then immediately issue a BATCH of parallel tool calls to orient yourself:
   - Use Glob to discover the full directory tree and file layout relevant to the brief.
   - Use Read to load key files you can identify from the plan's codex and brief description (entry points, types, tests, config, README).
   - Use Grep to locate symbols, patterns, or conventions mentioned in the brief.
   Issue ALL of these tool calls together in a single parallel batch — do not wait for results before issuing more reads.

2. **Inventory (this turn or next).** Once you have the orientation results, produce the complete structured inventory and write it using inventory-write. The inventory must contain:
   - **Affected code:** every file that will likely be created, modified, or deleted; every type/interface involved (copy actual signatures); every function that will change; every test file for affected code.
   - **Adjacent patterns:** how sibling features handle the same problem (2-3 comparable implementations if they exist); codebase conventions for this kind of change.
   - **Existing context:** scratch notes, TODOs, prior commissions, known-gaps entries.
   - **Doc/code discrepancies:** places where docs describe different behavior than code implements.

   This is a working document — rough, exhaustive, and unpolished. Value completeness over formatting.

3. **Optional clarification (at most 1 follow-up turn).** If and only if the orientation round reveals that critical files were missed — files you now know exist but did not read — you may issue ONE more batch of targeted reads, then immediately update the inventory via inventory-write.

## Constraints

- **Maximum 3 turns total** (orientation + inventory + optional clarification). You MUST write the inventory and exit within this budget.
- **Parallel tool calls.** Always batch your Read/Glob/Grep calls into a single parallel request. Never issue them one-at-a-time across turns.
- **No analysis.** You read and record. You do not analyze, design, or make decisions.
- **Write early.** If in doubt whether you need a clarification turn, write the inventory with what you have. An imperfect inventory written in 2 turns is better than a perfect one written in 25.`;

// ── Template ────────────────────────────────────────────────────────

export const planningSsrTemplate: RigTemplate = {
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
        role: 'astrolabe.sage',
        prompt: singleShotReaderPrompt,
        cwd: '${yields.draft.path}',
        writ: '${writ}',
      },
    },
    {
      id: 'inventory-check',
      designId: 'astrolabe.inventory-check',
      upstream: ['reader'],
      givens: {
        planId: '${yields.plan-init.planId}',
      },
    },
    {
      id: 'analyst',
      designId: 'anima-session',
      upstream: ['inventory-check'],
      givens: {
        role: 'astrolabe.sage',
        prompt:
          'MODE: ANALYST\n\nPlan ID: ${yields.plan-init.planId}\n\n' +
          'You are continuing the reader conversation. Use plan-show to read the current ' +
          'plan state, then produce scope, decisions, and observations using the write tools.',
        cwd: '${yields.draft.path}',
        conversationId: '${yields.reader.conversationId}',
        writ: '${writ}',
      },
    },
    {
      id: 'decision-review',
      designId: 'astrolabe.decision-review',
      upstream: ['analyst'],
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
          'You are continuing the analyst conversation. Use plan-show to read the full ' +
          'plan including patron-reviewed decisions, then write the specification using spec-write.' +
          '\n\nDecision summary:\n${yields.decision-review.decisionSummary}',
        cwd: '${yields.draft.path}',
        conversationId: '${yields.analyst.conversationId}',
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
