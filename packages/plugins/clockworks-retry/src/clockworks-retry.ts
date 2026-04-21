/**
 * The Clockworks-Retry apparatus — the autonomous-hopper retry primitive.
 *
 * Observes stuck writs carrying `retryable: true` on their
 * `status.spider.stuck` sub-slot and transitions them `stuck → open`,
 * causing Spider to spawn the next rig attempt. Bounded by a single
 * global cap of N=2 attempts, counted as the number of rigs already
 * attached to the writ (multi-rig-lite — one writ accumulates multiple
 * rigs over successive attempts).
 *
 * This keeps Spider's core logic unaware of retry policy — retry is a
 * policy observer layered on top of Spider's substrate, not a concern
 * Spider itself knows about. Policy can evolve (or be swapped entirely)
 * without touching Spider.
 *
 * Hard precondition: the sibling commission that introduces the
 * `retryable` flag must populate `writ.status.spider.stuck.retryable`
 * on engine-failure stucks. Without that flag, the clockwork's trigger
 * condition is never met and this binding is safely inert.
 *
 * Non-negotiable decisions (see commission c-mo814q):
 *
 *   - Dependency stucks (`failed-blocker`, `cycle`) — ignored. Those
 *     live on the existing `status.spider.stuckCause` slot written by
 *     Spider's gating path, and are handled by Spider's `autoUnstick`.
 *   - `retryable: false` — ignored. Definitional failure; requires
 *     human attention.
 *   - Missing `retryable` field — ignored. Fail-safe: a writ without
 *     the flag stays stuck.
 *   - `rigs.length >= MAX_RETRY_ATTEMPTS` — the clockwork does not
 *     requeue; the writ stays stuck for human attention.
 *
 * The clockwork does not create the rig directly — it flips the writ
 * state and lets Spider's normal scheduling machinery spawn the attempt.
 * The new rig attaches as a sibling child of the writ, and `rigs.length`
 * increments as a side effect.
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi, BookEntry, ReadOnlyBook } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { MAX_RETRY_ATTEMPTS, type ClockworksRetryApi } from './types.ts';

/**
 * Minimal shape of a Spider rig document — only the fields this plugin
 * needs. We avoid importing `RigDoc` from `@shardworks/spider-apparatus`
 * to keep the dependency direction one-way: retry policy reads Spider's
 * rigs book as a substrate, but is not in Spider's import graph.
 */
interface RigAttemptDoc extends BookEntry {
  id: string;
  writId: string;
}

export function createClockworksRetry(): Plugin {
  const api: ClockworksRetryApi = {
    maxAttempts: MAX_RETRY_ATTEMPTS,
  };

  return {
    apparatus: {
      requires: ['stacks', 'clerk'],
      // Spider is required in practice — without it there's no rigs book
      // and no engine-failure stucks — but the clockwork itself only
      // reads the rigs book and never calls into Spider's API. We keep
      // the coupling light (recommends, not requires) so the retry
      // policy remains a pure observer over Spider's substrate rather
      // than a hard dependant of Spider's lifecycle.
      recommends: ['spider'],

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');
        const clerk = g.apparatus<ClerkApi>('clerk');

        // Read-only view of Spider's rigs book — we count attempts, we
        // never mutate rigs directly. If Spider is absent the readBook
        // handle is still valid; the find() call below simply returns
        // an empty array and the branch that requeues never fires
        // (there is no rig, so no engine-failure stuck either).
        const rigs: ReadOnlyBook<RigAttemptDoc> = stacks.readBook<RigAttemptDoc>('spider', 'rigs');

        // Phase 2 (post-commit) CDC watcher on the writs book. Phase 2
        // is deliberate:
        //
        //   1. The retry transition (stuck → open) is a non-critical
        //      policy action layered on top of the primary stuck
        //      transition — a failure here must never roll back the
        //      underlying stuck write.
        //   2. The transition we issue (`clerk.transition(..., 'open')`)
        //      is itself a write on the same book we're watching. Phase
        //      1 handlers run inside the triggering transaction, which
        //      would re-enter the CDC dispatch and risk recursion; Phase
        //      2 runs after commit, so the open-transition's event is
        //      dispatched cleanly on the next cycle.
        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          async (event) => {
            if (event.type !== 'update') return;

            const writ = event.entry;
            const prev = event.prev;

            // Fire only on the *entry* into stuck. A stuck → stuck
            // status update (sub-slot rewrite) must not re-trigger.
            if (writ.phase !== 'stuck') return;
            if (prev.phase === 'stuck') return;

            // Trigger condition: status.spider.stuck.retryable === true.
            //
            // Missing field / non-true values / wrong shapes are all
            // fail-safe no-ops — the writ stays stuck for human
            // attention. This is how we ignore:
            //   - dependency stucks (failed-blocker, cycle): those
            //     live on status.spider.stuckCause (a sibling field),
            //     not status.spider.stuck.retryable.
            //   - pre-Slice-A writs that never get the flag written.
            //   - code paths that transition to stuck without setting
            //     the retry observability substrate.
            const spiderStatus = writ.status?.spider as
              | { stuck?: { retryable?: unknown } }
              | undefined;
            const retryable = spiderStatus?.stuck?.retryable;
            if (retryable !== true) return;

            // Count attempts as rigs-with-this-writId. The commission
            // deliberately uses `rigs.length` as the natural counter —
            // no separate counter field is introduced. See c-mo56pq2k
            // (multi-rig-lite) for the rationale.
            const attempts = await rigs.count([['writId', '=', writ.id]]);
            if (attempts >= MAX_RETRY_ATTEMPTS) return;

            // Requeue. Spider's trySpawn picks this up on the next
            // crawl and spawns a new rig; rigs.length increments as
            // a side effect. We do not touch status.spider here —
            // that slot is Spider's (the stuck observation is its
            // record of *why* the stuck happened), and preserving it
            // lets surfaces like the patron UI still render the
            // most recent stuck cause alongside the attempt counter.
            //
            // Guard against concurrent transitions: re-read the writ
            // inside the handler's own context and no-op if something
            // else has already moved it (e.g. a patron-driven cancel
            // firing between the CDC dispatch and this transition
            // write).
            await clerk.transition(writ.id, 'open');
          },
          { failOnError: false },
        );
      },
    },
  };
}
