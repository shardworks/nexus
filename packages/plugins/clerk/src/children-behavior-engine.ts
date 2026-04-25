/**
 * Children-behavior cascade engine.
 *
 * Subscribes to `update` events on the `clerk/writs` book and, when a writ
 * transitions to a terminal state, evaluates the relevant
 * `WritTypeConfig.childrenBehavior` block(s) and applies the configured
 * action via the supplied `transition` callback. The engine is generic in
 * writ type — any registered type whose config declares a
 * `childrenBehavior` block opts in; types that omit the block are no-ops.
 *
 * Two cascade directions, both driven by the same firing rule (terminal
 * transition on `update` events) and dispatched from the same `handle`
 * function:
 *
 *   - **Upward** (terminal child → parent lift). Drives the parent through
 *     the parent type's `allSuccess` / `anyFailure` triggers when the
 *     triggering *child* reaches a `success`- or `failure`-attr terminal
 *     state respectively.
 *   - **Downward** (terminal parent → non-terminal children cancellation).
 *     Drives every non-terminal descendant through the parent type's
 *     `parentTerminal` trigger when the *parent itself* reaches a
 *     `failure`- or `cancelled`-attr terminal state. Recursion to
 *     grandchildren happens via natural CDC re-fire on each child's own
 *     transition, not by an in-handler walk.
 *
 * Upward firing rule (in order — first-fail short-circuits):
 *
 *   1. Event is an `update`.
 *   2. The entry's phase actually changed (`entry.phase !== prev.phase`).
 *   3. The entry is in a terminal state.
 *   4. The entry has a `parentId`.
 *   5. The parent writ exists. (Throws if not — dangling parent is a
 *      data-integrity violation.)
 *   6. The parent's writ-type is registered. (Throws if not — same
 *      fail-loud shape as `classifyWritState`.)
 *   7. The parent type declares a `childrenBehavior` block. (Silent
 *      no-op when absent.)
 *   8. The parent itself is non-terminal. (Idempotent short-circuit.)
 *
 * Upward trigger evaluation order: `anyFailure` is evaluated first; if it
 * fires, `allSuccess` is skipped. Otherwise `allSuccess` is evaluated by
 * enumerating *every* sibling under the same parent (not via the limited
 * `api.list` path) and checking that every sibling has reached a terminal
 * state and every terminal state carries the `success` attr.
 *
 * Downward firing rule (in order — first-fail short-circuits):
 *
 *   1. Event is an `update`.
 *   2. The entry's phase actually changed (`entry.phase !== prev.phase`).
 *   3. The entry is in a terminal state carrying the `failure` or
 *      `cancelled` attr (the parent-itself-terminated signal). The
 *      `success` attr — i.e. natural completion — does *not* fire the
 *      downward branch; in healthy mandates a `completed` parent has no
 *      non-terminal children to cancel.
 *   4. The entry's own writ-type is registered.
 *   5. The entry's type declares a `parentTerminal` action. (Silent
 *      no-op when absent.)
 *   6. The entry has at least one non-terminal child. The branch
 *      enumerates children via direct-book read (bypassing `api.list`'s
 *      20-row default) and skips already-terminal children using
 *      `isTerminal`.
 *
 * For each non-terminal child, the engine calls `api.transition` with the
 * action's configured `transition` target and `resolution` string (or the
 * child's own resolution when `copyResolution: true`). If a child cannot
 * accept the configured target — typically a child-type declaring no
 * transition into the configured state from the child's current state —
 * `api.transition` throws and the Phase 1 transaction rolls back per the
 * engine's existing fail-loud convention. Already-terminal children are
 * skipped (idempotent on re-fire).
 *
 * Cascade ordering when both directions fire on the same chain (e.g. an
 * upward `anyFailure` that lifts a parent into `failed`, which then
 * needs to push down into the parent's other open siblings) is handled
 * by natural CDC re-fire: the parent's own update event re-enters this
 * handler and triggers the downward branch on the parent's now-terminal
 * transition.
 *
 * When a trigger fires with `copyResolution: true`, the triggering
 * writ's `resolution` string is copied onto the target as part of the
 * transition. When a trigger fires with `resolution: '...'`, that static
 * string is written onto every transitioned writ.
 *
 * On every upward fire, before the parent's transition is recorded, the
 * engine publishes a structured record onto the parent's Clerk-owned
 * status sub-slot (`status['clerk']`) containing the immediate triggering
 * child's id. The write must precede the transition: downstream observers
 * (notably the Reckoner) are CDC-driven from the terminal transition's
 * `updatedAt`, and they read `status['clerk']` from the post-commit
 * `entry` snapshot at that moment. Writing the slot *after* the transition
 * would deliver the pulse against a snapshot that pre-dates the slot's
 * existence and degrade the leaf-cause surface.
 *
 * The engine never writes to the writ document directly — every state
 * change goes through `transition`, so allowedTransitions enforcement,
 * terminal `resolvedAt` tagging, and CDC re-fire all behave identically
 * to a direct caller.
 */

import type { Book, ChangeEvent } from '@shardworks/stacks-apparatus';

import type { ClerkWritStatus, WritDoc, WritPhase } from './types.ts';
import { CLERK_PLUGIN_ID } from './types.ts';
import type {
  WritTypeChildrenBehaviorAction,
  WritTypeConfig,
  WritTypeStateDefinition,
} from './writ-type-config.ts';

/**
 * Dependencies the engine needs from the surrounding Clerk runtime.
 *
 * `writs` is the book the engine reads sibling lists from directly (the
 * limited `api.list` default would silently truncate parents with >20
 * children). `getWritTypeConfig` is the registry accessor.
 * `isTerminal` is the writ-type-classification predicate.
 * `transition` is the sole sanctioned phase-change surface.
 * `setWritStatus` is the sanctioned slot-write path; the engine uses it
 * to publish `status['clerk']` immediately before the parent's terminal
 * transition.
 */
export interface ChildrenBehaviorEngineDeps {
  writs: Book<WritDoc>;
  getWritTypeConfig(name: string): WritTypeConfig | undefined;
  isTerminal(writ: WritDoc): boolean;
  transition(
    id: string,
    to: WritPhase,
    fields?: Partial<WritDoc>,
  ): Promise<WritDoc>;
  setWritStatus(
    writId: string,
    pluginId: string,
    value: unknown,
  ): Promise<WritDoc>;
}

/**
 * Build the engine handler. Returns an async function suitable for
 * passing to `stacks.watch('clerk', 'writs', handler, { failOnError: true })`.
 */
export function createChildrenBehaviorEngine(
  deps: ChildrenBehaviorEngineDeps,
): (event: ChangeEvent<WritDoc>) => Promise<void> {
  const { writs, getWritTypeConfig, isTerminal, transition, setWritStatus } = deps;

  /**
   * Drive the parent through `transition` with the configured target,
   * passing the triggering child's resolution when `copyResolution` is
   * truthy.
   *
   * Publishes the Clerk-owned status sub-slot (`status['clerk']`) with
   * the triggering child's id BEFORE the transition fires. The Reckoner's
   * dedupe identity keys on the terminal transition's `updatedAt` and its
   * emit-time read sees `event.entry` (the post-commit snapshot at that
   * instant). Writing the slot after the transition would deliver the
   * pulse against a snapshot that pre-dates the slot's existence — the
   * leaf-cause surface would degrade silently. See the engine's top-of-
   * file commentary for the full ordering rationale.
   */
  async function fireTrigger(
    parent: WritDoc,
    triggeringChild: WritDoc,
    action: WritTypeChildrenBehaviorAction,
  ): Promise<void> {
    const clerkStatus: ClerkWritStatus = {
      triggeringChildId: triggeringChild.id,
    };
    await setWritStatus(parent.id, CLERK_PLUGIN_ID, clerkStatus);

    const fields: Partial<WritDoc> = {};
    if (action.copyResolution && typeof triggeringChild.resolution === 'string') {
      fields.resolution = triggeringChild.resolution;
    } else if (typeof action.resolution === 'string') {
      fields.resolution = action.resolution;
    }
    await transition(parent.id, action.transition as WritPhase, fields);
  }

  /**
   * Resolve the attrs declared on a writ's current state, per its
   * registered type config. Returns an empty array when either the type
   * or the state is unknown — both branches keep behaviour readable in
   * the call site without forcing a throw inside attr-keyed predicates.
   */
  function attrsOf(writ: WritDoc): string[] {
    const config = getWritTypeConfig(writ.type);
    const state = config?.states.find(
      (s: WritTypeStateDefinition) => s.name === writ.phase,
    );
    return state?.attrs ?? [];
  }

  return async function handle(event: ChangeEvent<WritDoc>): Promise<void> {
    // 1. update events only — validator forbids initial states from being
    //    terminal, so create events can never satisfy the firing rule.
    if (event.type !== 'update') return;

    const entry = event.entry;
    const prev = event.prev;

    // 2. Phase actually changed.
    if (entry.phase === prev.phase) return;

    // 3. New phase is terminal.
    if (!isTerminal(entry)) return;

    // ── Downward branch (parentTerminal) ─────────────────────────────
    //
    // Fires on the entry's own type's `parentTerminal` action when the
    // entry has reached a `failure`- or `cancelled`-attr terminal. The
    // upward branch below uses the *parent* type's childrenBehavior;
    // the downward branch uses *this* writ's own type.
    const entryAttrs = attrsOf(entry);
    const parentTerminated =
      entryAttrs.includes('failure') || entryAttrs.includes('cancelled');

    if (parentTerminated) {
      const entryConfig = getWritTypeConfig(entry.type);
      if (!entryConfig) {
        throw new Error(
          `[clerk] writ "${entry.id}" carries type "${entry.type}" which is not registered.`,
        );
      }
      const parentTerminalAction = entryConfig.childrenBehavior?.parentTerminal;
      if (parentTerminalAction) {
        // Enumerate children — bypass api.list's default 20-row limit by
        // going to the writs book directly. Already-terminal children
        // are skipped (idempotent on re-fire). Misconfigured children
        // (target unreachable from current child state) throw inside
        // `transition` and roll back the Phase 1 transaction per the
        // engine's existing fail-loud convention.
        const children = await writs.find({
          where: [['parentId', '=', entry.id]],
        });
        for (const child of children) {
          if (isTerminal(child)) continue;
          const fields: Partial<WritDoc> = {};
          if (parentTerminalAction.copyResolution && typeof entry.resolution === 'string') {
            fields.resolution = entry.resolution;
          } else if (typeof parentTerminalAction.resolution === 'string') {
            fields.resolution = parentTerminalAction.resolution;
          }
          await transition(child.id, parentTerminalAction.transition as WritPhase, fields);
        }
      }
    }

    // ── Upward branch (allSuccess / anyFailure) ──────────────────────
    //
    // Resumes the original firing rule for the upward direction: the
    // entry is now treated as a triggering *child* relative to its
    // parent.

    // 4. Has a parent.
    const parentId = entry.parentId;
    if (!parentId) return;

    // 5. Parent writ exists. Dangling parentId is fail-loud.
    const parent = await writs.get(parentId);
    if (!parent) {
      throw new Error(
        `[clerk] children-behavior engine: writ "${entry.id}" references parent "${parentId}" which does not exist.`,
      );
    }

    // 6. Parent type is registered. Mirrors classifyWritState's
    //    fail-loud diagnostic shape.
    const parentConfig = getWritTypeConfig(parent.type);
    if (!parentConfig) {
      throw new Error(
        `[clerk] writ "${parent.id}" carries type "${parent.type}" which is not registered.`,
      );
    }

    // 7. Parent declares a childrenBehavior block. Silent no-op when absent.
    const cb = parentConfig.childrenBehavior;
    if (!cb) return;

    // 8. Parent is non-terminal. Idempotency short-circuit — a subsequent
    //    child terminal event for an already-terminal parent is a no-op.
    if (isTerminal(parent)) return;

    // ── Resolve the child's terminal-state attrs ─────────────────────
    //
    // The child's type registry tells us what attrs the new terminal
    // state carries. The child's *own* type is what we inspect (not the
    // parent's): triggers semantically describe "what the child meant,"
    // and the child's type owns that vocabulary.
    const childAttrs = entryAttrs;

    // ── anyFailure (evaluated first; precedence rule) ───────────────
    if (cb.anyFailure && childAttrs.includes('failure')) {
      await fireTrigger(parent, entry, cb.anyFailure);
      return;
    }

    // ── allSuccess (evaluated only when anyFailure did not fire) ────
    if (cb.allSuccess && childAttrs.includes('success')) {
      // Enumerate every sibling — bypass api.list's default 20-row limit
      // by going to the writs book directly. A parent with >20 children
      // would otherwise silently miss siblings.
      const siblings = await writs.find({
        where: [['parentId', '=', parentId]],
      });

      const allTerminalSuccess = siblings.every((sibling) => {
        if (!isTerminal(sibling)) return false;
        const sibConfig = getWritTypeConfig(sibling.type);
        if (!sibConfig) return false;
        const sibState = sibConfig.states.find(
          (s: WritTypeStateDefinition) => s.name === sibling.phase,
        );
        const attrs = sibState?.attrs ?? [];
        return attrs.includes('success');
      });

      if (allTerminalSuccess) {
        await fireTrigger(parent, entry, cb.allSuccess);
        return;
      }
    }
  };
}
