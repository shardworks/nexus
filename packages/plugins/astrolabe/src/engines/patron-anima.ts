/**
 * patron-anima clockwork engine.
 *
 * Between `inventory-check` and `decision-review`, consults a configured
 * Patron Anima to pre-fill decisions on behalf of the patron. Any decision
 * the anima can confidently resolve is set on the PlanDoc with its
 * `selected` value — `decision-review` then auto-skips it via the existing
 * "analyst pre-decides → patron-input omitted" semantics.
 *
 * Config:
 *   guild.json["astrolabe"]["patronRole"]
 *     Qualified role name for the Patron Anima (e.g. 'guild.patron').
 *     When unset or empty, this engine no-ops — the pipeline proceeds
 *     exactly as it did before the engine existed.
 *
 * Run → Collect protocol:
 *   run()     → loads the plan; builds a single prompt covering all
 *                reviewable decisions; launches an anima session via
 *                `animator.summon()`. Returns
 *                `{ status: 'launched', sessionId }`.
 *   collect() → reads the session's `output` from Stacks, parses the
 *                emitted JSON verdict array, applies verdicts to the
 *                PlanDoc, and records each verdict as `Decision.patron`.
 *
 * Output contract (the anima is asked for):
 *   The session's final message must be a single fenced JSON block
 *   containing an array of verdict objects. Each object:
 *     - `id`         — the decision id
 *     - `verdict`    — 'confirm' | 'override' | 'fill-in'
 *     - `selection`  — one of the decision's offered option keys
 *     - `confidence` — 'low' | 'med' | 'high'
 *     - `rationale`  — short free-text note (optional)
 *
 * Exhaustiveness:
 *   Single pass. Any decision not carrying a well-formed verdict —
 *   because the anima omitted it, emitted malformed JSON, picked an
 *   unknown option, or the session failed entirely — is left unfilled
 *   on the PlanDoc and flows to `decision-review` in the normal flow.
 *   The engine does not retry.
 *
 * Self-uncertainty:
 *   A `confirm` at `confidence: 'low'` is the expected encoding for
 *   "anima doesn't know patron well enough on this surface." It still
 *   applies the analyst's recommendation; the high-confirm / low-
 *   confidence signal is the diagnostic substrate for override-rate
 *   × confidence, not an escalation trigger.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { AnimatorApi, SessionDoc } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import { resolveAstrolabeConfig } from '../astrolabe.ts';
import type { Decision, PatronEmission, PlanDoc } from '../types.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/** Reviewable = not yet pre-decided by the analyst. Mirrors decision-review. */
function reviewableDecisions(plan: PlanDoc): Decision[] {
  return (plan.decisions ?? []).filter(d => d.selected === undefined);
}

/**
 * Assemble the patron prompt from the reviewable decisions. Each decision
 * is rendered with its question, optional context, options, and optional
 * analyst recommendation / rationale. The anima is instructed to return a
 * single fenced JSON block with one verdict per decision.
 */
export function buildPatronPrompt(decisions: Decision[]): string {
  const parts: string[] = [
    '# Patron Decision Review',
    '',
    'You are the patron anima. The analyst has surfaced the following',
    'decisions. For each one, emit a structured verdict in the patron\'s',
    'voice so the planning pipeline can proceed without a human block.',
    '',
    '## Decisions',
    '',
  ];

  for (const decision of decisions) {
    parts.push(`### ${decision.id}: ${decision.question}`);
    if (decision.context) {
      parts.push('');
      parts.push(`Context: ${decision.context}`);
    }
    parts.push('');
    parts.push('Options:');
    for (const [key, label] of Object.entries(decision.options)) {
      parts.push(`- \`${key}\` — ${label}`);
    }
    if (decision.recommendation) {
      parts.push('');
      const recLabel = decision.options[decision.recommendation] ?? decision.recommendation;
      parts.push(
        `Analyst recommendation: \`${decision.recommendation}\` (${recLabel})`,
      );
      if (decision.rationale) {
        parts.push(`Analyst rationale: ${decision.rationale}`);
      }
    } else {
      parts.push('');
      parts.push('Analyst recommendation: (none — you must fill in)');
    }
    parts.push('');
  }

  parts.push('## Output contract');
  parts.push('');
  parts.push(
    'Respond with a single fenced JSON block containing an array of',
    'verdict objects — one per decision, keyed by decision id. Do not',
    'emit prose outside the fenced block; anything outside is ignored.',
    '',
    'Each verdict object MUST have these fields:',
    '',
    '- `id`         — the decision id (copy from above)',
    '- `verdict`    — one of `confirm` | `override` | `fill-in`',
    '  - `confirm`  — you accept the analyst\'s recommendation',
    '  - `override` — you pick a different option than the recommendation',
    '  - `fill-in`  — no analyst recommendation existed; you supply one',
    '- `selection`  — the option key you are selecting (MUST be one of the',
    '  offered option keys above — no custom / free-text answers)',
    '- `confidence` — one of `low` | `med` | `high`, calibrated against the',
    '  patron role\'s principles list:',
    '  - `high` — exactly one principle applies cleanly',
    '  - `med`  — multiple principles conflict (note the conflict in rationale)',
    '  - `low`  — no principle applies (default to `confirm` at `low` rather',
    '    than abstaining or improvising — leaving decisions unfilled is the',
    '    fallback path when you genuinely cannot answer)',
    '- `rationale` — short free-text note (≤ 1 sentence) citing which',
    '  principle (or conflict) produced this verdict',
    '',
    'Example:',
    '',
    '```json',
    '[',
    '  { "id": "D1", "verdict": "confirm", "selection": "A", "confidence": "high", "rationale": "Matches simplicity principle." }',
    ']',
    '```',
  );

  return parts.join('\n');
}

/** Extract the last fenced JSON block from an anima's output. Returns null if none. */
export function extractJsonBlock(output: string): string | null {
  // Prefer ```json ... ``` fenced blocks; fall back to plain ``` ... ```.
  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = jsonFence.exec(output)) !== null) {
    last = match[1].trim();
  }
  if (last !== null) return last;
  // Last-ditch: try the output verbatim if it starts with `[` or `{`.
  const trimmed = output.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed;
  return null;
}

export interface RawVerdict {
  id?: unknown;
  verdict?: unknown;
  selection?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

/**
 * Parse the anima's JSON emission into a map keyed by decision id. Invalid
 * entries are dropped silently — the engine treats missing verdicts as
 * "leave the decision unfilled" and relies on `decision-review` to catch
 * them in the normal flow.
 */
export function parseEmission(
  output: string,
  decisions: Decision[],
): Map<string, PatronEmission> {
  const result = new Map<string, PatronEmission>();
  const block = extractJsonBlock(output);
  if (block === null) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return result;
  }

  // Accept either a bare array or an object with an `emissions` / `verdicts`
  // array field — be lenient about the outer shape so small model quirks
  // don't cost a whole round.
  let entries: unknown[];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const maybe = obj.emissions ?? obj.verdicts ?? obj.decisions;
    entries = Array.isArray(maybe) ? maybe : [];
  } else {
    return result;
  }

  const decisionById = new Map(decisions.map(d => [d.id, d]));

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const raw = rawEntry as RawVerdict;
    if (typeof raw.id !== 'string') continue;
    const decision = decisionById.get(raw.id);
    if (!decision) continue;

    const verdict = raw.verdict;
    if (verdict !== 'confirm' && verdict !== 'override' && verdict !== 'fill-in') continue;

    if (typeof raw.selection !== 'string') continue;
    if (!(raw.selection in decision.options)) continue;

    const confidence = raw.confidence;
    if (confidence !== 'low' && confidence !== 'med' && confidence !== 'high') continue;

    // `confirm` must agree with the analyst's recommendation. If it doesn't,
    // treat the verdict as malformed — don't silently relabel it. Defends
    // against a model that says "confirm" but picks a different option.
    if (verdict === 'confirm') {
      if (!decision.recommendation || decision.recommendation !== raw.selection) {
        continue;
      }
    }

    // `fill-in` requires there was no analyst recommendation.
    if (verdict === 'fill-in' && decision.recommendation) {
      // Accept but only if the selection genuinely differs — otherwise
      // relabelling a confirm as fill-in is a model quirk we tolerate.
      // (Either way the `selected` resolution is the same.)
    }

    // `override` requires a recommendation existed and differs from selection.
    if (verdict === 'override') {
      if (!decision.recommendation) continue;
      if (decision.recommendation === raw.selection) continue;
    }

    const emission: PatronEmission = {
      verdict,
      selection: raw.selection,
      confidence,
    };
    if (typeof raw.rationale === 'string' && raw.rationale.length > 0) {
      emission.rationale = raw.rationale;
    }
    result.set(decision.id, emission);
  }

  return result;
}

// ── Engine factory ───────────────────────────────────────────────────

export function createPatronAnimaEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.patron-anima',

    async run(
      givens: Record<string, unknown>,
      context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const planId = givens.planId;
      if (typeof planId !== 'string' || planId.length === 0) {
        throw new Error('patron-anima engine requires a non-empty string "planId" given.');
      }

      const book = getPlansBook();
      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      // Skip-when-unset: no configured patron → no-op, decision-review
      // proceeds as it does today.
      const config = resolveAstrolabeConfig();
      const role = typeof config.patronRole === 'string' ? config.patronRole.trim() : '';
      if (role.length === 0) {
        return { status: 'completed', yields: {} };
      }

      // Fast-path: nothing is reviewable → no-op. The analyst has already
      // pre-decided everything; there's nothing for the anima to weigh in on.
      const reviewable = reviewableDecisions(plan);
      if (reviewable.length === 0) {
        return { status: 'completed', yields: {} };
      }

      const animator = guild().apparatus<AnimatorApi>('animator');
      const writ = givens.writ as WritDoc | undefined;
      const cwd =
        typeof givens.cwd === 'string' && givens.cwd.length > 0
          ? givens.cwd
          : process.cwd();

      const prompt = buildPatronPrompt(reviewable);

      const handle = animator.summon({
        role,
        prompt,
        cwd,
        environment: writ ? { GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local` } : {},
        metadata: {
          engineId: context.engineId,
          planId,
          ...(writ ? { writId: writ.id } : {}),
        },
      });

      return { status: 'launched', sessionId: handle.sessionId };
    },

    async collect(
      sessionId: string,
      givens: Record<string, unknown>,
      _context: EngineRunContext,
    ): Promise<unknown> {
      const planId = givens.planId;
      if (typeof planId !== 'string' || planId.length === 0) {
        throw new Error('patron-anima collect requires a non-empty string "planId" given.');
      }

      const book = getPlansBook();
      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      const stacks = guild().apparatus<StacksApi>('stacks');
      const sessionsBook = stacks.readBook<SessionDoc>('animator', 'sessions');
      const session = await sessionsBook.get(sessionId);
      const output = session?.output ?? '';

      const reviewable = reviewableDecisions(plan);
      const emissionsByDecisionId = parseEmission(output, reviewable);

      // Apply verdicts to each touched decision. Untouched decisions are
      // left unfilled — decision-review will surface them to the human.
      const touched: string[] = [];
      const decisions = (plan.decisions ?? []).map(d => ({ ...d }));
      for (const decision of decisions) {
        const emission = emissionsByDecisionId.get(decision.id);
        if (!emission) continue;
        decision.patron = emission;
        decision.selected = emission.selection;
        delete decision.patronOverride;
        touched.push(decision.id);
      }

      await book.patch(planId, {
        decisions,
        updatedAt: new Date().toISOString(),
      });

      return {
        sessionId,
        touchedDecisionIds: touched,
        totalReviewable: reviewable.length,
      };
    },
  };
}
