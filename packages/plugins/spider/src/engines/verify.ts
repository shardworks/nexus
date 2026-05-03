/**
 * Verify engine — clockwork.
 *
 * Mechanical post-revise gate. Re-runs the same `buildCommand` /
 * `testCommand` checks the `review` engine performs, but inserted
 * between `revise` and `seal` in the plugin-default rig template — its
 * purpose is to surface any regression introduced during revise (build
 * break, test failure, undone fix) loud and clear, before the seal
 * engine fast-forward-merges the draft branch into the codex.
 *
 * No anima session, no model cost, no `collect()`: verify is fully
 * synchronous and deterministic. Both checks always run regardless of
 * the build's outcome (no short-circuit), so an operator inspecting a
 * failure sees the full state, not just the first thing that broke.
 *
 * Failure semantics. On any non-zero exit the engine throws. The
 * standard engine-failure path takes over: `attempts[-1].status='failed'`
 * with the thrown message captured as `error`, the rig cancels every
 * non-terminal engine (so `seal` never runs), `rig.status='failed'`,
 * and the rig→writs CDC translates that to `writ.phase='failed'`.
 * Operators inspect the embedded check outputs in
 * `attempts[-1].error` (Oculus and `rig-show` render it directly).
 *
 * No retry, no graft, no recovery tail: a deterministic regression is
 * the human-intervention signal verify exists to surface.
 *
 * Configuration. Reuses `${vars.buildCommand}` and `${vars.testCommand}`
 * from `spider.variables`; no new SpiderConfig key. If both givens are
 * absent the engine throws a configuration error — a totally-vacuous
 * verify silently passing seal would defeat the whole gate. If only one
 * is absent, verify runs the present check and completes normally
 * (matches review's silent-skip behaviour for partial config).
 */

import type { EngineDesign } from '@shardworks/fabricator-apparatus';
import type { DraftYields, MechanicalCheck, VerifyYields } from '../types.ts';
import { runCheck } from './mechanical-checks.ts';

/**
 * Format the per-check section embedded in the thrown-error message on
 * the failure path. `attempts[-1].error` is the only post-throw channel
 * the substrate preserves, so the entire diagnostic surface — one-line
 * summary + per-check truncated outputs — has to live in the message.
 */
function formatFailureMessage(checks: MechanicalCheck[]): string {
  const summary = checks
    .map((c) => `${c.name} ${c.passed ? 'PASSED' : 'FAILED'}`)
    .join(', ');
  const sections = checks
    .map((c) => {
      const verdict = c.passed ? 'PASSED' : 'FAILED';
      return `### ${c.name}: ${verdict} (${c.durationMs}ms)\n\`\`\`\n${c.output}\n\`\`\``;
    })
    .join('\n\n');
  return `Verify failed: ${summary}.\n\n${sections}`;
}

const verifyEngine: EngineDesign = {
  id: 'verify',

  // No retry. Build/test regressions are deterministic; retrying masks
  // the very signal verify exists to surface. (Aligns with peer
  // clockwork engines like seal and draft, which also omit `retry`.)

  async run(givens, context) {
    const draft = context.upstream['draft'] as DraftYields | undefined;
    if (!draft) {
      throw new Error(
        'Verify engine requires draft yields in context.upstream but none found.',
      );
    }

    const buildCommand = givens.buildCommand as string | undefined;
    const testCommand = givens.testCommand as string | undefined;

    // D11 — refuse to be a totally-vacuous gate. If both checks are
    // missing the engine cannot do its job; failing loud at config time
    // is strictly better than silently passing seal.
    if (!buildCommand && !testCommand) {
      throw new Error(
        'Verify engine requires at least one of `spider.variables.buildCommand` or `spider.variables.testCommand` to be configured. Both are missing — a verify gate with no checks cannot perform its job.',
      );
    }

    // D6 — always run both checks (when configured). No short-circuit:
    // an operator inspecting a verify failure wants the full state.
    const checks: MechanicalCheck[] = [];
    if (buildCommand) {
      checks.push(await runCheck('build', buildCommand, draft.path));
    }
    if (testCommand) {
      checks.push(await runCheck('test', testCommand, draft.path));
    }

    const anyFailed = checks.some((c) => !c.passed);
    if (anyFailed) {
      throw new Error(formatFailureMessage(checks));
    }

    const yields: VerifyYields = { checks };
    return { status: 'completed', yields };
  },
};

export default verifyEngine;
