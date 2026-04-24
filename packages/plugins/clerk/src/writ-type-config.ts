/**
 * Writ-type configuration shape and structural validator.
 *
 * A `WritTypeConfig` describes a single writ type's state machine and
 * lifecycle behaviour: its named states, the permitted transitions between
 * them, and the aggregate "all children succeeded" / "any child failed"
 * triggers that lift terminal-child outcomes back to the parent. This module
 * declares the public TypeScript shape of that config and a pure structural
 * validator, `validateWritTypeConfig`.
 *
 * This module is the foundation of the broader writ-generalization refactor:
 * every plugin-registered writ type will pass through the validator before
 * becoming usable, and every downstream consumer (Clerk refactor,
 * children-behavior engine) imports these types. It is deliberately scoped
 * narrowly — no guild-config augmentation, no registration API, no
 * consumer-side side-effects.
 *
 * The validator throws a plain `Error` on the *first* structural violation.
 * No typed error class, no accumulated-error mode, no normalization: the
 * function is pure validation and returns `void` on success. Error messages
 * follow the in-tree animator precedent
 * (`[clerk] writTypeConfig.<path>: <problem>; received <value>`).
 */

// ── Vocabularies ─────────────────────────────────────────────────────

/**
 * A state's role in the writ-type lifecycle.
 *
 *   - `'initial'` — the state a newly-created writ starts in. Exactly one
 *     state per type must carry this classification.
 *   - `'active'`  — a non-terminal, non-initial state. Writs may enter and
 *     leave `active` states freely via declared transitions.
 *   - `'terminal'` — an absorbing state. Terminal states must not declare
 *     any outbound transitions.
 */
export type WritTypeStateClassification = 'initial' | 'active' | 'terminal';

/**
 * Known per-state attribute values. Attrs tag states with semantic meaning
 * that downstream consumers key on (e.g. the `success` attr identifies the
 * state a `childrenBehavior.allSuccess` trigger transitions the parent to
 * when the attr is implicitly resolved).
 *
 * The set below is the v0 vocabulary. For forward-compatibility the attrs
 * array accepts any string — consumers should treat unknown attrs as opaque
 * tags without special meaning. The named union is exported so editor
 * autocomplete surfaces the known values.
 */
export type KnownWritTypeStateAttr =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'stuck';

/**
 * The attrs vocabulary as surfaced on a state definition.
 *
 * Any `KnownWritTypeStateAttr` plus an open `string` escape hatch. Known
 * values autocomplete; unknown strings are accepted so plugin-contributed
 * writ types can declare new attrs without requiring a coordinated release.
 *
 * The `& {}` trick preserves the union in editor tooling while still
 * widening to `string` at the type-checker level.
 */
export type WritTypeStateAttr = KnownWritTypeStateAttr | (string & {});

// ── Shapes ───────────────────────────────────────────────────────────

/**
 * An action executed when a `childrenBehavior` trigger fires.
 *
 * `transition` is the required target state the parent writ should be
 * moved to when the trigger fires. `copyResolution` is an optional modifier
 * on that transition: when true, the consumer copies the triggering child's
 * resolution string onto the parent as part of the transition.
 *
 * Empty action objects and actions without a `transition` field are
 * structurally invalid.
 */
export interface WritTypeChildrenBehaviorAction {
  /** State the parent writ transitions to when the trigger fires. */
  transition: string;
  /**
   * When true, the consumer copies the triggering child's resolution string
   * onto the parent as part of the transition. Defaults to unset.
   */
  copyResolution?: boolean;
}

/**
 * Aggregate-children behaviour for a writ type.
 *
 * The v0 trigger set has exactly two named fields:
 *
 *   - `allSuccess` — fires when *every* child has reached a terminal state
 *     and *all* of them carry the `success` attr.
 *   - `anyFailure` — fires when *any* child reaches a terminal state that
 *     carries the `failure` attr.
 *
 * Both fields are optional. A config that declares neither trigger is
 * well-formed (no children-driven lifting). Adding a future trigger is a
 * pure additive change.
 */
export interface WritTypeChildrenBehavior {
  /** Fires when every child terminated successfully. */
  allSuccess?: WritTypeChildrenBehaviorAction;
  /** Fires when any child terminated in failure. */
  anyFailure?: WritTypeChildrenBehaviorAction;
}

/**
 * A single state in the writ-type's lifecycle machine.
 *
 * Each state carries its own name, classification, optional attribute tags,
 * and its outbound transition list. Outbound edges are placed per-state so
 * the shape is self-contained — a state definition fully describes every
 * edge that leaves it.
 */
export interface WritTypeStateDefinition {
  /** Unique (within this config) non-empty state name. */
  name: string;
  /** The state's role in the lifecycle. */
  classification: WritTypeStateClassification;
  /**
   * Optional semantic tags on this state. Known values autocomplete via
   * `KnownWritTypeStateAttr`; unknown strings are accepted so plugin-
   * contributed types can declare attrs without a coordinated release.
   */
  attrs?: WritTypeStateAttr[];
  /**
   * State names this state may transition to directly. Terminal states
   * must declare no outbound transitions; non-terminal states must declare
   * at least one reachable path to each configured `childrenBehavior`
   * target.
   */
  allowedTransitions: string[];
}

/**
 * A writ type's complete structural configuration.
 *
 * Every plugin-registered writ type is described by a single
 * `WritTypeConfig`. The config names the type, enumerates its states (with
 * per-state outbound edges and classifications), and optionally declares
 * aggregate children-driven behaviour.
 */
export interface WritTypeConfig {
  /** The writ type name. Non-empty. Format rules are enforced elsewhere. */
  name: string;
  /** The lifecycle states for this writ type. */
  states: WritTypeStateDefinition[];
  /** Optional aggregate-children-triggered behaviour. */
  childrenBehavior?: WritTypeChildrenBehavior;
}

// ── Validator ────────────────────────────────────────────────────────

/**
 * Valid classification values, used by both the classification check and
 * the reachability partition.
 */
const VALID_CLASSIFICATIONS: readonly WritTypeStateClassification[] = [
  'initial',
  'active',
  'terminal',
];

/**
 * Format a received value for an error message. Mirrors the animator
 * precedent's `String(value)` pattern but disambiguates `null`/`undefined`
 * so the path-based messages stay informative for the validator's callers.
 */
function formatReceived(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * Throw a validator error with the canonical `[clerk] writTypeConfig.<path>:
 * <problem>; received <value>` shape.
 */
function fail(path: string, problem: string, received: unknown): never {
  throw new Error(
    `[clerk] writTypeConfig.${path}: ${problem}; received ${formatReceived(received)}`,
  );
}

/**
 * Validate a `WritTypeConfig` for structural integrity.
 *
 * Throws on the *first* structural violation. Returns `void` on success;
 * the input is not normalized or rewritten. The checks, applied top-down:
 *
 *   1. `name` is a non-empty string.
 *   2. `states` is a non-empty array.
 *   3. Each state has a non-empty `name`, with no duplicates.
 *   4. Each state's `classification` is one of the three known values.
 *   5. Every `allowedTransitions` entry is a string referencing a state
 *      that exists in the same config.
 *   6. Exactly one state is classified `initial`.
 *   7. Every non-initial state has at least one inbound transition from
 *      some other state.
 *   8. No terminal state declares any outbound transitions.
 *   9. Every `childrenBehavior` trigger carries an action object with a
 *      non-empty `transition` string referencing a state that exists.
 *  10. Each `childrenBehavior` transition target is reachable from every
 *      non-terminal state of the config via `allowedTransitions`.
 *
 * Error messages take the shape `[clerk] writTypeConfig.<path>: <problem>;
 * received <value>` — e.g. `states[2].classification`,
 * `childrenBehavior.anyFailure.transition`.
 */
export function validateWritTypeConfig(config: WritTypeConfig): void {
  // ── Top-level shape ──────────────────────────────────────────────

  if (typeof config !== 'object' || config === null) {
    fail('', 'must be an object', config);
  }

  if (typeof config.name !== 'string' || config.name.length === 0) {
    fail('name', 'must be a non-empty string', config.name);
  }

  if (!Array.isArray(config.states)) {
    fail('states', 'must be an array', config.states);
  }

  if (config.states.length === 0) {
    fail('states', 'must contain at least one state', config.states);
  }

  // ── Per-state shape + name uniqueness ────────────────────────────

  const seenNames = new Set<string>();
  const stateIndexByName = new Map<string, number>();

  for (let i = 0; i < config.states.length; i += 1) {
    const state = config.states[i];
    const path = `states[${i}]`;

    if (typeof state !== 'object' || state === null) {
      fail(path, 'must be an object', state);
    }

    if (typeof state.name !== 'string' || state.name.length === 0) {
      fail(`${path}.name`, 'must be a non-empty string', state.name);
    }

    if (seenNames.has(state.name)) {
      fail(`${path}.name`, 'duplicate state name', state.name);
    }
    seenNames.add(state.name);
    stateIndexByName.set(state.name, i);

    if (!VALID_CLASSIFICATIONS.includes(state.classification)) {
      fail(
        `${path}.classification`,
        `must be one of ${VALID_CLASSIFICATIONS.join(', ')}`,
        state.classification,
      );
    }

    if (state.attrs !== undefined) {
      if (!Array.isArray(state.attrs)) {
        fail(`${path}.attrs`, 'must be an array when provided', state.attrs);
      }
      for (let a = 0; a < state.attrs.length; a += 1) {
        const attr = state.attrs[a];
        if (typeof attr !== 'string' || attr.length === 0) {
          fail(`${path}.attrs[${a}]`, 'must be a non-empty string', attr);
        }
      }
    }

    if (!Array.isArray(state.allowedTransitions)) {
      fail(`${path}.allowedTransitions`, 'must be an array', state.allowedTransitions);
    }

    for (let t = 0; t < state.allowedTransitions.length; t += 1) {
      const target = state.allowedTransitions[t];
      if (typeof target !== 'string' || target.length === 0) {
        fail(
          `${path}.allowedTransitions[${t}]`,
          'must be a non-empty string',
          target,
        );
      }
    }
  }

  // ── Transition-target existence ──────────────────────────────────

  for (let i = 0; i < config.states.length; i += 1) {
    const state = config.states[i];
    for (let t = 0; t < state.allowedTransitions.length; t += 1) {
      const target = state.allowedTransitions[t];
      if (!stateIndexByName.has(target)) {
        fail(
          `states[${i}].allowedTransitions[${t}]`,
          `references unknown state "${target}"`,
          target,
        );
      }
    }
  }

  // ── Exactly one initial state ────────────────────────────────────

  const initialIndices: number[] = [];
  for (let i = 0; i < config.states.length; i += 1) {
    if (config.states[i].classification === 'initial') initialIndices.push(i);
  }

  if (initialIndices.length === 0) {
    fail(
      'states',
      'must contain exactly one state with classification "initial" (found zero)',
      initialIndices.length,
    );
  }
  if (initialIndices.length > 1) {
    const names = initialIndices.map((i) => config.states[i].name);
    fail(
      'states',
      `must contain exactly one state with classification "initial" (found ${initialIndices.length}: ${names.join(', ')})`,
      initialIndices.length,
    );
  }

  // ── Terminal states declare no outbound transitions ──────────────

  for (let i = 0; i < config.states.length; i += 1) {
    const state = config.states[i];
    if (state.classification === 'terminal' && state.allowedTransitions.length > 0) {
      fail(
        `states[${i}].allowedTransitions`,
        `terminal state "${state.name}" must not declare any outbound transitions`,
        state.allowedTransitions,
      );
    }
  }

  // ── Inbound-transition coverage for non-initial states ───────────

  const inboundCount = new Map<string, number>();
  for (const state of config.states) {
    for (const target of state.allowedTransitions) {
      inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1);
    }
  }

  for (let i = 0; i < config.states.length; i += 1) {
    const state = config.states[i];
    if (state.classification === 'initial') continue;
    if ((inboundCount.get(state.name) ?? 0) === 0) {
      fail(
        `states[${i}]`,
        `non-initial state "${state.name}" must have at least one inbound transition`,
        state.name,
      );
    }
  }

  // ── childrenBehavior triggers ────────────────────────────────────

  const cb = config.childrenBehavior;
  if (cb !== undefined) {
    if (typeof cb !== 'object' || cb === null) {
      fail('childrenBehavior', 'must be an object when provided', cb);
    }

    const triggerNames = ['allSuccess', 'anyFailure'] as const;
    for (const triggerName of triggerNames) {
      const action = cb[triggerName];
      if (action === undefined) continue;

      const actionPath = `childrenBehavior.${triggerName}`;

      if (typeof action !== 'object' || action === null) {
        fail(actionPath, 'must be an object when provided', action);
      }

      if (Object.keys(action).length === 0) {
        fail(actionPath, 'must not be an empty object', action);
      }

      if (typeof action.transition !== 'string' || action.transition.length === 0) {
        fail(
          `${actionPath}.transition`,
          'must be a non-empty string',
          action.transition,
        );
      }

      if (!stateIndexByName.has(action.transition)) {
        fail(
          `${actionPath}.transition`,
          `references unknown state "${action.transition}"`,
          action.transition,
        );
      }

      if (action.copyResolution !== undefined && typeof action.copyResolution !== 'boolean') {
        fail(
          `${actionPath}.copyResolution`,
          'must be a boolean when provided',
          action.copyResolution,
        );
      }
    }

    // ── Reachability: each trigger target must be reachable from
    // every non-terminal state via allowedTransitions. ───────────
    const nonTerminalStates = config.states.filter(
      (s) => s.classification !== 'terminal',
    );

    // Compute reverse-reachability from each trigger target: BFS over
    // the reversed graph starts at the target and yields every state
    // from which the target is reachable. This is O(V + E) per target
    // — one traversal regardless of how many non-terminal states the
    // config declares.
    const reverseAdj = new Map<string, string[]>();
    for (const state of config.states) {
      for (const target of state.allowedTransitions) {
        const bucket = reverseAdj.get(target);
        if (bucket) {
          bucket.push(state.name);
        } else {
          reverseAdj.set(target, [state.name]);
        }
      }
    }

    function reverseReachable(from: string): Set<string> {
      const seen = new Set<string>([from]);
      const queue: string[] = [from];
      while (queue.length > 0) {
        const node = queue.shift()!;
        const preds = reverseAdj.get(node) ?? [];
        for (const pred of preds) {
          if (!seen.has(pred)) {
            seen.add(pred);
            queue.push(pred);
          }
        }
      }
      return seen;
    }

    for (const triggerName of triggerNames) {
      const action = cb[triggerName];
      if (action === undefined) continue;
      const target = action.transition;
      const reachableFrom = reverseReachable(target);
      for (const state of nonTerminalStates) {
        if (!reachableFrom.has(state.name)) {
          fail(
            `childrenBehavior.${triggerName}.transition`,
            `state "${target}" is not reachable from non-terminal state "${state.name}" via allowedTransitions`,
            target,
          );
        }
      }
    }
  }
}
