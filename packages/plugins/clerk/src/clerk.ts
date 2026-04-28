/**
 * The Clerk — writ lifecycle management apparatus.
 *
 * The Clerk manages the lifecycle of writs: lightweight work orders that
 * flow through a state machine declared by the writ's registered type.
 * Mandate is the type the Clerk plugin registers for itself — its lifecycle
 * (new → open → completed/failed/cancelled, with stuck as a non-terminal
 * "needs attention" state off open) is just one example of a registered
 * `WritTypeConfig`; other plugins contribute their own types and state
 * machines via `ClerkApi.registerWritType`. Each writ has a type, a title,
 * a body, and optional codex and resolution fields.
 *
 * Writ types are validated at registration time and at every transition.
 * `registerWritType` is the single-surface entry point — there is no kit-
 * contribution channel and no guild-config registry. An unknown type is
 * rejected at post time.
 *
 * See: docs/architecture/apparatus/clerk.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type { StacksApi, Book, WhereClause } from '@shardworks/stacks-apparatus';

import type {
  ClerkApi,
  ClerkConfig,
  WritDoc,
  WritLinkDoc,
  WritLinks,
  WritPhase,
  WritTypeInfo,
  PostCommissionRequest,
  EditWritRequest,
  WritFilters,
  KindEntry,
  LinkKindDoc,
  WritTree,
  WritTreeParams,
  WritWithPresentation,
} from './types.ts';

import { derivePresentation } from './writ-presentation.ts';

import type {
  WritTypeConfig,
  WritTypeStateClassification,
} from './writ-type-config.ts';
import { validateWritTypeConfig } from './writ-type-config.ts';
import { createChildrenBehaviorEngine } from './children-behavior-engine.ts';

import {
  commissionPost,
  stepAdd,
  writShow,
  writList,
  writTree,
  writEdit,
  writComplete,
  writFail,
  writCancel,
  writPublish,
  writLink,
  writUnlink,
  writLinkKinds,
  writLinkKindsShow,
} from './tools/index.ts';

import { normalizeLinkLabel } from './link-normalize.ts';

// ── Kit contribution interface ────────────────────────────────────────

/** Kit contribution interface for the Clerk's link kind registry. */
export interface ClerkKit {
  /**
   * Link-kind descriptors to register with the Clerk. Kind ids must be
   * prefixed with the contributing plugin id (e.g. `astrolabe.refines`).
   * Kit authors supply `{ id, description }`; the registry-projection view
   * (returned by `listKinds()`) embeds the resolved owner plugin id on each
   * record as `ownerPlugin`.
   */
  linkKinds?: KindEntry[];
}

// ── Built-in writ types ──────────────────────────────────────────────

/**
 * Mandate is the one writ type the Clerk plugin registers for itself.
 * The literal string is used here as the private fallback for
 * `resolveDefaultType()` and as the `name` field on `MANDATE_CONFIG`. There
 * is no single-source-of-truth export — the Clerk does not advertise
 * mandate as a privileged type; it is just a `WritTypeConfig` that happens
 * to be registered by the Clerk's own `start()`.
 */
const MANDATE_TYPE_NAME = 'mandate';

/**
 * Mandate's lifecycle as a first-class `WritTypeConfig`. Byte-faithful to
 * the prior hardcoded phase machine: `new` initial → open/cancelled;
 * `open` active → stuck/completed/failed/cancelled; `stuck` active (with
 * the `stuck` attr) → open/failed/cancelled; `completed` terminal with
 * the `success` attr; `failed` terminal with the `failure` attr;
 * `cancelled` terminal with the `cancelled` attr. The Clerk registers
 * this config during its own `start()` so mandate is present in the
 * registry on the same footing as any plugin-registered type.
 *
 * `childrenBehavior` opts mandate into both upward cascade directions
 * AND the downward parent-terminal cascade:
 *   - allSuccess     → completed  (copyResolution; upward)
 *   - anyFailure     → failed     (copyResolution; upward)
 *   - parentTerminal → cancelled  (static resolution; downward)
 *
 * The upward triggers' targets (`completed` / `failed`) are reachable
 * from every non-terminal mandate state (`new`, `open`, `stuck`) via
 * `allowedTransitions`, so the validator's reachability check accepts
 * the configuration. The triggering child's resolution string is
 * copied verbatim onto the parent.
 *
 * The downward `parentTerminal` trigger fires when a mandate parent
 * itself reaches a `failure`- or `cancelled`-attr terminal state and
 * cancels every non-terminal descendant with the canonical resolution
 * `Automatically cancelled due to parent termination`. The string is
 * declared inline rather than exported as a named constant — the
 * convention is per-type, not framework-wide. Because the trigger's
 * downstream target lives in *child* type configs, every potential
 * child type must declare `cancelled` reachable from each non-terminal
 * state via `allowedTransitions`; failures surface as fail-loud throws
 * from `api.transition` and roll back the Phase 1 transaction.
 *
 * Opting into `childrenBehavior` is *also* an opt-in to the cascade
 * engine's tripwire branch: a mandate writ cannot reach `completed`
 * (the only `success`-attr terminal in mandate's catalogue) while it
 * has any non-terminal descendant. This is an enforced invariant, not
 * a postcondition assumption — the engine throws inside the firing
 * transaction and Phase 1 atomicity rolls the offending transition
 * back so the bookkeeping gap is unrepresentable in the writs book.
 * The cascade engine's own `allSuccess` path enumerates every direct
 * sibling and requires terminal-success, so it can never land mandate
 * in this state; any path that does is a direct `clerk.transition()`
 * caller bypassing the cascade (`writ-complete`, plugin code, tests).
 * See the file-level docstring of `children-behavior-engine.ts` for
 * the firing rule and message shape.
 */
const MANDATE_CONFIG: WritTypeConfig = {
  name: MANDATE_TYPE_NAME,
  states: [
    {
      name: 'new',
      classification: 'initial',
      allowedTransitions: ['open', 'cancelled'],
    },
    {
      name: 'open',
      classification: 'active',
      allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'],
    },
    {
      name: 'stuck',
      classification: 'active',
      attrs: ['stuck'],
      allowedTransitions: ['open', 'failed', 'cancelled'],
    },
    {
      name: 'completed',
      classification: 'terminal',
      attrs: ['success'],
      allowedTransitions: [],
    },
    {
      name: 'failed',
      classification: 'terminal',
      attrs: ['failure'],
      allowedTransitions: [],
    },
    {
      name: 'cancelled',
      classification: 'terminal',
      attrs: ['cancelled'],
      allowedTransitions: [],
    },
  ],
  childrenBehavior: {
    allSuccess: { transition: 'completed', copyResolution: true },
    anyFailure: { transition: 'failed', copyResolution: true },
    parentTerminal: {
      transition: 'cancelled',
      resolution: 'Automatically cancelled due to parent termination',
    },
  },
};

// ── Factory ──────────────────────────────────────────────────────────

export function createClerk(): Plugin {
  let stacks: StacksApi;
  let writs: Book<WritDoc>;
  let links: Book<WritLinkDoc>;

  /** Internal metadata stored per registered link kind. */
  interface KindMeta {
    ownerPlugin: string;
    description: string;
  }

  /** Registry of kit-contributed link kinds, keyed by kind id. */
  let linkKindRegistry: Map<string, KindMeta> = new Map();

  // ── Writ-type registry ──────────────────────────────────────────────
  //
  // The runtime registry of plugin-registered writ-type state machines.
  // `registerWritType` is the only path for a plugin to contribute a writ
  // type; the registry is sealed at the framework's global `phase:started`
  // signal so registration is a startup-window-only operation. `sealed`
  // flips to `true` once the window closes — further calls throw.

  /** Internal entry shape — pairs the config with a coarse source tag. */
  interface WritTypeRegistryEntry {
    config: WritTypeConfig;
    /**
     * Origin of this registered type. `'builtin'` is reserved for mandate,
     * which the Clerk plugin registers from its own `start()`; every other
     * registered type carries `'plugin'`. The Clerk does not currently
     * track the calling plugin's id — `registerWritType` is invoked from
     * that plugin's `start()` and there is no implicit hand-off of the
     * caller's identity into the API.
     */
    source: 'builtin' | 'plugin';
  }

  /** Sealed registry of plugin-registered writ-type state machines. */
  const writTypeRegistry: Map<string, WritTypeRegistryEntry> = new Map();

  /** Whether the registry has sealed. Flipped by `phase:started`. */
  let writTypeRegistrySealed = false;

  /**
   * Internal registration helper used by both the public `registerWritType`
   * and the Clerk's own start()-time mandate registration. Centralises the
   * validate/seal/duplicate checks so the public API stays a thin wrapper
   * that defaults source to `'plugin'`.
   */
  function registerWritTypeInternal(
    config: WritTypeConfig,
    source: 'builtin' | 'plugin',
  ): void {
    // Validator errors propagate verbatim — their `[clerk]
    // writTypeConfig.<path>: <problem>` shape already names the offending
    // field precisely; wrapping would hide the path. Registration-specific
    // failures (sealed registry, duplicate name) are wrapped with a
    // `[clerk] registerWritType:` prefix so callers can distinguish the
    // two failure modes.
    validateWritTypeConfig(config);

    if (writTypeRegistrySealed) {
      throw new Error(
        `[clerk] registerWritType: cannot register writ type "${config.name}" — the startup registration window has closed. Plugins must call registerWritType from their apparatus's start() before the framework fires phase:started.`,
      );
    }

    const existing = writTypeRegistry.get(config.name);
    if (existing) {
      throw new Error(
        `[clerk] registerWritType: duplicate writ type "${config.name}" — already registered. Two plugins cannot contribute the same writ type name.`,
      );
    }

    writTypeRegistry.set(config.name, { config, source });
  }

  /**
   * Grammar for kind-id suffixes after the `{pluginId}.` prefix.
   *
   * Kebab-case only: lowercase letters, digits, and hyphens. Must not start
   * or end with a hyphen and must have at least one character.
   */
  const KIND_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  // ── Helpers ──────────────────────────────────────────────────────

  function resolveClerkConfig(): ClerkConfig {
    return guild().guildConfig().clerk ?? {};
  }

  function resolveDefaultType(): string {
    const config = resolveClerkConfig();
    return config.defaultType ?? MANDATE_TYPE_NAME;
  }

  /**
   * Return the classification of a writ's current state, looked up from its
   * type's registered `WritTypeConfig`. Throws with a fail-loud message
   * when the writ's type is not registered, or when its stored state is
   * not declared in that type's config (D6).
   */
  function classifyWritState(writ: WritDoc): 'initial' | 'active' | 'terminal' {
    const entry = writTypeRegistry.get(writ.type);
    if (!entry) {
      throw new Error(
        `[clerk] writ "${writ.id}" carries type "${writ.type}" which is not registered; registered types are ${
          writTypeRegistry.size === 0
            ? '(none)'
            : [...writTypeRegistry.keys()].map((n) => `"${n}"`).join(', ')
        }.`,
      );
    }
    const state = entry.config.states.find((s) => s.name === writ.phase);
    if (!state) {
      const legal = entry.config.states.map((s) => `"${s.name}"`).join(', ');
      throw new Error(
        `[clerk] writ "${writ.id}" carries state "${writ.phase}" which is not declared in type "${writ.type}" config; legal states are ${legal}.`,
      );
    }
    return state.classification;
  }

  /**
   * Return the state classified `initial` for a registered writ type, or
   * throw when the type is not registered. The validator guarantees
   * exactly-one `initial` state per registered config, so the find() is
   * total.
   */
  function resolveInitialState(typeName: string): string {
    const entry = writTypeRegistry.get(typeName);
    if (!entry) {
      throw new Error(
        `Unknown writ type "${typeName}". Registered types: ${
          writTypeRegistry.size === 0
            ? '(none)'
            : [...writTypeRegistry.keys()].join(', ')
        }.`,
      );
    }
    const initial = entry.config.states.find((s) => s.classification === 'initial');
    if (!initial) {
      // validateWritTypeConfig() enforces exactly-one `initial` state, so this
      // branch is only reachable if the validator's invariants regressed.
      throw new Error(
        `[clerk] writ type "${typeName}" has no initial state; the type config is malformed.`,
      );
    }
    return initial.name;
  }

  /**
   * Resolve the effective `type` filter according to T5/D7's implicit
   * mandate-scope rule: when `phase` is supplied without an explicit
   * `type`, the WHERE clause adds `type = 'mandate'` automatically so a
   * non-mandate writ that happens to declare an `open` state cannot
   * match `--phase open` unscoped to its type. The operator can override
   * by passing both `--type X --phase Y` together.
   */
  function resolveTypeFilter(
    filters?: { phase?: unknown; type?: string | string[] },
  ): string[] | undefined {
    if (filters?.type !== undefined) {
      return Array.isArray(filters.type) ? filters.type : [filters.type];
    }
    if (filters?.phase !== undefined) {
      return [MANDATE_TYPE_NAME];
    }
    return undefined;
  }

  /**
   * Map a (possibly-array) classification filter to the union of state
   * names that match it across the named types. Used to translate the
   * type-agnostic `classification` filter into a SQL-level `phase` IN
   * predicate. When no concrete types narrow the search, the union spans
   * every registered type's state catalogue.
   */
  function resolveClassificationStates(
    classification: WritTypeStateClassification | WritTypeStateClassification[],
    typeFilter?: string[],
  ): string[] {
    const requested = Array.isArray(classification) ? classification : [classification];
    const requestedSet = new Set(requested);
    const types = typeFilter && typeFilter.length > 0
      ? typeFilter
      : [...writTypeRegistry.keys()];
    const matching = new Set<string>();
    for (const typeName of types) {
      const entry = writTypeRegistry.get(typeName);
      if (!entry) continue;
      for (const state of entry.config.states) {
        if (requestedSet.has(state.classification)) {
          matching.add(state.name);
        }
      }
    }
    return [...matching];
  }

  function buildWhereClause(filters?: WritFilters): WhereClause | undefined {
    const conditions: WhereClause = [];

    // Resolve `type` first because the classification translator may
    // need it. Apply T5/D7's implicit mandate-scope rule: when `phase` is
    // supplied without an explicit `type`, scope to mandate.
    const effectiveType = resolveTypeFilter(filters);

    if (filters?.phase) {
      const phases = Array.isArray(filters.phase) ? filters.phase : [filters.phase];
      if (phases.length === 1) {
        conditions.push(['phase', '=', phases[0]!]);
      } else if (phases.length > 1) {
        conditions.push(['phase', 'IN', phases]);
      }
    }

    if (filters?.classification !== undefined) {
      const stateNames = resolveClassificationStates(
        filters.classification,
        effectiveType,
      );
      if (stateNames.length === 0) {
        // Closed-world: no registered state matches the requested
        // classification. Emit a sentinel predicate that never matches
        // (compares the indexed `phase` column to a string that is never
        // a valid state name). This is rare in practice — every
        // registered type declares at least one initial and one
        // terminal state — but the branch keeps the result stable.
        conditions.push(['phase', '=', '__no_match__']);
      } else if (stateNames.length === 1) {
        conditions.push(['phase', '=', stateNames[0]!]);
      } else {
        conditions.push(['phase', 'IN', stateNames]);
      }
    }

    if (effectiveType !== undefined) {
      if (effectiveType.length === 1) {
        conditions.push(['type', '=', effectiveType[0]!]);
      } else if (effectiveType.length > 1) {
        conditions.push(['type', 'IN', effectiveType]);
      }
    }

    if (filters?.parentId) {
      conditions.push(['parentId', '=', filters.parentId]);
    }
    return conditions.length > 0 ? conditions : undefined;
  }

  function registerKitLinkKinds(kitEntry: { pluginId: string; value: unknown }): void {
    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[clerk] Kit "${pluginId}" linkKinds: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      const description = rec.description;

      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry is missing a non-empty string "id" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" is missing a non-empty string "description" field.`,
        );
      }

      const dotIdx = id.indexOf('.');
      if (dotIdx <= 0 || dotIdx === id.length - 1) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" must be of the form "{pluginId}.{kebab-suffix}".`,
        );
      }
      const prefix = id.slice(0, dotIdx);
      const suffix = id.slice(dotIdx + 1);

      if (prefix !== pluginId) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" has prefix "${prefix}" but must match the contributing plugin id "${pluginId}".`,
        );
      }

      if (!KIND_SUFFIX_RE.test(suffix)) {
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: entry "${id}" suffix "${suffix}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      if (linkKindRegistry.has(id)) {
        const existing = linkKindRegistry.get(id)!;
        throw new Error(
          `[clerk] Kit "${pluginId}" linkKinds: duplicate kind id "${id}" — already registered by kit "${existing.ownerPlugin}".`,
        );
      }

      linkKindRegistry.set(id, {
        ownerPlugin: pluginId,
        description,
      });
    }
  }

  // ── Presentation helpers ──────────────────────────────────────────

  /**
   * Project a stored `WritDoc` onto its presentation shape — same fields,
   * plus the derived `classification` and `allowedTransitions`. Reads the
   * type-config registry through the closure; tolerant of unregistered
   * types and undeclared states (presentation-side fallback to
   * `'unknown'` per `derivePresentation`'s contract).
   */
  function presentWrit(writ: WritDoc): WritWithPresentation {
    const projection = derivePresentation(
      writ,
      (name) => writTypeRegistry.get(name)?.config,
    );
    return {
      ...writ,
      classification: projection.classification,
      allowedTransitions: projection.allowedTransitions,
    };
  }

  // ── Tree walker ──────────────────────────────────────────────────

  /**
   * Build a single `WritTree` rooted at `writId`. Returns null when the node
   * (or its subtree, after filters) is fully pruned. Mirrors ratchet's
   * `buildTree()`.
   *
   * Children are queried via the `parentId` index and recursed in
   * `createdAt asc` order so the visual order is stable across
   * sorts/filters at the page layer.
   */
  async function buildTree(
    writId: string,
    options?: {
      phaseSet?: Set<WritPhase>;
      typeSet?: Set<string>;
      classificationSet?: Set<WritTypeStateClassification>;
      depth?: number;
      currentDepth?: number;
    },
  ): Promise<WritTree | null> {
    const writ = await writs.get(writId);
    if (!writ) return null;

    const phaseSet = options?.phaseSet;
    const typeSet = options?.typeSet;
    const classificationSet = options?.classificationSet;
    const maxDepth = options?.depth;
    const currentDepth = options?.currentDepth ?? 0;

    // Prune: drop the node and its subtree when it fails any filter.
    if (phaseSet && !phaseSet.has(writ.phase as WritPhase)) return null;
    if (typeSet && !typeSet.has(writ.type)) return null;
    if (classificationSet) {
      // Translate the writ's stored phase to its classification through the
      // registry. Unknown-classification writs (unregistered type / undeclared
      // state) never satisfy the predicate — they prune.
      const projection = derivePresentation(writ, (name) =>
        writTypeRegistry.get(name)?.config,
      );
      if (
        projection.classification === 'unknown' ||
        !classificationSet.has(projection.classification)
      ) {
        return null;
      }
    }

    // Depth cap: include the node at the cap, but stop recursing.
    if (maxDepth !== undefined && currentDepth >= maxDepth) {
      return { writ: presentWrit(writ), children: [] };
    }

    const children = await writs.find({ where: [['parentId', '=', writId]] });
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const childTrees: WritTree[] = [];
    for (const child of children) {
      const childTree = await buildTree(child.id, {
        phaseSet,
        typeSet,
        depth: maxDepth,
        currentDepth: currentDepth + 1,
      });
      if (childTree) childTrees.push(childTree);
    }
    return { writ: presentWrit(writ), children: childTrees };
  }

  // ── API ──────────────────────────────────────────────────────────

  const api: ClerkApi = {
    async post(request: PostCommissionRequest): Promise<WritDoc> {
      const type = request.type ?? resolveDefaultType();

      // Registry lookup is the single source of truth for validity: a
      // post of an unregistered type fails here with the same message
      // shape callers expect.
      const initialPhase = resolveInitialState(type);

      const now = new Date().toISOString();
      const childId = generateId('w', 6);

      // Determine codex: explicit request > parent inheritance > undefined
      let codex = request.codex;

      if (request.parentId) {
        // Wrap in a transaction for atomicity
        return stacks.transaction(async (tx) => {
          const txWrits = tx.book<WritDoc>('clerk', 'writs');

          // Validate parent exists and is not in a terminal state. Acceptance
          // of children is now a purely classification-driven check: any
          // non-terminal state (initial or active) accepts children; terminal
          // states do not.
          const parent = await txWrits.get(request.parentId!);
          if (!parent) {
            throw new Error(`Parent writ "${request.parentId}" not found.`);
          }
          if (api.isTerminal(parent)) {
            throw new Error(
              `Cannot add children to writ "${request.parentId}": phase is "${parent.phase}" (terminal). Children can only be added to writs in non-terminal states.`,
            );
          }

          // Defensive self-parenting check
          if (request.parentId === childId) {
            throw new Error(`Cannot create a writ as its own parent.`);
          }

          // Inherit codex from parent if not specified
          if (codex === undefined && parent.codex !== undefined) {
            codex = parent.codex;
          }

          const writ: WritDoc = {
            id: childId,
            type,
            phase: initialPhase,
            title: request.title,
            body: request.body,
            ...(codex !== undefined ? { codex } : {}),
            parentId: request.parentId,
            createdAt: now,
            updatedAt: now,
          };

          await txWrits.put(writ);

          return writ;
        });
      }

      const writ: WritDoc = {
        id: childId,
        type,
        phase: initialPhase,
        title: request.title,
        body: request.body,
        ...(codex !== undefined ? { codex } : {}),
        createdAt: now,
        updatedAt: now,
      };

      await writs.put(writ);
      return writ;
    },

    async show(id: string): Promise<WritDoc> {
      const writ = await writs.get(id);
      if (!writ) {
        throw new Error(`Writ "${id}" not found.`);
      }
      return writ;
    },

    async resolveId(prefix: string): Promise<string> {
      // Exact-match fast path — avoids LIKE scans for full ids.
      const exact = await writs.get(prefix);
      if (exact) return exact.id;

      const results = await writs.find({ where: [['id', 'LIKE', prefix + '%']] });
      if (results.length === 0) {
        throw new Error(`No writ found matching prefix "${prefix}".`);
      }
      if (results.length > 1) {
        throw new Error(`Ambiguous prefix "${prefix}": matches ${results.length} writs.`);
      }
      return results[0].id;
    },

    async list(filters?: WritFilters): Promise<WritDoc[]> {
      const where = buildWhereClause(filters);
      const limit = filters?.limit ?? 20;
      const offset = filters?.offset;

      return writs.find({
        where,
        orderBy: ['createdAt', 'desc'],
        limit,
        ...(offset !== undefined ? { offset } : {}),
      });
    },

    async count(filters?: WritFilters): Promise<number> {
      const where = buildWhereClause(filters);
      return writs.count(where);
    },

    async countActive(): Promise<number> {
      // Walk the registry per call (D13) — no caching, no
      // post-seal memo. Drain runs at most once per terminal
      // transition; the walk is microseconds.
      //
      // Compose one OR-branch per registered type, each shaped as
      // `[type = T, phase IN [...activeStatesOf(T)]]`. The composite
      // `[type, phase]` index on the writs book serves the lookup.
      // Types with no `active` state contribute no branch; an empty
      // `or: []` list collapses to `count() === 0` (D2).
      const branches: WhereClause[] = [];
      for (const [typeName, entry] of writTypeRegistry.entries()) {
        const activeStates = entry.config.states
          .filter((s) => s.classification === 'active')
          .map((s) => s.name);
        if (activeStates.length === 0) continue;
        if (activeStates.length === 1) {
          branches.push([
            ['type', '=', typeName],
            ['phase', '=', activeStates[0]!],
          ]);
        } else {
          branches.push([
            ['type', '=', typeName],
            ['phase', 'IN', activeStates],
          ]);
        }
      }
      if (branches.length === 0) return 0;
      return writs.count({ or: branches });
    },

    async tree(params?: WritTreeParams): Promise<WritTree[]> {
      const phaseSet = params?.phase
        ? new Set(Array.isArray(params.phase) ? params.phase : [params.phase])
        : undefined;
      // Apply T5/D7's implicit mandate-scope at the tree layer too: when
      // `phase` is supplied without `type`, scope the type filter to
      // mandate so a non-mandate writ sharing a same-named state cannot
      // leak into the result.
      let typeSet: Set<string> | undefined = params?.type
        ? new Set(Array.isArray(params.type) ? params.type : [params.type])
        : undefined;
      if (typeSet === undefined && phaseSet !== undefined) {
        typeSet = new Set([MANDATE_TYPE_NAME]);
      }
      const classificationSet = params?.classification
        ? new Set(
            Array.isArray(params.classification)
              ? params.classification
              : [params.classification],
          )
        : undefined;
      const opts = { phaseSet, typeSet, classificationSet, depth: params?.depth };

      // Subtree mode — single root, root-slice params ignored.
      if (params?.rootId) {
        const tree = await buildTree(params.rootId, opts);
        return tree ? [tree] : [];
      }

      // Forest mode — find all roots (no parentId), then page across them.
      // We can't query parentId = undefined reliably across backends (some
      // store missing fields differently), so fetch and filter.
      const all = await writs.find({
        orderBy: ['createdAt', 'desc'],
        limit: 100000,
      });
      const rootDocs = all.filter((w) => !w.parentId);

      const rootOffset = params?.rootOffset ?? 0;
      const rootLimit = params?.rootLimit;
      const slicedRoots = rootLimit !== undefined
        ? rootDocs.slice(rootOffset, rootOffset + rootLimit)
        : rootDocs.slice(rootOffset);

      const forest: WritTree[] = [];
      for (const root of slicedRoots) {
        const tree = await buildTree(root.id, opts);
        if (tree) forest.push(tree);
      }
      return forest;
    },

    async countDescendantsByPhase(writId: string): Promise<Record<WritPhase, number>> {
      // Validate the root exists up front so callers get a clear error rather
      // than a silent zero-count result for an invalid id.
      const root = await writs.get(writId);
      if (!root) {
        throw new Error(`Writ "${writId}" not found.`);
      }

      const counts: Record<WritPhase, number> = {} as Record<WritPhase, number>;

      // Per-level recursive walk, mirroring ratchet's buildTree / collectDescendantIds.
      // Uses the existing `[parentId, phase]` composite index — no extra index needed.
      // No depth cap, no cycle guard; we trust the parentId-immutability invariant.
      async function walk(parentId: string): Promise<void> {
        const children = await writs.find({ where: [['parentId', '=', parentId]] });
        for (const child of children) {
          const phase = child.phase as WritPhase;
          counts[phase] = (counts[phase] ?? 0) + 1;
          await walk(child.id);
        }
      }

      await walk(writId);
      return counts;
    },

    async link(
      sourceId: string,
      targetId: string,
      label: string,
      kind?: string,
    ): Promise<WritLinkDoc> {
      if (sourceId === targetId) {
        throw new Error(`Cannot link a writ to itself: "${sourceId}".`);
      }

      // D2: normalize first, then reject empty canonical form. An all-
      // whitespace input canonicalizes to '' and is rejected here.
      const normalizedLabel = normalizeLinkLabel(label);
      if (!normalizedLabel) {
        throw new Error('Link label must be a non-empty string.');
      }

      // If a kind was supplied, validate it against the registry before
      // touching the store.
      if (kind !== undefined) {
        if (!linkKindRegistry.has(kind)) {
          throw new Error(
            `Unknown link kind "${kind}". Registered link kinds: ${
              linkKindRegistry.size === 0
                ? '(none)'
                : [...linkKindRegistry.keys()].join(', ')
            }.`,
          );
        }
      }

      const source = await writs.get(sourceId);
      if (!source) {
        throw new Error(`Writ "${sourceId}" not found.`);
      }
      const target = await writs.get(targetId);
      if (!target) {
        throw new Error(`Writ "${targetId}" not found.`);
      }

      const id = `${sourceId}:${targetId}:${normalizedLabel}`;
      const existing = await links.get(id);
      if (existing) {
        // Upsert: when the caller supplied a kind, update the existing row's
        // kind. When no kind was supplied, leave the existing row untouched
        // (preserves prior kind assignments made by earlier callers).
        if (kind !== undefined && existing.kind !== kind) {
          return links.patch(id, { kind });
        }
        return existing;
      }

      const doc: WritLinkDoc = {
        id,
        sourceId,
        targetId,
        label: normalizedLabel,
        kind: kind ?? null,
        createdAt: new Date().toISOString(),
      };
      await links.put(doc);
      return doc;
    },

    async links(writId: string): Promise<WritLinks> {
      const [outbound, inbound] = await Promise.all([
        links.find({ where: [['sourceId', '=', writId]] }),
        links.find({ where: [['targetId', '=', writId]] }),
      ]);
      return { outbound, inbound };
    },

    async unlink(sourceId: string, targetId: string, label: string): Promise<void> {
      // Normalize first so variant spellings of the same label resolve to the
      // same composite id as link() used.
      const normalizedLabel = normalizeLinkLabel(label);
      if (!normalizedLabel) {
        // No-op when the canonical form is empty — unlink() is idempotent, so
        // returning silently is correct even for an unreachable composite id.
        return;
      }
      const id = `${sourceId}:${targetId}:${normalizedLabel}`;
      await links.delete(id);
    },

    listWritTypes(): WritTypeInfo[] {
      const defaultType = resolveDefaultType();
      return [...writTypeRegistry.entries()].map(([name, entry]) => ({
        name,
        // The registered `WritTypeConfig` shape carries no description
        // field today; `description` is reserved on the public projection
        // for a future config field. T1 declined to widen `WritTypeConfig`
        // for this; surface `null` until the field exists.
        description: null,
        source: entry.source,
        isDefault: name === defaultType,
        // Project the state catalogue so consumers (the writs page, the
        // `nsg writ types` JSON output, etc.) can derive per-state
        // vocabulary without a second registry lookup. Attrs default to
        // an empty array so the projection shape is stable when a state
        // declares no semantic tags.
        states: entry.config.states.map((s) => ({
          name: s.name,
          classification: s.classification,
          attrs: [...(s.attrs ?? [])],
          allowedTransitions: [...s.allowedTransitions],
        })),
      }));
    },

    async listKinds(): Promise<LinkKindDoc[]> {
      return [...linkKindRegistry.entries()].map(([id, meta]) => ({
        id,
        ownerPlugin: meta.ownerPlugin,
        description: meta.description,
      }));
    },

    registerWritType(config: WritTypeConfig): void {
      registerWritTypeInternal(config, 'plugin');
    },

    getWritTypeConfig(name: string): WritTypeConfig | undefined {
      return writTypeRegistry.get(name)?.config;
    },

    isInitial(writ: WritDoc): boolean {
      return classifyWritState(writ) === 'initial';
    },

    isActive(writ: WritDoc): boolean {
      return classifyWritState(writ) === 'active';
    },

    isTerminal(writ: WritDoc): boolean {
      return classifyWritState(writ) === 'terminal';
    },

    async edit(request: EditWritRequest): Promise<WritDoc> {
      const writ = await writs.get(request.id);
      if (!writ) {
        throw new Error(`Writ "${request.id}" not found.`);
      }
      // Type and codex can only be changed while the writ is still a draft
      if (writ.phase !== 'new') {
        if (request.type !== undefined) {
          throw new Error(
            `Cannot change type on writ "${request.id}": phase is "${writ.phase}". Type can only be changed while the writ is in "new" phase.`,
          );
        }
        if (request.codex !== undefined) {
          throw new Error(
            `Cannot change codex on writ "${request.id}": phase is "${writ.phase}". Codex can only be changed while the writ is in "new" phase.`,
          );
        }
      }

      // Validate type if provided
      if (request.type !== undefined) {
        if (!writTypeRegistry.has(request.type)) {
          throw new Error(
            `Unknown writ type "${request.type}". Registered types: ${
              writTypeRegistry.size === 0
                ? '(none)'
                : [...writTypeRegistry.keys()].join(', ')
            }.`,
          );
        }
      }

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        updatedAt: new Date().toISOString(),
      };
      if (request.title !== undefined) patch.title = request.title;
      if (request.body !== undefined) patch.body = request.body;
      if (request.type !== undefined) patch.type = request.type;
      if (request.codex !== undefined) {
        // Empty string clears the codex
        if (request.codex === '') {
          patch.codex = undefined;
        } else {
          patch.codex = request.codex;
        }
      }

      return writs.patch(request.id, patch);
    },

    async transition(id: string, to: WritPhase, fields?: Partial<WritDoc>): Promise<WritDoc> {
      const writ = await writs.get(id);
      if (!writ) {
        throw new Error(`Writ "${id}" not found.`);
      }

      // `fields.phase` is a caller bug: the state machine owns `phase`.
      // Silent stripping hides the mistake; throw so the caller sees the
      // conflict. An empty string is treated as unset.
      if (fields && typeof (fields as { phase?: unknown }).phase === 'string' && (fields as { phase: string }).phase.length > 0) {
        throw new Error(
          `[clerk] transition: cannot override phase via fields argument`,
        );
      }

      // Per-type source-keyed enforcement read from the registry: the legal
      // transitions are those declared on the writ's current state, not a
      // target-keyed inverse table. Routes through classifyWritState so the
      // unknown-type / unknown-state diagnostics from D6 surface here too.
      const entry = writTypeRegistry.get(writ.type);
      if (!entry) {
        throw new Error(
          `[clerk] writ "${writ.id}" carries type "${writ.type}" which is not registered; registered types are ${
            writTypeRegistry.size === 0
              ? '(none)'
              : [...writTypeRegistry.keys()].map((n) => `"${n}"`).join(', ')
          }.`,
        );
      }
      const config = entry.config;
      const currentState = config.states.find((s) => s.name === writ.phase);
      if (!currentState) {
        const legal = config.states.map((s) => `"${s.name}"`).join(', ');
        throw new Error(
          `[clerk] writ "${writ.id}" carries state "${writ.phase}" which is not declared in type "${writ.type}" config; legal states are ${legal}.`,
        );
      }

      if (!currentState.allowedTransitions.includes(to)) {
        const legal = currentState.allowedTransitions.length === 0
          ? 'none (terminal state)'
          : currentState.allowedTransitions.map((s) => `"${s}"`).join(', ');
        throw new Error(
          `Cannot transition writ "${id}" from "${writ.phase}" to "${to}": legal transitions from "${writ.phase}" are ${legal}.`,
        );
      }

      const targetState = config.states.find((s) => s.name === to);
      if (!targetState) {
        // allowedTransitions entries are validated to reference declared
        // states, so this branch is unreachable unless the registry was
        // corrupted post-validate.
        throw new Error(
          `[clerk] writ type "${writ.type}" has no state "${to}"; the type config is malformed.`,
        );
      }

      const now = new Date().toISOString();
      const isTerminal = targetState.classification === 'terminal';

      // Strip managed fields — callers cannot override id, phase, the
      // plugin-owned observation slot `status`, the plugin-owned
      // metadata slot `ext`, or timestamps controlled by the phase
      // machine.
      //
      // Both `status` and `ext` are plugin-keyed maps (`Record<PluginId,
      // unknown>`) whose sub-slots are owned by different plugins. The
      // only slot-write paths that preserve sibling sub-slots under
      // concurrent writers are ClerkApi.setWritStatus(writId, pluginId,
      // value) for `status` and ClerkApi.setWritExt(writId, pluginId,
      // value) for `ext`, each performing a transactional read-modify-
      // write on the sub-slot keyed by pluginId. Because patch() is a
      // top-level shallow merge, a `status` or `ext` value smuggled
      // through transition() would wholesale-replace the slot and
      // silently clobber sibling sub-slots — so both are stripped here
      // alongside the other managed fields. There is exactly one
      // sanctioned slot-write path per slot: setWritStatus() and
      // setWritExt() respectively.
      //
      // `phase` is also stripped from the remainder (we throw above when
      // non-empty, but an empty-string phase key is still scrubbed here).
      const { id: _id, phase: _phase, status: _status, ext: _ext,
        createdAt: _c, updatedAt: _u,
        resolvedAt: _r, parentId: _p,
        ...safeFields } = (fields ?? {}) as WritDoc;

      const patch: Partial<Omit<WritDoc, 'id'>> = {
        phase: to,
        updatedAt: now,
        ...(isTerminal ? { resolvedAt: now } : {}),
        ...safeFields,
      };

      return writs.patch(id, patch);
    },

    async setWritStatus(writId: string, pluginId: string, value: unknown): Promise<WritDoc> {
      if (!writId) {
        throw new Error('setWritStatus: writId is required.');
      }
      if (!pluginId) {
        throw new Error('setWritStatus: pluginId is required.');
      }

      // Read-modify-write in a single transaction so we do not clobber
      // sibling sub-slots written concurrently by other plugins.
      return stacks.transaction(async (tx) => {
        const txWrits = tx.book<WritDoc>('clerk', 'writs');
        const existing = await txWrits.get(writId);
        if (!existing) {
          throw new Error(`Writ "${writId}" not found.`);
        }

        const prevStatus = (existing.status ?? {}) as Record<string, unknown>;
        const nextStatus: Record<string, unknown> = { ...prevStatus, [pluginId]: value };

        return txWrits.patch(writId, {
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        });
      });
    },

    async setWritExt(writId: string, pluginId: string, value: unknown): Promise<WritDoc> {
      if (!writId) {
        throw new Error('setWritExt: writId is required.');
      }
      if (!pluginId) {
        throw new Error('setWritExt: pluginId is required.');
      }

      // Read-modify-write in a single transaction so we do not clobber
      // sibling sub-slots written concurrently by other plugins.
      return stacks.transaction(async (tx) => {
        const txWrits = tx.book<WritDoc>('clerk', 'writs');
        const existing = await txWrits.get(writId);
        if (!existing) {
          throw new Error(`Writ "${writId}" not found.`);
        }

        const prevExt = (existing.ext ?? {}) as Record<string, unknown>;
        const nextExt: Record<string, unknown> = { ...prevExt, [pluginId]: value };

        return txWrits.patch(writId, {
          ext: nextExt,
          updatedAt: new Date().toISOString(),
        });
      });
    },
  };

  // ── writ-types tool ──────────────────────────────────────────────

  const writTypesTool = tool({
    name: 'writ-types',
    description: 'List available writ types for this guild',
    instructions:
      'Returns the writ types registered with the Clerk via ' +
      '`registerWritType`, including the Clerk\'s own `mandate`. Each entry ' +
      'reports the type name, source (`builtin` or `plugin`), and whether ' +
      'it is the default type.',
    params: {},
    permission: 'read',
    handler: async () => api.listWritTypes(),
  });

  // ── Apparatus ────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks'],
      recommends: ['oculus'],
      consumes: ['linkKinds'],

      supportKit: {
        books: {
          writs: {
            indexes: ['phase', 'type', 'createdAt', 'parentId', ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase']],
          },
          links: {
            indexes: ['sourceId', 'targetId', 'label', ['sourceId', 'label'], ['targetId', 'label']],
          },
        },
        tools: [
          commissionPost,
          stepAdd,
          writShow,
          writList,
          writTree,
          writEdit,
          writComplete,
          writFail,
          writCancel,
          writPublish,
          writLink,
          writUnlink,
          writLinkKinds,
          writLinkKindsShow,
          writTypesTool,
        ],
        pages: [
          { id: 'writs', title: 'Writs', dir: 'pages/writs' },
        ],
      },

      provides: api,

      async start(ctx: StartupContext): Promise<void> {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        writs = stacks.book<WritDoc>('clerk', 'writs');
        links = stacks.book<WritLinkDoc>('clerk', 'links');

        // ── Children-behavior cascade engine ───────────────────────────
        //
        // Phase 1 watch on the writs book: when any writ transitions to a
        // terminal state, evaluate the parent's `WritTypeConfig.children
        // Behavior` block and apply the configured action via
        // `api.transition`. The engine is generic in writ type — types
        // that omit the block are silent no-ops; mandate is the only
        // built-in opt-in today. failOnError: true means cascade writes
        // join the triggering transaction, mirroring Spider's writ↔rig
        // cascade. Grandparent lift is natural recursion via Stacks'
        // re-fire on the parent's own update event.
        const childrenBehaviorHandler = createChildrenBehaviorEngine({
          writs,
          getWritTypeConfig: (name: string) => writTypeRegistry.get(name)?.config,
          isTerminal: (writ: WritDoc) => api.isTerminal(writ),
          transition: (id: string, to, fields) => api.transition(id, to, fields),
          setWritStatus: (writId: string, pluginId: string, value: unknown) =>
            api.setWritStatus(writId, pluginId, value),
        });
        stacks.watch<WritDoc>('clerk', 'writs', childrenBehaviorHandler, {
          failOnError: true,
        });

        // Seal the writ-type registration window on the framework's global
        // `phase:started` signal — that moment fires once, after every
        // apparatus's `start()` has completed, which mirrors how stacks seals
        // its CDC watcher registry. Per-apparatus `apparatus:started` events
        // fire too early to catch every contributor, and we want plugins to
        // be able to register types from their own `start()` regardless of
        // dependency ordering.
        //
        // The same handler validates `clerk.defaultType` against the now-
        // sealed registry: by the time `phase:started` fires, every
        // plugin's `start()` has run, so any plugin-contributed type the
        // operator named as default has had its chance to register. A
        // missing default type is a startup error.
        ctx.on('phase:started', () => {
          writTypeRegistrySealed = true;

          const clerkConfig = resolveClerkConfig();
          if (
            clerkConfig.defaultType !== undefined &&
            !writTypeRegistry.has(clerkConfig.defaultType)
          ) {
            throw new Error(
              `[clerk] guild config: defaultType "${clerkConfig.defaultType}" is not a registered writ type. Registered types: ${
                writTypeRegistry.size === 0
                  ? '(none)'
                  : [...writTypeRegistry.keys()].join(', ')
              }.`,
            );
          }
        });

        // Register the built-in `mandate` writ type with the new registry.
        // `post()` and `transition()` route through the registry; mandate is
        // the one type the Clerk plugin contributes for itself.
        registerWritTypeInternal(MANDATE_CONFIG, 'builtin');

        // Scan all kit-contributed link kinds via the Wire-phase snapshot.
        // Malformed entries hard-fail the start() call — a reserved kind id
        // that silently disappears would be worse than a startup failure,
        // because downstream consumers key on it.
        linkKindRegistry = new Map();
        for (const entry of ctx.kits('linkKinds')) {
          registerKitLinkKinds(entry);
        }

        // ── One-shot migration: rename `status` → `phase`, subsume legacy values ──
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start().
        //
        // Every pre-rename row carries its lifecycle value in `status`.
        // Post-rename rows carry `phase` instead, and `status` becomes the
        // plugin-owned observation slot. We iterate every row, compute a
        // clean post-rename document, and `put()` it back — `patch()` can't
        // remove a field, so the full rewrite is required.
        //
        // Legacy lifecycle values (`ready`, `active`, `waiting`) are
        // collapsed into `open` along the way (this subsumes the older
        // `legacyStatuses` migration). Any unrecognized value aborts
        // startup — unknown phase is a data-integrity issue.
        const LEGACY_COLLAPSE: Record<string, WritPhase> = {
          ready: 'open',
          active: 'open',
          waiting: 'open',
        };
        const VALID_PHASES = new Set<WritPhase>([
          'new', 'open', 'stuck', 'completed', 'failed', 'cancelled',
        ]);

        const allWrits = await writs.find({});
        for (const row of allWrits) {
          // Already migrated — skip (idempotent).
          if (typeof (row as { phase?: unknown }).phase === 'string') continue;

          const legacyStatus = (row as { status?: unknown }).status;
          if (typeof legacyStatus !== 'string') {
            throw new Error(
              `[clerk] Migration: writ "${row.id}" has neither \`phase\` nor a string \`status\` field; cannot migrate (got ${legacyStatus === undefined ? 'undefined' : typeof legacyStatus}).`,
            );
          }

          let nextPhase: WritPhase;
          if (LEGACY_COLLAPSE[legacyStatus]) {
            nextPhase = LEGACY_COLLAPSE[legacyStatus];
          } else if (VALID_PHASES.has(legacyStatus as WritPhase)) {
            nextPhase = legacyStatus as WritPhase;
          } else {
            throw new Error(
              `[clerk] Migration: writ "${row.id}" has unrecognized status value "${legacyStatus}". Expected one of: ${[...VALID_PHASES].join(', ')} (or legacy: ${Object.keys(LEGACY_COLLAPSE).join(', ')}).`,
            );
          }

          // Build a clean post-rename document — no `status` key, `phase`
          // set. `updatedAt` is preserved exactly as stored (this is a
          // storage-format change, not a logical edit).
          const migrated: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            if (k === 'status') continue;
            migrated[k] = v;
          }
          migrated.phase = nextPhase;
          await writs.put(migrated as WritDoc);
        }

        // ── One-shot migration: normalize link rows ──────────────────
        // Two-pass flow per D7:
        //   Pass 1 — scan every link row, group by (sourceId, targetId,
        //     normalizedLabel). A group with multiple rows is a collision:
        //     variant spellings that collapse to the same canonical form.
        //   Pass 2 — per group, keep the row with the earliest createdAt;
        //     warn and delete the younger siblings (older wins,
        //     deterministic regardless of iteration order). Rewrite the
        //     survivor's id and label to the canonical form and set
        //     `kind = null` when absent.
        //
        // Safe to run inside start(): stacks only seals the CDC registry
        // at phase:started (after every apparatus has started), so these
        // writes don't lock out downstream apparatuses that register
        // watchers in their own start(). Writes here fire no links-book
        // watcher today but could in the future.
        const allLinks = await links.find({});
        const groups = new Map<string, WritLinkDoc[]>();
        for (const row of allLinks) {
          const normalized = normalizeLinkLabel(row.label);
          const key = `${row.sourceId}:${row.targetId}:${normalized}`;
          const bucket = groups.get(key) ?? [];
          bucket.push(row);
          groups.set(key, bucket);
        }

        for (const [canonicalId, bucket] of groups) {
          // Sort by createdAt ascending — the first element is the oldest.
          bucket.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
          const [survivor, ...losers] = bucket;
          if (!survivor) continue;

          for (const loser of losers) {
            console.warn(
              `[clerk] Link migration: collapsing duplicate link ` +
                `"${loser.id}" into canonical "${canonicalId}" ` +
                `(source="${loser.sourceId}", target="${loser.targetId}"); ` +
                `older row kept, this one discarded.`,
            );
            await links.delete(loser.id);
          }

          const normalizedLabel = canonicalId.slice(
            (survivor.sourceId.length + 1) + (survivor.targetId.length + 1),
          );
          const needsRewrite =
            survivor.id !== canonicalId ||
            survivor.label !== normalizedLabel ||
            survivor.kind === undefined;

          if (!needsRewrite) continue;

          // The composite id is immutable — delete-then-put the survivor to
          // replace it with the canonical document.
          const migrated: WritLinkDoc = {
            id: canonicalId,
            sourceId: survivor.sourceId,
            targetId: survivor.targetId,
            label: normalizedLabel,
            kind: survivor.kind ?? null,
            createdAt: survivor.createdAt,
          };
          if (survivor.id !== canonicalId) {
            await links.delete(survivor.id);
          }
          await links.put(migrated);
        }
      },
    },
  };
}
