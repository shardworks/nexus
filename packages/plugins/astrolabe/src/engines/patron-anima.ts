/**
 * patron-anima clockwork engine.
 *
 * Between `inventory-check` and `decision-review`, consults a configured
 * Patron Anima to pre-fill decisions on behalf of the patron. Any decision
 * the anima can confidently resolve is set on the PlanDoc with its
 * `selected` value — `decision-review` then auto-skips it via the existing
 * "analyst pre-decides → patron-input omitted" semantics.
 *
 * Operational discipline (the tailored work prompt):
 *   The anima runs under a checked-in operational prompt — the static
 *   portions live in `patron-anima-prompt.md` (packaged alongside the
 *   plugin) and are loaded at startup; per-decision content (ids,
 *   questions, options, analyst recommendations) is interpolated in this
 *   module at build time. The prompt encodes the engine's mode discipline,
 *   which is structurally distinct from the anima's taste (which lives in
 *   the role's system prompt):
 *
 *     - One option per decision. `selection` must be one of the offered
 *       option keys — no custom answers, no free-text, no multi-select.
 *     - Principle-structural confidence. `high` = a single principle from
 *       the role fires cleanly; `med` = multiple principles conflict and
 *       the anima resolves the conflict; `low` = no principle speaks,
 *       which is the abstain case.
 *     - Abstain by omission. A decision that would resolve to `low` —
 *       or that the anima cannot confidently resolve at all — is
 *       **absent** from the emission array entirely. There is no
 *       sentinel, no placeholder, no low-confidence confirm fallback.
 *       The engine treats a missing verdict as "unfilled" and flows it
 *       through to `decision-review` in the normal path.
 *     - Out-of-lane prohibition. The draft worktree `cwd` passed to the
 *       anima permits filesystem access, but the prompt explicitly
 *       forbids file reads, grep, codebase audit, and second-guessing
 *       the analyst's framing. The anima's entire input is the role's
 *       principles plus the decisions listed in the prompt.
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
 *     - `confidence` — 'high' | 'med' (`low` means abstain → omit)
 *     - `rationale`  — short free-text note (optional)
 *   Decisions the anima abstains on are absent from the array — the
 *   engine and the parser treat absence as "unfilled, surface to patron."
 *
 * Exhaustiveness:
 *   Single pass. Any decision not carrying a well-formed verdict —
 *   because the anima abstained (omitted it), emitted malformed JSON,
 *   picked an unknown option, or the session failed entirely — is left
 *   unfilled on the PlanDoc and flows to `decision-review` in the
 *   normal flow. The engine does not retry.
 *
 * Defensive parser leniency:
 *   The parser still accepts `confidence: 'low'` as a valid value for
 *   schema-stability reasons — if a stray low-confidence verdict reaches
 *   the engine, it is applied rather than dropped. The operational
 *   prompt instructs the anima to abstain rather than emit `low`, but
 *   the schema and parser do not depend on that instruction being
 *   followed. This is defensive leniency, not a supported emission path.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { AnimatorApi, SessionDoc } from '@shardworks/animator-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import { resolveAstrolabeConfig } from '../astrolabe.ts';
import type { Decision, PatronEmission, PlanDoc } from '../types.ts';

// ── Prompt template ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * The static portion of the patron-anima operational prompt, loaded at module
 * load time from the checked-in markdown file packaged alongside this plugin.
 * The sentinel `{{DECISIONS}}` is replaced by the per-decision listing at
 * prompt-build time. The markdown file lives at the package root so it is
 * reachable via the same relative path from both `src/engines/` (source
 * mode) and `dist/engines/` (published distribution).
 */
const PROMPT_TEMPLATE: string = readFileSync(
  resolve(__dirname, '../../patron-anima-prompt.md'),
  'utf-8',
);

const DECISIONS_PLACEHOLDER = '{{DECISIONS}}';

// ── Helpers ──────────────────────────────────────────────────────────

/** Reviewable = not yet pre-decided by the analyst. Mirrors decision-review. */
function reviewableDecisions(plan: PlanDoc): Decision[] {
  return (plan.decisions ?? []).filter(d => d.selected === undefined);
}

/**
 * Assemble the patron work prompt from the reviewable decisions.
 *
 * The static portion (preamble, mode discipline, out-of-lane prohibition,
 * output contract, worked example) lives in `patron-anima-prompt.md` and is
 * loaded into `PROMPT_TEMPLATE` at module load. This function renders each
 * reviewable decision — question, optional context, options, optional
 * analyst recommendation / rationale — and substitutes the listing into
 * the template's `{{DECISIONS}}` placeholder.
 */
export function buildPatronPrompt(decisions: Decision[]): string {
  const lines: string[] = [];

  for (const decision of decisions) {
    lines.push(`### ${decision.id}: ${decision.question}`);
    if (decision.context) {
      lines.push('');
      lines.push(`Context: ${decision.context}`);
    }
    lines.push('');
    lines.push('Options:');
    for (const [key, label] of Object.entries(decision.options)) {
      lines.push(`- \`${key}\` — ${label}`);
    }
    if (decision.recommendation) {
      lines.push('');
      const recLabel = decision.options[decision.recommendation] ?? decision.recommendation;
      lines.push(
        `Analyst recommendation: \`${decision.recommendation}\` (${recLabel})`,
      );
      if (decision.rationale) {
        lines.push(`Analyst rationale: ${decision.rationale}`);
      }
    } else {
      lines.push('');
      lines.push('Analyst recommendation: (none — you must fill in)');
    }
    lines.push('');
  }

  // Drop the trailing blank line so the substitution sits cleanly in the
  // template's final section.
  const decisionsBlock = lines.join('\n').replace(/\n+$/, '');

  return PROMPT_TEMPLATE.replace(DECISIONS_PLACEHOLDER, decisionsBlock);
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
