/**
 * rig-show tool — retrieve a rig by id.
 *
 * Default output is a human-readable CLI rendering that surfaces the
 * per-engine attempt count, hold state (holdReason / holdUntil), and the
 * latest attempt's error (if any) — the minimum bar the commission spec
 * calls for. Pass `--format json` to get the raw RigView (persisted
 * RigDoc plus derived costSummary / engineCosts from ../rig-view.ts).
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type {
  SpiderApi,
  RigView,
  EngineInstance,
  EngineAttempt,
} from '../types.ts';
import { enrichRigView } from '../rig-view.ts';

/** Read the latest attempt (if any) off an engine. */
function latestAttempt(engine: EngineInstance): EngineAttempt | undefined {
  const a = engine.attempts;
  if (!a || a.length === 0) return undefined;
  return a[a.length - 1];
}

/** One-line-per-engine summary for the CLI rendering. */
function renderEngine(engine: EngineInstance): string[] {
  const lines: string[] = [];
  const tail = latestAttempt(engine);
  lines.push(`  ${engine.id} [${engine.designId}] — ${engine.status}`);

  // Attempt counter — authoritative per-commission. Shown only when the
  // engine has tried at least once (a bare pending engine has no
  // attempts to surface). The counter reflects the *retry budget
  // consumed*, not the total attempts; the attempts[] length shows the
  // total for diagnostic purposes.
  const attempts = engine.attempts?.length ?? 0;
  if (attempts > 0 || engine.attemptCount) {
    const consumed = engine.attemptCount ?? 0;
    lines.push(`    attempts: ${attempts} (retry budget consumed: ${consumed})`);
  }

  // Hold state — only meaningful for pending engines.
  if (engine.status === 'pending' && (engine.holdReason || engine.holdUntil)) {
    const parts: string[] = [];
    if (engine.holdReason) parts.push(`reason=${engine.holdReason}`);
    if (engine.holdUntil) parts.push(`until=${engine.holdUntil}`);
    if (engine.lastCheckedAt) parts.push(`lastChecked=${engine.lastCheckedAt}`);
    lines.push(`    hold: ${parts.join(', ')}`);
  }

  // Latest attempt's error — load-bearing for diagnosis.
  if (tail?.error) {
    lines.push(`    last error: ${tail.error}`);
  }

  return lines;
}

/** Render the RigView as a human-readable CLI block. */
function renderRigView(view: RigView): string {
  const lines: string[] = [];
  lines.push(`rig ${view.id}`);
  lines.push(`  writ:   ${view.writId}`);
  lines.push(`  status: ${view.status}`);
  lines.push(`  created: ${view.createdAt}`);
  if (view.terminalAt) lines.push(`  terminalAt: ${view.terminalAt}`);
  if (view.cancelledAt) lines.push(`  cancelledAt: ${view.cancelledAt}`);
  if (view.costSummary) {
    lines.push(
      `  cost: $${view.costSummary.costUsd.toFixed(4)}` +
        (view.costSummary.inputTokens !== undefined
          ? ` (${view.costSummary.inputTokens} input, ${view.costSummary.outputTokens ?? 0} output)`
          : ''),
    );
  }
  lines.push('  engines:');
  for (const engine of view.engines) {
    for (const line of renderEngine(engine)) {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

export default tool({
  name: 'rig-show',
  description: 'Retrieve a rig by id',
  instructions:
    'Returns the full RigDoc for the given rig id, enriched with a derived ' +
    'costSummary and per-engine engineCosts map. Throws if the rig does not exist. ' +
    'Default output is a human-readable rendering that surfaces per-engine ' +
    'attempt count, hold state (holdReason / holdUntil / lastCheckedAt), and ' +
    "the latest attempt's error — the minimum bar the engine-level retry " +
    'commission calls for. Pass --format json for the raw RigView object.',
  params: {
    id: z.string().describe('The rig id to look up.'),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe(
        'Output format. "text" (default) renders a human-readable summary ' +
          'with per-engine attempt count, hold state, and last-attempt error. ' +
          '"json" returns the raw RigView object.',
      ),
  },
  permission: 'read',
  handler: async (params): Promise<RigView | string> => {
    const g = guild();
    const spider = g.apparatus<SpiderApi>('spider');
    const rig = await spider.show(params.id);
    const view = await enrichRigView(rig);
    if (params.format === 'json') {
      return view;
    }
    return renderRigView(view);
  },
});
