/**
 * patron-anima clockwork engine.
 *
 * Between `inventory-check` and `decision-review`, consults a configured
 * Patron Anima to principle-check *every* decision the primer produced.
 * Under attended mode the primer contractually pre-fills `selected` on
 * every decision (so auto-acceptance never silently happens without
 * principle-check); patron-anima then reviews them all and confirms
 * (including `low`-confidence confirms), overrides, fills in, or
 * narrowly abstains.
 *
 * Abstention as absence — decision-review coupling:
 *   When the anima abstains on a decision (by omitting it from the
 *   emission array), `collect()` clears both `Decision.selected` and
 *   `Decision.patronOverride` on that decision. The engine relies on
 *   its consumer — `decision-review` — honouring the invariant that
 *   `selected === undefined` means "the decision still needs patron
 *   attention." Custom rigs that replace or precede `decision-review`
 *   must preserve this contract, or abstentions will silently
 *   auto-accept. `Decision.patron` is deliberately left alone so any
 *   prior verdict from a retry is preserved.
 *
 * Operational discipline (the tailored work prompt):
 *   The anima runs under a checked-in operational prompt — the static
 *   portions live in `patron-anima-prompt.md` (packaged alongside the
 *   plugin) and are loaded at startup; per-decision content (ids,
 *   questions, options, primer recommendations) is interpolated in this
 *   module at build time. The prompt encodes the engine's mode discipline,
 *   which is structurally distinct from the anima's taste (which lives in
 *   the role's system prompt):
 *
 *     - One option per decision. `selection` must be one of the offered
 *       option keys — no custom answers, no free-text, no multi-select.
 *     - Principle-structural confidence. `high` = a single principle from
 *       the role fires cleanly; `med` = multiple principles conflict and
 *       the anima resolves the conflict; `low` = no principle speaks and
 *       the anima confirms the primer's recommendation. `low` is a
 *       first-class emission path, not a placeholder and not reserved for
 *       abstention — principle-absence has the concrete meaning "no
 *       principled basis to differ; confirm the primer."
 *     - Narrow abstention by omission. The anima leaves a decision out of
 *       its emission array only in two cases: *irresolvable principle
 *       conflict* (multiple principles conflict and the anima cannot
 *       resolve without inventing a principle hierarchy the patron has
 *       not articulated) and *broken decision frame* (the question or
 *       options are incoherent as posed, so no valid emission would be
 *       faithful to the patron's intent). Every other case — including
 *       principle-absence — resolves to a first-class emission. The
 *       engine treats a missing verdict as "abstained": `selected` and
 *       `patronOverride` are cleared so `decision-review` surfaces the
 *       decision to the patron.
 *     - Out-of-lane prohibition. The draft worktree `cwd` passed to the
 *       anima permits filesystem access, but the prompt explicitly
 *       forbids file reads, grep, codebase audit, and second-guessing
 *       the primer's framing. The anima's entire input is the role's
 *       principles plus the decisions listed in the prompt.
 *
 * Config:
 *   guild.json["astrolabe"]["patronRole"]
 *     Qualified role name for the Patron Anima (e.g. 'guild.patron').
 *     When unset or empty, this engine no-ops — the pipeline proceeds
 *     exactly as it did before the engine existed. When set, the engine
 *     summons the anima whenever the plan has any decisions.
 *
 * Run → Collect protocol:
 *   run()     → loads the plan; when `patronRole` is set and the plan
 *                has at least one decision, builds a single prompt
 *                covering every decision and launches an anima session
 *                via `animator.summon()`. Returns
 *                `{ status: 'launched', sessionId }`. No-ops (completes
 *                with empty yields) when `patronRole` is unset/empty or
 *                the plan has no decisions.
 *   collect() → reads the session's `output` from Stacks, parses the
 *                emitted JSON verdict array, and for every decision on
 *                the plan either applies the anima's verdict
 *                (`selected` + `patron`, `patronOverride` cleared) or —
 *                if the decision is absent from the emission — clears
 *                `selected` and `patronOverride` so the decision
 *                surfaces to the patron via `decision-review`.
 *
 * Output contract (the anima is asked for):
 *   The session's final message must be a single fenced JSON block
 *   containing an array of verdict objects. Each object:
 *     - `id`         — the decision id
 *     - `verdict`    — 'confirm' | 'override' | 'fill-in'
 *     - `selection`  — one of the decision's offered option keys
 *     - `confidence` — 'high' | 'med' | 'low' (`low` = confirm the
 *                      primer on principle-absence; first-class emission)
 *     - `rationale`  — short free-text note (optional)
 *   Decisions the anima abstains on — the two narrow cases above — are
 *   absent from the array; the engine treats absence as
 *   "surface to patron" by clearing `selected` / `patronOverride`.
 *
 * Exhaustiveness:
 *   Single pass. Any decision not carrying a well-formed verdict —
 *   because the anima abstained (omitted it), emitted malformed JSON,
 *   picked an unknown option, or the session failed entirely — has
 *   `selected` and `patronOverride` cleared on the PlanDoc and flows
 *   to `decision-review` in the normal flow. The engine does not retry.
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
import { resolvePatronRole } from '../astrolabe.ts';
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

/**
 * Assemble the patron work prompt from the plan's decisions.
 *
 * The static portion (preamble, mode discipline, out-of-lane prohibition,
 * output contract, worked example) lives in `patron-anima-prompt.md` and is
 * loaded into `PROMPT_TEMPLATE` at module load. This function renders each
 * decision — question, optional context, options, optional primer
 * recommendation / rationale — and substitutes the listing into the
 * template's `{{DECISIONS}}` placeholder.
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
        `Primer recommendation: \`${decision.recommendation}\` (${recLabel})`,
      );
      if (decision.rationale) {
        lines.push(`Primer rationale: ${decision.rationale}`);
      }
    } else {
      lines.push('');
      lines.push('Primer recommendation: (none — you must fill in)');
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

    // `confirm` must agree with the primer's recommendation. If it doesn't,
    // treat the verdict as malformed — don't silently relabel it. Defends
    // against a model that says "confirm" but picks a different option.
    if (verdict === 'confirm') {
      if (!decision.recommendation || decision.recommendation !== raw.selection) {
        continue;
      }
    }

    // `fill-in` requires there was no primer recommendation.
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
      // proceeds as it does today. The trim-and-check is shared with the
      // astrolabe.reader-analyst engine via `resolvePatronRole`.
      const role = resolvePatronRole();
      if (role === '') {
        return { status: 'completed', yields: {} };
      }

      // Fast-path: no decisions on the plan → no-op. The primer emitted
      // nothing for the anima to weigh in on. (D13: keep this fast-path.)
      const decisions = plan.decisions ?? [];
      if (decisions.length === 0) {
        return { status: 'completed', yields: {} };
      }

      const animator = guild().apparatus<AnimatorApi>('animator');
      const writ = givens.writ as WritDoc | undefined;
      const cwd =
        typeof givens.cwd === 'string' && givens.cwd.length > 0
          ? givens.cwd
          : process.cwd();

      const prompt = buildPatronPrompt(decisions);

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

      const planDecisions = plan.decisions ?? [];
      const emissionsByDecisionId = parseEmission(output, planDecisions);

      // Walk every decision on the plan. Decisions the anima emitted a
      // verdict for are stamped with `selected` + `patron`; decisions the
      // anima abstained on (absent from the emission map) have `selected`
      // and `patronOverride` cleared so decision-review's
      // `selected === undefined` filter surfaces them to the patron.
      // `Decision.patron` is deliberately left alone on abstention
      // (D14 leave-patron).
      const touched: string[] = [];
      const decisions = planDecisions.map(d => ({ ...d }));
      for (const decision of decisions) {
        const emission = emissionsByDecisionId.get(decision.id);
        if (emission) {
          decision.patron = emission;
          decision.selected = emission.selection;
          delete decision.patronOverride;
          touched.push(decision.id);
        } else {
          delete decision.selected;
          delete decision.patronOverride;
        }
      }

      await book.patch(planId, {
        decisions,
        updatedAt: new Date().toISOString(),
      });

      return {
        sessionId,
        touchedDecisionIds: touched,
        totalReviewable: planDecisions.length,
      };
    },
  };
}
