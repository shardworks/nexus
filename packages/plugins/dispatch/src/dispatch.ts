/**
 * The Dispatch — interim work runner.
 *
 * Bridges the Clerk (which tracks obligations) and the session machinery
 * (which runs animas). Finds the oldest ready writ and executes it:
 * opens a draft binding, composes context, launches a session, and handles
 * the aftermath (seal the draft, transition the writ).
 *
 * This apparatus is temporary rigging — designed to be retired when the
 * full rigging system (Spider, Fabricator, Executor) is implemented.
 *
 * See: docs/architecture/apparatus/dispatch.md
 */

import type { Plugin } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { ScriptoriumApi, DraftRecord } from '@shardworks/codexes-apparatus';
import type { AnimatorApi, SessionResult } from '@shardworks/animator-apparatus';

import type { DispatchApi, DispatchRequest, DispatchResult } from './types.ts';
import { dispatchNext } from './tools/index.ts';

// ── Prompt assembly ──────────────────────────────────────────────────

function assemblePrompt(writ: WritDoc): string {
  const lines = [
    'You have been dispatched to fulfill a commission.',
    '',
    '## Assignment',
    '',
    `**Title:** ${writ.title}`,
    '',
    `**Writ ID:** ${writ.id}`,
  ];

  if (writ.body) {
    lines.push('', writ.body);
  }

  return lines.join('\n');
}

// ── Apparatus factory ────────────────────────────────────────────────

/**
 * Create the Dispatch apparatus plugin.
 *
 * Returns a Plugin with:
 * - `requires: ['clerk', 'codexes', 'animator']`
 * - `recommends: ['loom']` — used indirectly via Animator.summon()
 * - `provides: DispatchApi` — the dispatch API
 * - `supportKit` — contributes the `dispatch-next` tool
 */
export function createDispatch(): Plugin {
  const api: DispatchApi = {
    async next(request?: DispatchRequest): Promise<DispatchResult | null> {
      const role = request?.role ?? 'artificer';
      const dryRun = request?.dryRun ?? false;

      const clerk = guild().apparatus<ClerkApi>('clerk');

      // 1. Find oldest ready writ (FIFO — list returns desc by createdAt, take last)
      const readyWrits = await clerk.list({ status: 'ready' });
      const writ = readyWrits[readyWrits.length - 1] ?? null;

      if (!writ) return null;

      if (dryRun) {
        return { writId: writ.id, dryRun: true };
      }

      const scriptorium = guild().apparatus<ScriptoriumApi>('codexes');
      const animator = guild().apparatus<AnimatorApi>('animator');

      // 2. Transition writ ready → active
      await clerk.transition(writ.id, 'active');

      // 3. Open draft if writ has a codex
      const codexName = typeof writ.codex === 'string' ? writ.codex : undefined;
      let draft: DraftRecord | undefined;

      if (codexName) {
        try {
          draft = await scriptorium.openDraft({ codexName, associatedWith: writ.id });
        } catch (err) {
          const reason = `Draft open failed: ${String(err)}`;
          await clerk.transition(writ.id, 'failed', { resolution: reason });
          return { writId: writ.id, outcome: 'failed', resolution: reason, dryRun: false };
        }
      }

      // Session cwd: draft worktree path if codex, otherwise guild home
      const cwd = draft?.path ?? guild().home;

      // 4. Assemble prompt and summon anima
      const prompt = assemblePrompt(writ);
      const handle = animator.summon({
        role,
        prompt,
        cwd,
        environment: {
          GIT_AUTHOR_EMAIL: `${writ.id}@nexus.local`,
        },
        metadata: { writId: writ.id, trigger: 'dispatch' },
      });

      // 5. Await session result
      let session: SessionResult;
      try {
        session = await handle.result;
      } catch (err) {
        // Unexpected rejection (summon normally resolves with a failed status)
        const reason = `Session error: ${String(err)}`;
        if (codexName && draft) {
          await scriptorium.abandonDraft({ codexName, branch: draft.branch, force: true });
        }
        await clerk.transition(writ.id, 'failed', { resolution: reason });
        return { writId: writ.id, outcome: 'failed', resolution: reason, dryRun: false };
      }

      // 6a. Success path
      if (session.status === 'completed') {
        if (codexName && draft) {
          // Seal the draft — fail writ if seal fails but preserve draft for recovery
          try {
            await scriptorium.seal({ codexName, sourceBranch: draft.branch });
          } catch (err) {
            const reason = `Seal failed: ${String(err)}`;
            await clerk.transition(writ.id, 'failed', { resolution: reason });
            return { writId: writ.id, sessionId: session.id, outcome: 'failed', resolution: reason, dryRun: false };
          }

          // Push — same treatment as seal failure
          try {
            await scriptorium.push({ codexName });
          } catch (err) {
            const reason = `Push failed: ${String(err)}`;
            await clerk.transition(writ.id, 'failed', { resolution: reason });
            return { writId: writ.id, sessionId: session.id, outcome: 'failed', resolution: reason, dryRun: false };
          }
        }

        const resolution = `Session ${session.id} completed`;
        await clerk.transition(writ.id, 'completed', { resolution });
        return { writId: writ.id, sessionId: session.id, outcome: 'completed', resolution, dryRun: false };
      }

      // 6b. Failure path (status: 'failed' | 'timeout')
      if (codexName && draft) {
        await scriptorium.abandonDraft({ codexName, branch: draft.branch, force: true });
      }
      const reason = session.error ?? `Session ${session.status}`;
      await clerk.transition(writ.id, 'failed', { resolution: reason });
      return { writId: writ.id, sessionId: session.id, outcome: 'failed', resolution: reason, dryRun: false };
    },
  };

  return {
    apparatus: {
      requires: ['clerk', 'codexes', 'animator'],
      recommends: ['loom'],

      supportKit: {
        tools: [dispatchNext],
      },

      provides: api,

      start(): void {
        // No initialization needed — clerk is resolved at call time in next().
      },
    },
  };
}
