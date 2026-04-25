/**
 * Children-behavior cascade engine.
 *
 * Subscribes to `update` events on the `clerk/writs` book and, when a writ
 * transitions to a terminal state, evaluates the parent's
 * `WritTypeConfig.childrenBehavior` block and applies the configured
 * action via the supplied `transition` callback. The engine is generic in
 * writ type — any registered type whose config declares a
 * `childrenBehavior` block opts in; types that omit the block are no-ops.
 *
 * Firing rule (in order — first-fail short-circuits):
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
 * Trigger evaluation order: `anyFailure` is evaluated first; if it fires,
 * `allSuccess` is skipped. Otherwise `allSuccess` is evaluated by
 * enumerating *every* sibling under the same parent (not via the limited
 * `api.list` path) and checking that every sibling has reached a terminal
 * state and every terminal state carries the `success` attr.
 *
 * When a trigger fires with `copyResolution: true`, the triggering child's
 * `resolution` string (the writ in the CDC update event) is copied onto
 * the parent through the same `transition` call.
 *
 * The engine never writes to the writ document directly — every parent
 * state change goes through `transition`, so allowedTransitions
 * enforcement, terminal `resolvedAt` tagging, and CDC re-fire all behave
 * identically to a direct caller.
 */

import type { Book, ChangeEvent } from '@shardworks/stacks-apparatus';

import type { WritDoc, WritPhase } from './types.ts';
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
 * `transition` is the sole sanctioned mutation surface.
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
}

/**
 * Build the engine handler. Returns an async function suitable for
 * passing to `stacks.watch('clerk', 'writs', handler, { failOnError: true })`.
 */
export function createChildrenBehaviorEngine(
  deps: ChildrenBehaviorEngineDeps,
): (event: ChangeEvent<WritDoc>) => Promise<void> {
  const { writs, getWritTypeConfig, isTerminal, transition } = deps;

  /**
   * Drive the parent through `transition` with the configured target,
   * passing the triggering child's resolution when `copyResolution` is
   * truthy.
   */
  async function fireTrigger(
    parent: WritDoc,
    triggeringChild: WritDoc,
    action: WritTypeChildrenBehaviorAction,
  ): Promise<void> {
    const fields: Partial<WritDoc> = {};
    if (action.copyResolution && typeof triggeringChild.resolution === 'string') {
      fields.resolution = triggeringChild.resolution;
    }
    await transition(parent.id, action.transition as WritPhase, fields);
  }

  return async function handle(event: ChangeEvent<WritDoc>): Promise<void> {
    // 1. update events only — validator forbids initial states from being
    //    terminal, so create events can never satisfy the firing rule.
    if (event.type !== 'update') return;

    const child = event.entry;
    const prev = event.prev;

    // 2. Phase actually changed.
    if (child.phase === prev.phase) return;

    // 3. New phase is terminal.
    if (!isTerminal(child)) return;

    // 4. Has a parent.
    const parentId = child.parentId;
    if (!parentId) return;

    // 5. Parent writ exists. Dangling parentId is fail-loud.
    const parent = await writs.get(parentId);
    if (!parent) {
      throw new Error(
        `[clerk] children-behavior engine: writ "${child.id}" references parent "${parentId}" which does not exist.`,
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
    const childConfig = getWritTypeConfig(child.type);
    const childState = childConfig?.states.find(
      (s: WritTypeStateDefinition) => s.name === child.phase,
    );
    const childAttrs = childState?.attrs ?? [];

    // ── anyFailure (evaluated first; precedence rule) ───────────────
    if (cb.anyFailure && childAttrs.includes('failure')) {
      await fireTrigger(parent, child, cb.anyFailure);
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
        await fireTrigger(parent, child, cb.allSuccess);
        return;
      }
    }
  };
}
