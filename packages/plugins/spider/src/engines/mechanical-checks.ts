/**
 * Shared helpers for mechanical build/test checks.
 *
 * Extracted from `review.ts` so both the `review` and `verify` clockwork
 * engines consume the same canonical `runCheck` and `truncate`
 * implementations. The truncation policy (4 KB cap, head-bias on success,
 * tail-bias on failure) is a contract that must stay identical across
 * every engine that runs build/test commands and surfaces their output.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MechanicalCheck } from '../types.ts';

const execFileAsync = promisify(execFile);

/**
 * Truncate to at most `max` chars total (including a short truncation marker),
 * biased toward the **tail** on failure.
 *
 * Failure context (stack traces, exit messages, threshold-check verdicts) is
 * almost always more informative at the end of a build/test run than at the
 * start — the head is dominated by setup logs and individual test PASS lines.
 * For passing checks we keep the head, since long passing logs typically have
 * their useful summary near the top.
 *
 * The truncation marker is budgeted at 64 chars so the returned string is
 * guaranteed `<= max` regardless of how many digits the truncated-count needs.
 */
export function truncate(text: string, max: number, bias: 'head' | 'tail'): string {
  if (text.length <= max) return text;
  const MARKER_BUDGET = 64;
  const sliceLen = Math.max(0, max - MARKER_BUDGET);
  const truncated = text.length - sliceLen;
  if (bias === 'tail') {
    return `[…truncated ${truncated} leading chars]\n${text.slice(-sliceLen)}`;
  }
  return `${text.slice(0, sliceLen)}\n[…truncated ${truncated} trailing chars]`;
}

/**
 * Run a single mechanical check (build or test) shell command in `cwd` and
 * return a structured `MechanicalCheck` result. A non-zero exit produces
 * `passed: false` rather than a thrown error; engines decide what to do
 * with the failed-result list.
 */
export async function runCheck(
  name: 'build' | 'test',
  command: string,
  cwd: string,
): Promise<MechanicalCheck> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd });
    const output = truncate(stdout + stderr, 4096, 'head');
    return { name, passed: true, output, durationMs: Date.now() - start };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    const output = truncate((execErr.stdout ?? '') + (execErr.stderr ?? ''), 4096, 'tail');
    return { name, passed: false, output, durationMs: Date.now() - start };
  }
}
