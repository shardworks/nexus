/**
 * observation-lift clockwork engine.
 *
 * Walks the plan's `observations` array once it has reached its final
 * state and creates one draft writ per record, placed as top-level
 * siblings of the originating mandate rather than as its children. This
 * turns the sage's "things we noticed but didn't action" output from an
 * inert note into commissionable drafts visible in the same writ
 * surfaces as any other mandate — a downstream curator (human or
 * automated) promotes each draft to `open` by hand or via writ-publish.
 *
 * The engine runs in one of two modes, selected by record count:
 *
 *   - Flat mode (exactly one observation record):
 *       * Post a single top-level draft mandate writ (no `parentId`).
 *       * Install two outbound edges from that writ → originating
 *         mandate:
 *           - `astrolabe.lifted-from` (label "lifted from") carrying
 *             the provenance relationship, and
 *           - `spider.follows` (label "depends on") carrying the
 *             precedence-dependency gate.
 *
 *   - Grouped mode (two or more observation records):
 *       * Post a single top-level draft writ of type `observation-set`
 *         whose title embeds the originating mandate's title
 *         (`Observations from "{title}"`) and whose body is a short
 *         preamble naming the originating writ followed by a numbered
 *         list of the child titles.
 *       * Install exactly one outbound `astrolabe.lifted-from` edge
 *         from the group parent → originating mandate. The group parent
 *         carries no `spider.follows` edge (it is non-dispatchable by
 *         type, so a precedence edge on it would be dead data).
 *       * For each observation record in record order, post a draft
 *         mandate writ with `parentId` set to the group parent's id and
 *         install exactly one outbound `spider.follows` edge from that
 *         child → originating mandate. Children do not carry
 *         `astrolabe.lifted-from`; their provenance is implied by the
 *         group parent's edge plus the parent-child relationship.
 *
 * Both modes preserve the existing `spider.follows` gate: the
 * originating mandate is still the blocker, so Spider's `trySpawn` gate
 * will hold each lifted writ (flat) or each child (grouped) until the
 * mandate reaches a terminal state (release on completed/cancelled,
 * cascade to stuck on failed).
 *
 * Behavior:
 *   - Validates that the plan exists and its status is `completed`.
 *     (Placement inside the plan-and-ship rig guarantees this —
 *     observation-lift runs after plan-finalize, which transitions the
 *     plan to `completed`.)
 *   - Silently no-ops if `plan.observations` is not an array (legacy
 *     string-shaped plandocs) or is an empty array, yielding
 *     `{ writIds: [] }`.
 *   - Fails fast on the first error from either `clerk.post` or
 *     `clerk.link`. Already-created writs and links persist; rollback
 *     is not attempted. The loud failure is itself the signal for
 *     curator reconciliation.
 *   - In grouped mode, the per-record post-then-link pattern is
 *     preceded by a group-first post-then-link for the container, so a
 *     mid-loop failure leaves a coherent prefix (group parent + its
 *     edge + zero or more fully-wired children) behind.
 *   - Does not mutate the plandoc — the persisted writs and links form
 *     the audit trail.
 *
 * Yields:
 *   `{ writIds }` — the ids of the draft observation writs created, in
 *   the same order as the observation records. The group parent id
 *   (when one exists) is NOT included. Empty when the engine no-ops.
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { PlanDoc, Observation } from '../types.ts';

/**
 * Fixed threshold above which observation-lift produces a grouped
 * output (one top-level `observation-set` container with N draft
 * mandate children). Below the threshold the engine posts a single
 * flat top-level draft mandate. Kept as a module-local constant — not
 * exposed via AstrolabeConfig — because no second consumer demands
 * configurability.
 */
const GROUPING_THRESHOLD = 2;

/**
 * Builds the group parent's body: a short preamble naming the
 * originating mandate, followed by a numbered list of child titles.
 */
function buildGroupBody(originatingTitle: string, originatingId: string, observations: Observation[]): string {
  const preamble =
    `Lifted from the planning run of "${originatingTitle}" (${originatingId}). ` +
    `Each numbered observation below is a draft mandate ready for curator promotion.`;
  const lines = observations.map((obs, i) => `${i + 1}. ${obs.title}`);
  return `${preamble}\n\n${lines.join('\n')}\n`;
}

export function createObservationLiftEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.observation-lift',

    async run(
      givens: Record<string, unknown>,
      _context: EngineRunContext,
    ): Promise<EngineRunResult> {
      const planId = givens.planId as string;
      const book = getPlansBook();

      const plan = await book.get(planId);
      if (!plan) {
        throw new Error(`Plan "${planId}" not found.`);
      }

      if (plan.status !== 'completed') {
        throw new Error(
          `observation-lift: expected plan status "completed" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      const observations = plan.observations;
      if (!Array.isArray(observations) || observations.length === 0) {
        // Legacy string-shaped plandocs or empty arrays: no-op.
        return {
          status: 'completed',
          yields: { writIds: [] as string[] },
        };
      }

      const clerk = guild().apparatus<ClerkApi>('clerk');

      // In grouped mode, we need the originating mandate's title for
      // the container title. Fetch it once here; a single extra read
      // against Clerk is cheap and keeps the group parent's title
      // accurate if the mandate was renamed after the plan was primed.
      let groupParentId: string | undefined;
      if (observations.length >= GROUPING_THRESHOLD) {
        const originating = await clerk.show(planId);
        const originatingTitle = originating.title;

        const groupParent = await clerk.post({
          type: 'observation-set',
          title: `Observations from "${originatingTitle}"`,
          body: buildGroupBody(originatingTitle, planId, observations),
          codex: plan.codex,
        });
        groupParentId = groupParent.id;

        // Provenance edge: group parent → originating mandate. This is
        // the single lifted-from anchor for the entire batch; children
        // inherit provenance through their parentId + the group's edge.
        await clerk.link(
          groupParent.id,
          planId,
          'lifted from',
          'astrolabe.lifted-from',
        );
      }

      const writIds: string[] = [];

      for (const observation of observations) {
        // Per-record: post then link before the next iteration. Errors
        // from either call propagate immediately. Already-created
        // drafts (and their links) persist — rollback is not attempted;
        // a curator reconciles by hand if needed.
        const postRequest: Parameters<ClerkApi['post']>[0] = {
          type: 'mandate',
          title: observation.title,
          body: observation.body,
          codex: plan.codex,
        };
        if (groupParentId !== undefined) {
          postRequest.parentId = groupParentId;
        }
        const writ = await clerk.post(postRequest);
        writIds.push(writ.id);

        if (groupParentId === undefined) {
          // Flat mode: the single lifted writ also carries the
          // provenance edge. (In grouped mode the group parent alone
          // carries lifted-from; children trace back via parentId.)
          await clerk.link(
            writ.id,
            planId,
            'lifted from',
            'astrolabe.lifted-from',
          );
        }

        // Precedence-dependency edge back to the originating mandate
        // so the Spider's `trySpawn` gate holds the lifted writ until
        // the mandate reaches a terminal state. In grouped mode only
        // children carry this edge — the group parent is
        // non-dispatchable by type, so a spider.follows edge on it
        // would be dead data.
        await clerk.link(
          writ.id,
          planId,
          'depends on',
          'spider.follows',
        );
      }

      return {
        status: 'completed',
        yields: { writIds },
      };
    },
  };
}
