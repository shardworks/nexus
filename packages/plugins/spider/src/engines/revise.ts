/**
 * Revise engine — quick (Animator-backed).
 *
 * Summons an anima to address review findings. If the review passed, the
 * prompt instructs the anima to confirm and exit without unnecessary changes.
 * If the review failed, the prompt directs the anima to address each item
 * in the findings and commit the result.
 *
 * Returns `{ status: 'launched', sessionId }` so the Spider's collect step
 * can store ReviseYields on completion.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { guild } from '@shardworks/nexus-core';
import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { AnimatorApi } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { DraftYields, ReviewYields } from '../types.ts';

const execFileAsync = promisify(execFile);

async function gitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    return stdout;
  } catch {
    return '';
  }
}

async function gitDiffUncommitted(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], { cwd });
    return stdout;
  } catch {
    return '';
  }
}

function assembleRevisionPrompt(writ: WritDoc, review: ReviewYields, status: string, diff: string): string {
  const reviewResult = review.passed ? 'PASS' : 'FAIL';
  const instructions = review.passed
    ? `The review passed. No changes are required. Confirm the work looks correct\nand exit. Do not make unnecessary changes or spend unnecessary time reassessing.`
    : `The review identified issues that need to be addressed. See "Required Changes"\nin the findings above. Address each item, then commit your changes.`;

  const diffSection = diff.trim()
    ? `\`\`\`diff\n${diff}\n\`\`\``
    : '(No uncommitted changes.)';

  return `# Revision Pass

You are revising prior work on a commission based on review findings.

## The Commission (Spec)

${writ.body}

## Review Findings

${review.findings}

## Review Result: ${reviewResult}

${instructions}

## Current State

\`\`\`
${status}
\`\`\`

${diffSection}

Commit all changes before ending your session.`;
}

const reviseEngine: EngineDesign = {
  id: 'revise',

  // Retry budget — transient session crashes retry in-place. Terminal
  // exhaustion fails the writ directly.
  retry: { maxAttempts: 2 },

  async run(givens, context) {
    const animator = guild().apparatus<AnimatorApi>('animator');
    const writ = givens.writ as WritDoc;
    const draft = context.upstream['draft'] as DraftYields;
    const review = context.upstream['review'] as ReviewYields;

    const status = await gitStatus(draft.path);
    const diff = await gitDiffUncommitted(draft.path);
    const prompt = assembleRevisionPrompt(writ, review, status, diff);

    const handle = animator.summon({
      role: givens.role as string,
      prompt,
      cwd: draft.path,
      environment: { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` },
      metadata: { engineId: context.engineId, writId: writ.id },
    });

    return { status: 'launched', sessionId: handle.sessionId };
  },
};

export default reviseEngine;
