/**
 * The Reckoner — petitioner registry and petition() helper.
 *
 * v0 contract surface only. This apparatus stands up:
 *
 *   1. The kit-static petitioner registry (consumed from the
 *      `petitioners` kit-contribution type, validated at startup,
 *      sealed at `phase:started`).
 *   2. The `reckoner` block in `guild.json` (`enforceRegistration`,
 *      `disabledSources`), re-read on every call so operators can
 *      hot-edit without restarting the guild (D20).
 *   3. The canonical `petition()` / `withdraw()` helpers (Workflow
 *      2 in the contract document) — the `petition()` call posts a
 *      writ in `new` phase via `clerk.post()` and stamps
 *      `writ.ext['reckoner']` via `clerk.setWritExt()`. Two-step
 *      and non-atomic by design (D7).
 *   4. The inspection helpers — `isSourceRegistered`,
 *      `isSourceDisabled`, `listPetitioners` — surfaced as a
 *      coherent set on `provides` so the future CDC handler and
 *      any other downstream consumer can read the same registry
 *      and config the helpers see.
 *
 * The structural template for the kit-static registry is the
 * Clerk's `registerKitLinkKinds` (link-kind registry); the seal
 * pattern mirrors Clerk's writ-type registry. Diagnostic messages
 * intentionally echo Clerk's `[clerk] registerWritType:` shape
 * with a `[reckoner]` prefix so kit authors see a familiar shape.
 *
 * The Reckoner does NOT (in this commission):
 *   - subscribe to `clerk/writs` CDC events — that is the
 *     follow-on commission `w-mohuvpu2`.
 *   - emit Lattice pulses or write to a Reckonings book.
 *   - extend Clerk's `PostCommissionRequest` to carry an `ext`
 *     field, or wrap `petition()` in a Stacks transaction. The
 *     orphan window of the two-step flow is recorded as
 *     observation `obs-4` / `obs-5` for future consideration.
 *
 * See: docs/architecture/petitioner-registration.md (the
 * load-bearing contract document) and
 * docs/architecture/apparatus/reckoner.md (the apparatus shape).
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { ClerkApi, WritDoc, WritPhase } from '@shardworks/clerk-apparatus';

import type {
  PetitionRequest,
  PetitionerDescriptor,
  Priority,
  ReckonerApi,
  ReckonerConfig,
  ReckonerExt,
} from './types.ts';

import {
  DOMAIN_VALUES,
  SCOPE_VALUES,
  SEVERITY_VALUES,
  VISION_RELATION_VALUES,
} from './types.ts';

/**
 * Plugin id stamped on `writ.ext['reckoner']`. Hardcoded literal
 * (D11): the constant *is* the contract — every consumer keys on
 * this string.
 */
const RECKONER_PLUGIN_ID = 'reckoner';

/**
 * Grammar for the kebab-case suffix in a source id, after the
 * `{pluginId}.` prefix. Mirrors Clerk's KIND_SUFFIX_RE byte-for-
 * byte (D2). When a third consumer of this regex appears,
 * extracting a shared helper is observation `obs-6`.
 */
const SOURCE_SUFFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Contract default priority. Field-by-field merged with the
 * caller's `Partial<Priority>` so a petitioner specifying a single
 * dimension lets the rest fall through to defaults (D15).
 *
 * Kept internal — never exported (D14, patron override).
 */
function defaultPriority(): Priority {
  return {
    visionRelation: 'vision-neutral',
    severity: 'minor',
    scope: 'minor-area',
    time: { decay: false, deadline: null },
    domain: [],
  };
}

/**
 * Validate that the supplied `partial` priority's per-dimension
 * values, where present, are members of the declared enums. Throws
 * fail-loud (D9) — the call boundary is a trust boundary (anima
 * yields, JSON wire format), so types alone don't hold.
 */
function validatePriorityDimensions(partial: Partial<Priority>): void {
  if (partial.visionRelation !== undefined) {
    if (!(VISION_RELATION_VALUES as readonly string[]).includes(partial.visionRelation)) {
      throw new Error(
        `[reckoner] petition: priority.visionRelation must be one of ${VISION_RELATION_VALUES.map((v) => `"${v}"`).join(', ')}; got "${String(partial.visionRelation)}".`,
      );
    }
  }
  if (partial.severity !== undefined) {
    if (!(SEVERITY_VALUES as readonly string[]).includes(partial.severity)) {
      throw new Error(
        `[reckoner] petition: priority.severity must be one of ${SEVERITY_VALUES.map((v) => `"${v}"`).join(', ')}; got "${String(partial.severity)}".`,
      );
    }
  }
  if (partial.scope !== undefined) {
    if (!(SCOPE_VALUES as readonly string[]).includes(partial.scope)) {
      throw new Error(
        `[reckoner] petition: priority.scope must be one of ${SCOPE_VALUES.map((v) => `"${v}"`).join(', ')}; got "${String(partial.scope)}".`,
      );
    }
  }
  if (partial.time !== undefined) {
    const t = partial.time as { decay?: unknown; deadline?: unknown };
    if (typeof t !== 'object' || t === null) {
      throw new Error(
        `[reckoner] petition: priority.time must be an object with shape { decay: boolean, deadline: string | null }.`,
      );
    }
    if (t.decay !== undefined && typeof t.decay !== 'boolean') {
      throw new Error(
        `[reckoner] petition: priority.time.decay must be a boolean; got ${typeof t.decay}.`,
      );
    }
    if (t.deadline !== undefined && t.deadline !== null && typeof t.deadline !== 'string') {
      throw new Error(
        `[reckoner] petition: priority.time.deadline must be a string (ISO date) or null; got ${typeof t.deadline}.`,
      );
    }
  }
  if (partial.domain !== undefined) {
    if (!Array.isArray(partial.domain)) {
      throw new Error(
        `[reckoner] petition: priority.domain must be an array of domain tags; got ${typeof partial.domain}.`,
      );
    }
    for (const tag of partial.domain) {
      if (!(DOMAIN_VALUES as readonly string[]).includes(tag)) {
        throw new Error(
          `[reckoner] petition: priority.domain[] entries must be one of ${DOMAIN_VALUES.map((v) => `"${v}"`).join(', ')}; got "${String(tag)}".`,
        );
      }
    }
  }
}

/**
 * Field-by-field merge of caller-supplied `partial` against the
 * contract defaults. Mutating the result is safe — the defaults
 * are constructed fresh per call.
 */
function mergePriorityWithDefaults(partial: Partial<Priority> | undefined): Priority {
  const base = defaultPriority();
  if (!partial) return base;
  return {
    visionRelation: partial.visionRelation ?? base.visionRelation,
    severity: partial.severity ?? base.severity,
    scope: partial.scope ?? base.scope,
    time: partial.time !== undefined
      ? {
          decay: partial.time.decay ?? base.time.decay,
          deadline: partial.time.deadline !== undefined
            ? partial.time.deadline
            : base.time.deadline,
        }
      : base.time,
    domain: partial.domain !== undefined
      ? [...partial.domain]
      : base.domain,
  };
}

/**
 * Test-only hooks captured during `start()`. Surfaced through the
 * second return value of `createReckonerWithHooks()` so unit tests
 * can inspect the registry and exercise post-seal registration
 * paths without mounting a full Arbor lifecycle. Production code
 * uses `createReckoner()` and never sees this surface.
 */
export interface ReckonerTestHooks {
  /**
   * Register a `petitioners` kit entry through the same code path
   * the kit-contribution scan uses. Throws after seal (test for
   * the seal invariant).
   */
  registerKitPetitioners(kitEntry: { pluginId: string; value: unknown }): void;
  /** Whether the registry has sealed. */
  isSealed(): boolean;
  /** Force the registry into the sealed state — bypasses `phase:started`. */
  sealRegistry(): void;
}

/**
 * Internal builder. Returns both the apparatus plugin and a set of
 * test hooks closed over the same registry / config state. The
 * public `createReckoner()` factory throws away the hooks; the
 * `createReckonerWithHooks()` factory returns them.
 */
function buildReckoner(): { plugin: Plugin; hooks: ReckonerTestHooks } {
  // ── Registry state (closed over the factory) ──────────────────────
  //
  // The descriptor registry and seal flag mirror Clerk's writ-type
  // registry pattern (`writTypeRegistry` / `writTypeRegistrySealed`).
  // The map is built during start() from kit contributions; seal
  // happens at `phase:started`.

  /** Source → descriptor + contributing kit's plugin id (kept for diagnostics). */
  interface RegistryEntry {
    descriptor: PetitionerDescriptor;
    contributingPluginId: string;
  }

  const registry: Map<string, RegistryEntry> = new Map();
  let registrySealed = false;

  /**
   * Validate one `petitioners` kit entry and register it.
   *
   * Errors are wrapped with a `[reckoner]` prefix and name the
   * contributing kit so an operator can find the offending kit
   * package immediately. Mirrors the structural template from
   * Clerk's `registerKitLinkKinds`.
   */
  function registerKitPetitioners(kitEntry: { pluginId: string; value: unknown }): void {
    if (registrySealed) {
      throw new Error(
        `[reckoner] registerPetitioners: cannot register petitioners from kit "${kitEntry.pluginId}" — the startup registration window has closed. Petitioners must be contributed via the "petitioners" kit array before the framework fires phase:started.`,
      );
    }

    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[reckoner] Kit "${pluginId}" petitioners: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const source = rec.source;
      const description = rec.description;

      if (typeof source !== 'string' || source.length === 0) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry is missing a non-empty string "source" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry "${source}" is missing a non-empty string "description" field.`,
        );
      }

      const dotIdx = source.indexOf('.');
      if (dotIdx <= 0 || dotIdx === source.length - 1) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry "${source}" must be of the form "{pluginId}.{kebab-suffix}".`,
        );
      }
      const prefix = source.slice(0, dotIdx);
      const suffix = source.slice(dotIdx + 1);

      if (prefix !== pluginId) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry "${source}" has prefix "${prefix}" but must match the contributing plugin id "${pluginId}".`,
        );
      }

      if (!SOURCE_SUFFIX_RE.test(suffix)) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: entry "${source}" suffix "${suffix}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      const existing = registry.get(source);
      if (existing) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" petitioners: duplicate source "${source}" — already registered by kit "${existing.contributingPluginId}". Two kits cannot contribute a petitioner with the same source.`,
        );
      }

      registry.set(source, {
        descriptor: { source, description },
        contributingPluginId: pluginId,
      });
    }
  }

  // ── Config accessor ────────────────────────────────────────────────
  //
  // Re-read on every consumer call (D20). The block is missing-
  // equivalent when undefined; type mismatches in explicitly-set
  // values throw fail-loud (D12).

  /**
   * Read and validate the `reckoner` block from `guild.json`.
   *
   * Returns the populated `ReckonerConfig` (with defaults applied
   * for absent keys). Throws fail-loud when the block is present
   * but contains a typo / type mismatch.
   */
  function resolveConfig(): Required<ReckonerConfig> {
    const raw = guild().guildConfig().reckoner;
    if (raw === undefined || raw === null) {
      return { enforceRegistration: false, disabledSources: [] };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `[reckoner] guild config: "reckoner" must be an object; got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
      );
    }
    const block = raw as { enforceRegistration?: unknown; disabledSources?: unknown };

    let enforceRegistration = false;
    if (block.enforceRegistration !== undefined) {
      if (typeof block.enforceRegistration !== 'boolean') {
        throw new Error(
          `[reckoner] guild config: "reckoner.enforceRegistration" must be a boolean; got ${typeof block.enforceRegistration}.`,
        );
      }
      enforceRegistration = block.enforceRegistration;
    }

    let disabledSources: string[] = [];
    if (block.disabledSources !== undefined) {
      if (!Array.isArray(block.disabledSources)) {
        throw new Error(
          `[reckoner] guild config: "reckoner.disabledSources" must be an array of strings; got ${typeof block.disabledSources}.`,
        );
      }
      for (const entry of block.disabledSources) {
        if (typeof entry !== 'string') {
          throw new Error(
            `[reckoner] guild config: "reckoner.disabledSources[]" entries must be strings; got ${typeof entry}.`,
          );
        }
      }
      disabledSources = [...(block.disabledSources as string[])];
    }

    return { enforceRegistration, disabledSources };
  }

  // ── API surface ────────────────────────────────────────────────────

  let clerk: ClerkApi;

  const api: ReckonerApi = {
    isSourceRegistered(source: string): boolean {
      return registry.has(source);
    },

    isSourceDisabled(source: string): boolean {
      const config = resolveConfig();
      return config.disabledSources.includes(source);
    },

    listPetitioners(): PetitionerDescriptor[] {
      // Project to the contract floor only (D19) — `source` and
      // `description`. The contributing plugin id stays internal
      // unless a named consumer asks for it.
      return [...registry.values()].map((entry) => ({
        source: entry.descriptor.source,
        description: entry.descriptor.description,
      }));
    },

    async petition(request: PetitionRequest): Promise<WritDoc> {
      // ── Source resolution ────────────────────────────────────────
      const config = resolveConfig();
      const isRegistered = registry.has(request.source);

      if (!isRegistered) {
        if (config.enforceRegistration) {
          // Fail-loud without side-effect (D8): no writ created.
          throw new Error(
            `[reckoner] petition: source "${request.source}" is not registered. Registered sources: ${
              registry.size === 0
                ? '(none)'
                : [...registry.keys()].map((s) => `"${s}"`).join(', ')
            }. enforceRegistration is true; refusing to post.`,
          );
        }
        // Permissive mode: warn and proceed (D6).
        console.warn(
          `[reckoner] petition: source "${request.source}" is not registered; proceeding because reckoner.enforceRegistration is false.`,
        );
      }

      // ── Priority validation + default-fill ───────────────────────
      validatePriorityDimensions(request.priority ?? {});
      const priority = mergePriorityWithDefaults(request.priority);

      // ── Two-step post (D7) ───────────────────────────────────────
      // Step 1: clerk.post() with the writ-shape fields. The
      // optional type passes straight through (D21); when omitted
      // Clerk uses the guild-default writ type.
      const writ = await clerk.post({
        ...(request.type !== undefined ? { type: request.type } : {}),
        title: request.title,
        body: request.body,
        ...(request.codex !== undefined ? { codex: request.codex } : {}),
        ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
      });

      // Step 2: clerk.setWritExt() with the reckoner ext slot.
      // The `pluginId` argument is the hardcoded literal so the
      // contract slot key never drifts (D11). We only include
      // optional fields when the caller supplied them — otherwise
      // the ext is the minimum viable shape.
      const ext: ReckonerExt = {
        source: request.source,
        priority,
        ...(request.complexity !== undefined ? { complexity: request.complexity } : {}),
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
        ...(request.labels !== undefined ? { labels: request.labels } : {}),
      };

      return clerk.setWritExt(writ.id, RECKONER_PLUGIN_ID, ext);
    },

    async withdraw(writId: string, reason?: string): Promise<WritDoc> {
      // Thin pass-through (D10, D17). No source/owner/ext check;
      // reason passes through verbatim — undefined stays undefined.
      const cancelledPhase: WritPhase = 'cancelled';
      return clerk.transition(
        writId,
        cancelledPhase,
        reason !== undefined ? { resolution: reason } : {},
      );
    },
  };

  // ── Apparatus ──────────────────────────────────────────────────────

  const plugin: Plugin = {
    apparatus: {
      // `requires: ['clerk']` only (D16). No explicit Stacks
      // dependency — the topo sort handles transitives. No
      // `recommends` because no consumer of one exists in this
      // commission.
      requires: ['clerk'],

      // The Reckoner is the consumer of `petitioners` kit
      // contributions. Declaring `consumes` here suppresses the
      // Arbor's "no consumer" warning for kits contributing
      // `petitioners` arrays.
      consumes: ['petitioners'],

      provides: api,

      start(ctx: StartupContext): void {
        // Resolve the Clerk handle inside start() so the closure
        // captures the populated provides object — at this point
        // the `requires: ['clerk']` declaration has guaranteed
        // Clerk has already started.
        clerk = guild().apparatus<ClerkApi>('clerk');

        // Build the registry from `petitioners` kit contributions.
        // Hard-fail at any malformed entry (D4): a registry that
        // silently swallows drift is worse than a startup failure.
        for (const entry of ctx.kits('petitioners')) {
          registerKitPetitioners(entry);
        }

        // Seal the registry on the framework's `phase:started`
        // signal — the same moment Clerk seals its writ-type
        // registry (D5). Any post-seal registration attempt throws
        // a sealed-registry error patterned on Clerk's `[clerk]
        // registerWritType:` diagnostic (D5).
        ctx.on('phase:started', () => {
          registrySealed = true;
        });
      },
    },
  };

  const hooks: ReckonerTestHooks = {
    registerKitPetitioners,
    isSealed: () => registrySealed,
    sealRegistry: () => {
      registrySealed = true;
    },
  };

  return { plugin, hooks };
}

/**
 * The public factory. Returns the Reckoner apparatus as a
 * standard `Plugin`. Production code uses this entry point and
 * lets the framework drive `start()` / lifecycle.
 */
export function createReckoner(): Plugin {
  return buildReckoner().plugin;
}

/**
 * The test-only factory. Returns both the plugin (so the test can
 * drive `start()` against a fixture) and the internal hooks (so
 * the test can inspect the registry, force-seal, and exercise
 * post-seal registration). Not part of the package's public
 * surface — only `./index.ts` re-exports it for in-package tests.
 */
export function createReckonerWithHooks(): { plugin: Plugin; hooks: ReckonerTestHooks } {
  return buildReckoner();
}

/**
 * Internal helpers exported for tests. Not part of the public
 * package surface — the index file re-exports only the types and
 * the public factory.
 */
export const __internal = {
  defaultPriority,
  mergePriorityWithDefaults,
  validatePriorityDimensions,
  RECKONER_PLUGIN_ID,
  SOURCE_SUFFIX_RE,
};
