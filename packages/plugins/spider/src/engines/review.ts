/**
 * Review engine — quick (Animator-backed).
 *
 * Runs mechanical checks (build/test) synchronously in the draft worktree,
 * then summons a reviewer anima to assess the implementation against the spec.
 * Returns `{ status: 'launched', sessionId }` so the Spider's collect step
 * can call this engine's collect() method on subsequent crawls.
 *
 * Collect method:
 *   - Reads session.output as the reviewer's structured markdown findings
 *   - Parses `passed` from /^###\s*Overall:\s*PASS/mi
 *   - Retrieves mechanicalChecks from session.metadata
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi, SessionDoc } from '@shardworks/animator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields, MechanicalCheck, ReviewYields } from '../types.ts';
import { runCheck } from './mechanical-checks.ts';

const execFileAsync = promisify(execFile);

async function gitDiff(cwd: string, baseSha: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', `${baseSha}..HEAD`], { cwd });
    return stdout;
  } catch {
    return '';
  }
}

async function gitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    return stdout;
  } catch {
    return '';
  }
}

function assembleReviewPrompt(writ: WritDoc, diff: string, status: string, checks: MechanicalCheck[]): string {
  const checksSection = checks.length === 0
    ? '(No mechanical checks configured.)'
    : checks.map((c) => `### ${c.name}: ${c.passed ? 'PASSED' : 'FAILED'}\n\`\`\`\n${c.output}\n\`\`\``).join('\n\n');

  return `# Code Review

You are reviewing work on a commission. Your job is to assess whether the
implementation satisfies the spec, identify any gaps or problems, and produce
a structured findings document.

## The Commission (Spec)

${writ.body}

## Implementation Diff

Changes since the draft was opened:

\`\`\`diff
${diff}
\`\`\`

## Current Worktree State

\`\`\`
${status}
\`\`\`

## Mechanical Check Results

${checksSection}

## Instructions

Assess the implementation against the spec. Produce your findings in this format:

### Overall: PASS or FAIL

### Completeness
- Which spec requirements are addressed?
- Which are missing or partially addressed?

### Correctness
- Are there bugs, logic errors, or regressions?
- Do the tests pass? If not, what fails?

### Quality
- Code style consistent with the codebase?
- Appropriate test coverage for new code?
- Any concerns about the approach?

### Required Changes (if FAIL)
Numbered list of specific changes needed, in priority order.

Produce your findings as your final message in the format above.`;
}

const reviewEngine: EngineDesign = {
  id: 'review',

  // Retry budget — transient session crashes retry in-place. Terminal
  // exhaustion fails the writ directly.
  retry: { maxAttempts: 2 },

  async run(givens, context) {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc;
    const draft = context.upstream['draft'] as DraftYields;

    // 1. Run mechanical checks synchronously before the reviewer session
    const checks: MechanicalCheck[] = [];
    if (givens.buildCommand) {
      checks.push(await runCheck('build', givens.buildCommand as string, draft.path));
    }
    if (givens.testCommand) {
      checks.push(await runCheck('test', givens.testCommand as string, draft.path));
    }

    // 2. Compute diff since draft opened and current worktree state
    const diff = await gitDiff(draft.path, draft.baseSha);
    const status = await gitStatus(draft.path);

    // 3. Assemble review prompt
    const prompt = assembleReviewPrompt(writ, diff, status, checks);

    // 4. Launch reviewer session — stash mechanicalChecks in metadata for collect step
    const handle = animator.summon({
      role: givens.role as string,
      prompt,
      cwd: draft.path,
      metadata: {
        engineId: context.engineId,
        writId: writ.id,
        mechanicalChecks: checks,
      },
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },

  async collect(sessionId: string): Promise<ReviewYields> {
    const stacks = guild().apparatus<StacksApi>('stacks');
    const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
    const session = await sessionsBook.get(sessionId);
    const findings = session?.output ?? '';
    const passed = /^###\s*Overall:\s*PASS/mi.test(findings);
    const mechanicalChecks = (session?.metadata?.mechanicalChecks as MechanicalCheck[]) ?? [];
    return { sessionId, passed, findings, mechanicalChecks };
  },
};

export default reviewEngine;
