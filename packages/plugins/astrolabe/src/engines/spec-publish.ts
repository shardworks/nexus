/**
 * spec-publish clockwork engine.
 *
 * Posts the generated specification as a mandate writ, links it back to
 * the originating brief via a 'refines' link, records generatedWritId on
 * the PlanDoc, and transitions the plan to 'completed'.
 *
 * When the spec contains a `<task-manifest>`, the engine:
 *   1. Strips the manifest block from the spec (mandate body).
 *   2. Posts the mandate writ in draft state.
 *   3. Creates one child piece writ per `<task>` element.
 *   4. Transitions the mandate from draft to open (ready for dispatch).
 *
 * Preconditions:
 *   - plan.status must be 'writing'
 *   - plan.spec must be a non-empty string
 */

import { guild } from '@shardworks/nexus-core';
import type { EngineDesign, EngineRunContext, EngineRunResult } from '@shardworks/fabricator-apparatus';
import type { Book } from '@shardworks/stacks-apparatus';
import type { ClerkApi } from '@shardworks/clerk-apparatus';
import type { PlanDoc } from '../types.ts';

/**
 * Parse the `<task-manifest>` block from the spec string.
 * Returns the individual `<task ...>...</task>` fragments and the spec
 * with the manifest block removed.
 *
 * If no manifest is found, returns null.
 */
export function parseTaskManifest(spec: string): {
  tasks: string[];
  strippedSpec: string;
} | null {
  // Match the full <task-manifest>...</task-manifest> block (greedy, single match)
  const manifestMatch = spec.match(/<task-manifest>([\s\S]*?)<\/task-manifest>/);
  if (!manifestMatch) return null;

  const manifestBlock = manifestMatch[0];
  const manifestInner = manifestMatch[1]!;

  // Extract individual <task ...>...</task> elements
  const taskRegex = /<task\b[^>]*>[\s\S]*?<\/task>/g;
  const tasks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = taskRegex.exec(manifestInner)) !== null) {
    tasks.push(match[0].trim());
  }

  if (tasks.length === 0) return null;

  // Strip the manifest block from the spec
  const strippedSpec = spec.replace(manifestBlock, '').trim();

  return { tasks, strippedSpec };
}

export function createSpecPublishEngine(getPlansBook: () => Book<PlanDoc>): EngineDesign {
  return {
    id: 'astrolabe.spec-publish',

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

      // Validate status
      if (plan.status !== 'writing') {
        throw new Error(
          `spec-publish: expected plan status "writing" but got "${plan.status}" for plan "${planId}".`,
        );
      }

      // Validate spec exists
      if (typeof plan.spec !== 'string' || plan.spec.length === 0) {
        throw new Error(
          `Plan "${planId}" has no spec — spec-writer stage did not produce output.`,
        );
      }

      const clerk = guild().apparatus<ClerkApi>('clerk');

      // Read the brief writ for its title
      const briefWrit = await clerk.show(planId);

      // Resolve generated writ type from config
      const generatedWritType = guild().guildConfig().astrolabe?.generatedWritType ?? 'mandate';

      // Check for task manifest
      const manifestResult = parseTaskManifest(plan.spec);

      if (manifestResult) {
        // ── Piece-aware path: manifest found ──
        const { tasks, strippedSpec } = manifestResult;

        // 1. Post mandate in draft state (pieces need parent to exist)
        const generatedWrit = await clerk.post({
          type: generatedWritType,
          title: briefWrit.title,
          body: strippedSpec,
          codex: plan.codex,
          draft: true,
        });

        // 2. Create child piece writs (one per task, in manifest order)
        for (const taskXml of tasks) {
          // Extract task id for a meaningful title
          const idMatch = taskXml.match(/<task\s+id="([^"]+)"/);
          const taskId = idMatch?.[1] ?? 'task';
          const nameMatch = taskXml.match(/<name>([\s\S]*?)<\/name>/);
          const taskName = nameMatch?.[1]?.trim() ?? taskId;

          await clerk.post({
            type: 'piece',
            title: taskName,
            body: taskXml,
            parentId: generatedWrit.id,
          });
        }

        // 3. Link: mandate (source) → brief (target), type 'refines'
        await clerk.link(generatedWrit.id, planId, 'refines');

        // 4. Transition mandate from draft to open (ready for dispatch)
        await clerk.transition(generatedWrit.id, 'open');

        // 5. Update PlanDoc
        const now = new Date().toISOString();
        await book.patch(planId, {
          generatedWritId: generatedWrit.id,
          status: 'completed',
          updatedAt: now,
        });

        return {
          status: 'completed',
          yields: { generatedWritId: generatedWrit.id },
        };
      }

      // ── Legacy path: no manifest ──
      const generatedWrit = await clerk.post({
        type: generatedWritType,
        title: briefWrit.title,
        body: plan.spec,
        codex: plan.codex,
      });

      // Link: mandate (source) → brief (target), type 'refines'
      await clerk.link(generatedWrit.id, planId, 'refines');

      // Update PlanDoc
      const now = new Date().toISOString();
      await book.patch(planId, {
        generatedWritId: generatedWrit.id,
        status: 'completed',
        updatedAt: now,
      });

      return {
        status: 'completed',
        yields: { generatedWritId: generatedWrit.id },
      };
    },
  };
}
