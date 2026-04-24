/**
 * decision-review clockwork engine.
 *
 * Two-pass engine:
 *
 * First run (plan status 'analyzing'):
 *   - Maps decisions to ChoiceQuestionSpec and scope items to BooleanQuestionSpec.
 *   - Creates an InputRequestDoc in spider/input-requests.
 *   - Blocks with 'patron-input' block type.
 *   - If no decisions and no scope items, completes immediately.
 *
 * Re-run (plan status 'reviewing'):
 *   - Reads the completed InputRequestDoc.
 *   - Reconciles answers back into the PlanDoc.
 *   - Yields a human-readable decisionSummary markdown string.
 */

import { guild, generateId } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type {
  InputRequestDoc,
  ChoiceQuestionSpec,
  BooleanQuestionSpec,
  AnswerValue,
  ChoiceAnswer,
} from '@shardworks/spider-apparatus';
import type { PlanDoc, Decision, ScopeItem } from '../types.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function composeDetails(context?: string, rationale?: string): string | undefined {
  if (context && rationale) {
    return `${context}\n\nRecommendation rationale: ${rationale}`;
  }
  if (context) return context;
  if (rationale) return `Recommendation rationale: ${rationale}`;
  return undefined;
}

function buildDecisionSummary(decisions: Decision[], scope: ScopeItem[]): string {
  const parts: string[] = [];

  if (decisions.length > 0) {
    parts.push('## Decisions');
    parts.push('');
    for (const decision of decisions) {
      parts.push(`### ${decision.id}: ${decision.question}`);
      if (decision.patronOverride) {
        parts.push(`**Patron override:** ${decision.patronOverride}`);
      } else if (decision.selected) {
        const label = decision.options[decision.selected] ?? decision.selected;
        parts.push(`**Selected:** ${label}`);
      }
      parts.push('');
    }
  }

  if (scope.length > 0) {
    parts.push('## Scope');
    parts.push('');
    for (const item of scope) {
      const check = item.included ? '[x]' : '[ ]';
      const suffix = item.included ? '' : ' (excluded)';
      parts.push(`- ${check} ${item.id}: ${item.description}${suffix}`);
    }
  }

  return parts.join('\n').trim();
}

// ── Engine factory ───────────────────────────────────────────────────

export function createDecisionReviewEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.decision-review',

    // Retry budget — transient session crashes retry in-place. Terminal
    // exhaustion fails the writ directly. Decision-review itself is a
    // clockwork engine that creates input requests; the retry budget
    // covers transient errors in that path (e.g. stacks transient errors).
    retry: { maxAttempts: 2 },

    async run(
      givens: Record<string, unknown>,
      context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const planId = givens.planId as string;
      const book = getPlansBook();

      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      // ── First run: status === 'analyzing' ─────────────────────────

      if (plan.status === 'analyzing') {
        const decisions = plan.decisions ?? [];
        const scopeItems = plan.scope ?? [];

        // Reviewable decisions are those the primer left for the patron by
        // leaving `selected` unset. Pre-decided decisions (where the primer
        // already pre-filled `selected`) are auto-accepted — they skip the
        // InputRequestDoc entirely and flow through reconcile unchanged.
        const reviewableDecisions = decisions.filter(d => d.selected === undefined);

        // Fast-path: nothing is reviewable. Scope items are implicitly
        // auto-accepted in that case — the primer has settled everything.
        if (reviewableDecisions.length === 0) {
          await book.patch(planId, {
            status: 'writing',
            updatedAt: new Date().toISOString(),
          });
          return {
            status: 'completed',
            yields: { decisionSummary: '' },
          };
        }

        // Build questions — only for reviewable decisions plus scope items.
        // Pre-decided decisions are omitted from both `questions` and `answers`.
        const questions: Record<string, ChoiceQuestionSpec | BooleanQuestionSpec> = {};
        const answers: Record<string, AnswerValue> = {};

        for (const decision of reviewableDecisions) {
          const choiceSpec: ChoiceQuestionSpec = {
            type: 'choice',
            label: decision.question,
            details: composeDetails(decision.context, decision.rationale),
            options: decision.options,
            allowCustom: true,
          };
          questions[decision.id] = choiceSpec;

          if (decision.recommendation) {
            answers[decision.id] = { selected: decision.recommendation } as ChoiceAnswer;
          }
        }

        for (const item of scopeItems) {
          const boolSpec: BooleanQuestionSpec = {
            type: 'boolean',
            label: item.description,
            details: item.rationale,
          };
          questions[`scope:${item.id}`] = boolSpec;
          answers[`scope:${item.id}`] = item.included;
        }

        // Compose message
        let message: string;
        try {
          const clerk = guild().apparatus<ClerkApi>('clerk');
          const writ = await clerk.show(planId);
          const includedScope = scopeItems.filter(s => s.included).map(s => s.description);
          const scopeSummary = includedScope.length > 0
            ? `\n\nIn-scope items: ${includedScope.join(', ')}`
            : '';
          message = `Planning review for: ${writ.title} (codex: ${plan.codex})${scopeSummary}`;
        } catch {
          message = `Planning review for plan: ${planId} (codex: ${plan.codex})`;
        }

        // Create InputRequestDoc
        const requestId = generateId('ir', 4);
        const now = new Date().toISOString();
        const inputRequest: InputRequestDoc = {
          id: requestId,
          rigId: context.rigId,
          engineId: context.engineId,
          status: 'pending',
          message,
          questions,
          answers,
          createdAt: now,
          updatedAt: now,
        };

        const stacks = guild().apparatus<StacksApi>('stacks');
        const inputRequestsBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
        await inputRequestsBook.put(inputRequest);

        // Update plan status to 'reviewing'
        await book.patch(planId, {
          status: 'reviewing',
          updatedAt: now,
        });

        return {
          status: 'blocked',
          blockType: 'patron-input',
          condition: { requestId },
        };
      }

      // ── Re-run: status === 'reviewing' ────────────────────────────

      if (plan.status === 'reviewing') {
        // Extract requestId from priorBlock or query book
        let requestId: string;

        if (context.priorBlock?.condition) {
          const cond = context.priorBlock.condition as { requestId: string };
          requestId = cond.requestId;
        } else {
          // Fallback: query by rigId + engineId
          const stacks = guild().apparatus<StacksApi>('stacks');
          const inputRequestsBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
          const found = await inputRequestsBook.find({
            where: [
              ['rigId', '=', context.rigId],
              ['engineId', '=', context.engineId],
            ],
            limit: 1,
          });
          if (found.length === 0) {
            throw new Error(
              `No InputRequestDoc found for rig "${context.rigId}" engine "${context.engineId}".`,
            );
          }
          requestId = found[0].id;
        }

        const stacks = guild().apparatus<StacksApi>('stacks');
        const inputRequestsBook = stacks.book<InputRequestDoc>('spider', 'input-requests');
        const inputRequest = await inputRequestsBook.get(requestId);
        if (!inputRequest) {
          throw new Error(`InputRequestDoc "${requestId}" not found.`);
        }

        // Reconcile answers back into the plan
        const decisions = (plan.decisions ?? []).map(d => ({ ...d }));
        const scopeItems = (plan.scope ?? []).map(s => ({ ...s }));

        for (const [key, answer] of Object.entries(inputRequest.answers)) {
          if (key.startsWith('scope:')) {
            const scopeId = key.slice('scope:'.length);
            const item = scopeItems.find(s => s.id === scopeId);
            if (item) {
              item.included = answer as boolean;
            }
          } else {
            const decision = decisions.find(d => d.id === key);
            if (decision) {
              const choiceAnswer = answer as ChoiceAnswer;
              if ('selected' in choiceAnswer) {
                decision.selected = choiceAnswer.selected;
                delete decision.patronOverride;
              } else if ('custom' in choiceAnswer) {
                decision.patronOverride = choiceAnswer.custom;
                delete decision.selected;
              }
            }
          }
        }

        // ── Validate invariant: exactly one of selected / patronOverride ──
        const inconsistent = decisions.filter(
          d => (d.selected !== undefined) === (d.patronOverride !== undefined),
        );
        if (inconsistent.length > 0) {
          const ids = inconsistent.map(d => d.id).join(', ');
          throw new Error(
            `Decisions in inconsistent state after reconcile (must have exactly one of ` +
              `selected/patronOverride): ${ids}`,
          );
        }

        const decisionSummary = buildDecisionSummary(decisions, scopeItems);

        const now = new Date().toISOString();
        await book.patch(planId, {
          decisions,
          scope: scopeItems,
          status: 'writing',
          updatedAt: now,
        });

        return {
          status: 'completed',
          yields: { decisionSummary },
        };
      }

      throw new Error(
        `decision-review: unexpected plan status "${plan.status}" for plan "${planId}". ` +
          `Expected 'analyzing' or 'reviewing'.`,
      );
    },
  };
}
