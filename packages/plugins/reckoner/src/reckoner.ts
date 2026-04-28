/**
 * The Reckoner — petition-scheduler apparatus.
 *
 * This apparatus stands up:
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
 *      coherent set on `provides` so the CDC handler and any other
 *      downstream consumer can read the same registry and config
 *      the helpers see.
 *   5. The Reckonings book (`reckoner/reckonings`) — declared via
 *      `supportKit.books` so the Stacks Wire phase materialises it
 *      with the contract index set; the auto-wired
 *      `book.reckoner.reckonings.{created,updated,deleted}`
 *      Clockworks events fire normally (no carve-out).
 *   6. A Phase 2 CDC handler on `clerk/writs` that observes update
 *      events on held petitions (writs in `new` phase carrying
 *      `ext.reckoner`), runs the rule sequence (skip / disabled /
 *      source-check / scheduler-evaluate), drives
 *      `clerk.transition()` on accept or decline, and idempotently
 *      appends one Reckonings row per consideration. v0's stub is
 *      always-approve; the only decline path is the source-
 *      unregistered + `enforceRegistration: true` rule.
 *   7. A startup catch-up scan that re-routes pre-existing held
 *      petitions through the same handler at boot.
 *
 * The structural template for the kit-static registry is the
 * Clerk's `registerKitLinkKinds` (link-kind registry); the seal
 * pattern mirrors Clerk's writ-type registry. Diagnostic messages
 * intentionally echo Clerk's `[clerk] registerWritType:` shape
 * with a `[reckoner]` prefix so kit authors see a familiar shape.
 * The CDC handler's idempotency strategy (persisted dedupe via the
 * `[writId, consideredAt]` index plus in-process `writUpdatedAt`
 * filter) mirrors the Sentinel apparatus's `alreadyEmitted` pattern.
 *
 * The Reckoner does NOT (in this commission):
 *   - emit Lattice pulses (the auto-wired Clockworks events on the
 *     reckonings book are sufficient for v0 consumers).
 *   - extend Clerk's `PostCommissionRequest` to carry an `ext`
 *     field, or wrap `petition()` in a Stacks transaction. The
 *     orphan window of the two-step flow is recorded as
 *     observation `obs-4` / `obs-5` for future consideration.
 *   - implement deferral, no-op, throttling, or per-source quotas —
 *     all reserved for future commissions.
 *
 * See: docs/architecture/petitioner-registration.md (the
 * load-bearing contract document),
 * docs/architecture/reckonings-book.md (the Reckonings book schema
 * and CDC contract), and
 * docs/architecture/apparatus/reckoner.md (the apparatus shape).
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type {
  Book,
  ChangeEvent,
  ReadOnlyBook,
  StacksApi,
} from '@shardworks/stacks-apparatus';
import type {
  ClerkApi,
  WritDoc,
  WritPhase,
  WritTypeConfig,
} from '@shardworks/clerk-apparatus';

import type {
  PetitionExtRequest,
  PetitionRequest,
  PetitionerDescriptor,
  Priority,
  ReckonerApi,
  ReckonerConfig,
  ReckonerExt,
  ReckoningDoc,
  Scheduler,
  SchedulerDecision,
} from './types.ts';

import {
  DOMAIN_VALUES,
  SCOPE_VALUES,
  SEVERITY_VALUES,
  VISION_RELATION_VALUES,
} from './types.ts';

import { alwaysApproveScheduler } from './schedulers/always-approve.ts';

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
  /**
   * Register a `schedulers` kit entry through the same code path
   * the kit-contribution scan uses. Throws after seal (test for
   * the seal invariant).
   */
  registerKitSchedulers(kitEntry: { pluginId: string; value: unknown }): void;
  /** Whether the petitioner registry has sealed. */
  isSealed(): boolean;
  /** Force the registry into the sealed state — bypasses `phase:started`. */
  sealRegistry(): void;
  /**
   * Drive the CDC handler directly with a synthetic `ChangeEvent`.
   * Used by `reckoner-cdc.test.ts` to exercise the rule sequence,
   * the dedupe path, and the re-firing gate without driving Stacks'
   * watcher machinery.
   */
  handleWritsChange(event: ChangeEvent<WritDoc>): Promise<void>;
  /**
   * Run the startup catch-up scan on demand. Used to test that
   * held petitions are processed at boot and that running the scan
   * twice does not produce duplicate Reckonings rows.
   */
  runCatchUpScan(): Promise<void>;
  /**
   * Return the resolved active scheduler's id, or `undefined` when
   * the registry has not yet sealed (D32). Tests assert this against
   * the unset-defaults-to-always-approve and set-explicit-id paths.
   */
  getActiveSchedulerId(): string | undefined;
  /**
   * Return the sorted list of registered scheduler ids (D32). Used
   * by the unregistered-selector test to assert the diagnostic
   * names every registered id.
   */
  getRegisteredSchedulerIds(): string[];
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

  // ── Scheduler registry (D9) ────────────────────────────────────────
  //
  // Sibling of the petitioner registry. Same closure-scoped map
  // pattern; same seal flag pattern; same `[reckoner] Kit "<id>"
  // schedulers:` diagnostic shape (D11). The Reckoner contributes
  // the built-in `reckoner.always-approve` instance via
  // `apparatus.supportKit.schedulers`, which surfaces through
  // `ctx.kits('schedulers')` exactly like a user-contributed kit
  // (D29) — there is no special-cased default-bypass.
  //
  // The active scheduler is resolved at `phase:started` from
  // `guild.json reckoner.scheduler` (D14). Its closure-local
  // reference is set in `start()`; see the seal handler.

  /** Scheduler id → instance + contributing kit's plugin id. */
  interface SchedulerRegistryEntry {
    scheduler: Scheduler;
    contributingPluginId: string;
  }

  const schedulerRegistry: Map<string, SchedulerRegistryEntry> = new Map();
  let schedulerRegistrySealed = false;

  /**
   * Closure-local handle to the resolved active scheduler.
   * Populated on the framework's `phase:started` signal (D14) after
   * the registry seals; remains `undefined` until then so CDC
   * events arriving pre-seal are silently skipped (D35) — the
   * catch-up scan reprocesses them post-seal.
   */
  let activeScheduler: Scheduler | undefined;

  /**
   * Validate one `schedulers` kit entry and register it. Mirrors
   * `registerKitPetitioners` byte-faithfully (D10): array typeof,
   * full-shape entry check, dot-split + prefix-match + suffix-regex,
   * dedupe naming both kits, fail-loud on post-seal registration.
   *
   * The diagnostic-prefix shape follows D11 — `[reckoner] Kit
   * "<id>" schedulers:` for per-entry validation, `[reckoner]
   * registerSchedulers:` for sealed-registry errors.
   */
  function registerKitSchedulers(kitEntry: { pluginId: string; value: unknown }): void {
    if (schedulerRegistrySealed) {
      throw new Error(
        `[reckoner] registerSchedulers: cannot register schedulers from kit "${kitEntry.pluginId}" — the startup registration window has closed. Schedulers must be contributed via the "schedulers" kit array before the framework fires phase:started.`,
      );
    }

    const pluginId = kitEntry.pluginId;
    const raw = kitEntry.value;
    if (!Array.isArray(raw)) {
      throw new Error(
        `[reckoner] Kit "${pluginId}" schedulers: expected an array, got ${typeof raw}.`,
      );
    }

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry is not an object (got ${entry === null ? 'null' : typeof entry}).`,
        );
      }
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      const description = rec.description;
      const evaluate = rec.evaluate;
      const validateConfig = rec.validateConfig;

      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry is missing a non-empty string "id" field.`,
        );
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" is missing a non-empty string "description" field.`,
        );
      }
      if (typeof evaluate !== 'function') {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" "evaluate" must be a function; got ${typeof evaluate}.`,
        );
      }
      if (validateConfig !== undefined && typeof validateConfig !== 'function') {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" "validateConfig" must be a function or omitted; got ${typeof validateConfig}.`,
        );
      }

      const dotIdx = id.indexOf('.');
      if (dotIdx <= 0 || dotIdx === id.length - 1) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" must be of the form "{pluginId}.{kebab-suffix}".`,
        );
      }
      const prefix = id.slice(0, dotIdx);
      const suffix = id.slice(dotIdx + 1);

      if (prefix !== pluginId) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" has prefix "${prefix}" but must match the contributing plugin id "${pluginId}".`,
        );
      }

      if (!SOURCE_SUFFIX_RE.test(suffix)) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: entry "${id}" suffix "${suffix}" must be kebab-case (lowercase letters, digits, and hyphens, not starting or ending with "-").`,
        );
      }

      const existing = schedulerRegistry.get(id);
      if (existing) {
        throw new Error(
          `[reckoner] Kit "${pluginId}" schedulers: duplicate id "${id}" — already registered by kit "${existing.contributingPluginId}". Two kits cannot contribute a scheduler with the same id.`,
        );
      }

      schedulerRegistry.set(id, {
        scheduler: entry as Scheduler,
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
   * Concrete shape returned by `resolveConfig`. Intentionally not
   * `Required<ReckonerConfig>` — the scheduler-selector fields
   * (`scheduler`, `schedulerConfig`) live on the same config block
   * but are read through different accessors with different cadences.
   */
  interface ResolvedReckonerConfig {
    enforceRegistration: boolean;
    disabledSources: string[];
  }

  /**
   * Read and validate the `reckoner` block from `guild.json`.
   *
   * Returns the populated `ReckonerConfig` (with defaults applied
   * for absent keys). Throws fail-loud when the block is present
   * but contains a typo / type mismatch.
   */
  function resolveConfig(): ResolvedReckonerConfig {
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

  /**
   * Re-read the `reckoner.schedulerConfig` slot per evaluation (D17).
   * No narrowing happens here — each `Scheduler.validateConfig` is
   * the trust boundary. Returns `undefined` when the slot is absent.
   */
  function resolveSchedulerConfig(): unknown {
    const raw = guild().guildConfig().reckoner;
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        `[reckoner] guild config: "reckoner" must be an object; got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
      );
    }
    return (raw as { schedulerConfig?: unknown }).schedulerConfig;
  }

  /**
   * Resolve the active scheduler from the registry. Called once on
   * the framework's `phase:started` signal (D14) immediately after
   * the registry seals so any selector misconfiguration surfaces at
   * startup rather than on the first considered writ.
   *
   * Behavior:
   *   - **Unset selector** (D15): default to `reckoner.always-approve`
   *     and emit one info log line.
   *   - **Set but unregistered** (D16): throw fail-loud with a
   *     diagnostic listing every registered id.
   *   - **Bad type on the selector field**: throw fail-loud with the
   *     `[reckoner] guild config: scheduler ...` prefix.
   */
  function resolveActiveScheduler(): Scheduler {
    const raw = guild().guildConfig().reckoner;
    let selector: string | undefined;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(
          `[reckoner] guild config: "reckoner" must be an object; got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
        );
      }
      const block = raw as { scheduler?: unknown };
      if (block.scheduler !== undefined) {
        if (typeof block.scheduler !== 'string' || block.scheduler.length === 0) {
          throw new Error(
            `[reckoner] guild config: scheduler must be a non-empty string; got ${typeof block.scheduler}.`,
          );
        }
        selector = block.scheduler;
      }
    }

    if (selector === undefined) {
      const fallback = schedulerRegistry.get('reckoner.always-approve');
      if (!fallback) {
        // Defensive — the apparatus contributes the always-approve
        // scheduler via its own supportKit, so absence here would
        // mean the kit wiring is broken.
        throw new Error(
          `[reckoner] guild config: scheduler default "reckoner.always-approve" is not registered. The Reckoner's supportKit contribution did not surface in ctx.kits('schedulers').`,
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        `[reckoner] no reckoner.scheduler configured; defaulting to "reckoner.always-approve".`,
      );
      return fallback.scheduler;
    }

    const entry = schedulerRegistry.get(selector);
    if (!entry) {
      const ids = [...schedulerRegistry.keys()].sort();
      throw new Error(
        `[reckoner] guild config: scheduler "${selector}" is not registered. Registered schedulers: ${
          ids.length === 0 ? '(none)' : ids.map((id) => `"${id}"`).join(', ')
        }.`,
      );
    }
    return entry.scheduler;
  }

  // ── API surface ────────────────────────────────────────────────────

  let clerk: ClerkApi;
  let stacks: StacksApi | undefined;
  let reckoningsBook: Book<ReckoningDoc> | undefined;

  /**
   * Compute the type-aware target active phase for a writ at
   * transition time (D5). Walks the current state's
   * `allowedTransitions` and picks the candidate classified as
   * `active`. Throws fail-loud on ambiguity (more than one active
   * candidate) or a missing config — the Reckoner refuses to guess
   * which `open`-equivalent state to drive the writ into.
   */
  function resolveActiveTargetPhase(writ: WritDoc): string {
    const config: WritTypeConfig | undefined = clerk.getWritTypeConfig(writ.type);
    if (!config) {
      throw new Error(
        `[reckoner] cdc: writ "${writ.id}" has type "${writt(writ)}" with no registered WritTypeConfig — refusing to choose an acceptance target.`,
      );
    }
    const currentState = config.states.find((s) => s.name === writ.phase);
    if (!currentState) {
      throw new Error(
        `[reckoner] cdc: writ "${writ.id}" type "${writ.type}" has no declared state "${writ.phase}" in its WritTypeConfig — refusing to choose an acceptance target.`,
      );
    }
    const candidates: string[] = [];
    for (const target of currentState.allowedTransitions) {
      const targetState = config.states.find((s) => s.name === target);
      if (!targetState) continue;
      if (targetState.classification === 'active') {
        candidates.push(target);
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `[reckoner] cdc: writ "${writ.id}" type "${writ.type}" current state "${writ.phase}" has no outbound transition to an active state — cannot accept.`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `[reckoner] cdc: writ "${writ.id}" type "${writ.type}" current state "${writ.phase}" has multiple outbound transitions to active states (${candidates.map((c) => `"${c}"`).join(', ')}) — refusing to guess. The Reckoner expects exactly one active candidate.`,
      );
    }
    return candidates[0]!;
  }

  /**
   * Helper to keep the diagnostic in `resolveActiveTargetPhase`
   * stable when `writ.type` is somehow `undefined` at runtime (a
   * defensive guard — types ensure it is present).
   */
  function writt(writ: WritDoc): string {
    return typeof writ.type === 'string' && writ.type.length > 0 ? writ.type : '<missing>';
  }

  /**
   * Idempotency lookup. Reuses the `[writId, consideredAt]` index
   * (D6/D9) to fetch every prior row for `writId`, then filters
   * in-process on `writUpdatedAt` to detect a duplicate consideration
   * for the same triggering writ-version. Returns `true` when a row
   * already exists for the (`writId`, `writUpdatedAt`) pair.
   */
  async function alreadyConsidered(
    book: Book<ReckoningDoc>,
    writId: string,
    writUpdatedAt: string,
  ): Promise<boolean> {
    const candidates = await book.find({
      where: [['writId', '=', writId]],
    });
    for (const row of candidates) {
      if (row.writUpdatedAt === writUpdatedAt) return true;
    }
    return false;
  }

  /**
   * Build a Reckoning record from the in-flight consideration state.
   *
   * Both `consideredAt` and the `generateId('rk')` timestamp seed are
   * derived from the same `now` Date the caller sampled at handler
   * entry (D17), keeping the row's id and `consideredAt` consistent
   * within a single consideration.
   */
  function buildReckoningRow(params: {
    now: Date;
    writ: WritDoc;
    ext: ReckonerExt;
    outcome: 'accepted' | 'declined';
    declineReason?: ReckoningDoc['declineReason'];
    remediationHint?: string;
    /**
     * Scheduler-emitted weight (D5). Threaded through verbatim onto
     * the resulting Reckonings row when present; absent for
     * decisions whose `SchedulerDecision.weight` was undefined.
     */
    weight?: number;
  }): ReckoningDoc {
    const consideredAt = params.now.toISOString();
    const row: ReckoningDoc = {
      id: generateId('rk', 6),
      writId: params.writ.id,
      writUpdatedAt: params.writ.updatedAt,
      source: params.ext.source,
      visionRelation: params.ext.priority.visionRelation,
      severity: params.ext.priority.severity,
      outcome: params.outcome,
      consideredAt,
    };
    if (params.outcome === 'declined') {
      if (params.declineReason !== undefined) {
        row.declineReason = params.declineReason;
      }
      if (params.remediationHint !== undefined) {
        row.remediationHint = params.remediationHint;
      }
    }
    if (params.weight !== undefined) {
      row.weight = params.weight;
    }
    return row;
  }

  /**
   * Run the rule sequence against a single writ and, on a non-skip
   * outcome, drive the transition + append a Reckonings row.
   *
   * The same code path is used by both the Phase 2 CDC handler and
   * the startup catch-up scan (D12) — re-routing held writs that
   * pre-date the watcher through this function preserves the dedupe
   * guarantee on restart.
   *
   * Skip semantics (returns without writing a row or transitioning):
   *   - `writ.phase !== 'new'`  (D16: withdrawals + already-handled)
   *   - `writ.ext?.reckoner` missing or has empty source string (D15)
   *   - source is in `disabledSources` (D18: debug-log only, no row)
   *
   * Decline path (writes a row, transitions to `cancelled`):
   *   - source unregistered + `enforceRegistration: true` (D8)
   *
   * Scheduler path (Rule 5):
   *   - source registered, OR source unregistered with
   *     `enforceRegistration: false`. Delegated to `runScheduler`,
   *     which calls the registry-resolved active scheduler and maps
   *     its decision per D21.
   *
   * Idempotency: each non-skip path consults `alreadyConsidered`
   * before writing — a re-delivery of the same (writId,
   * writUpdatedAt) short-circuits without a second row or transition.
   */
  async function considerWrit(writ: WritDoc): Promise<void> {
    if (!reckoningsBook) {
      // Phase ordering safety: the reckonings book handle is set
      // inside `start()`. If the handler fires before that, we
      // silently skip — the catch-up scan will reprocess the writ
      // once the book handle is available.
      return;
    }

    // Rule 1 — phase gate. Withdrawals and already-handled writs
    // produce no row.
    if (writ.phase !== 'new') return;

    // Rule 2 — ext gate (D15). The petition() helper is the
    // validation boundary; the CDC handler does only the minimum
    // source-string check.
    const ext = writ.ext?.[RECKONER_PLUGIN_ID] as ReckonerExt | undefined;
    if (!ext) return;
    if (typeof ext.source !== 'string' || ext.source.length === 0) return;

    const config = resolveConfig();

    // Rule 3 — disabled-source skip (D18). No row, no transition;
    // a single debug log line gives operators a finding-by-grep
    // path. We use console.debug so the line is suppressible by
    // the Node runtime's default level if operators don't want it.
    if (config.disabledSources.includes(ext.source)) {
      // eslint-disable-next-line no-console
      console.debug(
        `[reckoner] cdc: source "${ext.source}" is in disabledSources; skipping writ "${writ.id}".`,
      );
      return;
    }

    // Sample `now` once at handler entry (D17). Reused for the row
    // id seed and consideredAt.
    const now = new Date();

    // Rule 4 — registration check.
    const isRegistered = registry.has(ext.source);
    if (!isRegistered && config.enforceRegistration) {
      // Decline path. Idempotency lookup first.
      if (await alreadyConsidered(reckoningsBook, writ.id, writ.updatedAt)) {
        return;
      }
      const resolution =
        `[reckoner] declined: source '${ext.source}' is not registered (enforceRegistration: true).`;
      try {
        await clerk.transition(writ.id, 'cancelled' as WritPhase, { resolution });
      } catch (err) {
        // Surface but do not crash the watcher; Phase 2 absorbs
        // the throw via failOnError: false.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] cdc: failed to transition writ "${writ.id}" to cancelled (decline path): ${msg}`,
        );
        return;
      }
      const row = buildReckoningRow({
        now,
        writ,
        ext,
        outcome: 'declined',
        declineReason: 'source_unregistered',
        remediationHint: ext.source,
      });
      try {
        await reckoningsBook.put(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] cdc: failed to persist Reckonings row for writ "${writ.id}" (decline path): ${msg}`,
        );
      }
      return;
    }

    // Rule 5 — registry-resolved scheduler.
    await runScheduler(writ, ext, now);
  }

  /**
   * Run the active scheduler against a single held writ and apply
   * the resulting decision (D20). Extracted from `considerWrit` so
   * the tick-relay follow-on can call the same helper at a different
   * call site without re-extracting the evaluation logic.
   *
   * Sequence:
   *
   *   1. Pre-seal guard (D35) — if the active scheduler reference has
   *      not been resolved yet, skip silently. The catch-up scan
   *      reprocesses the writ post-seal.
   *   2. Dedupe lookup (D25) — short-circuit before paying the
   *      `validateConfig` / `evaluate` cost on duplicate CDC delivery.
   *   3. Per-evaluation `schedulerConfig` re-read (D17) +
   *      `validateConfig` narrow (D18) — on throw, log fail-loud and
   *      return without writing a row or transitioning.
   *   4. `evaluate` — on throw, log fail-loud and return.
   *   5. Decision validation: filter-and-warn on `writId` not in the
   *      candidate set (D24); fail-loud-skip if any `writId` carries
   *      more than one decision (D23).
   *   6. Outcome mapping (D21) —
   *        - `approve`  → transition to active target + accepted row.
   *        - `defer`    → no transition, no row.
   *        - `decline`  → transition to cancelled with the decision's
   *                       reason as resolution + declined row carrying
   *                       `declineReason: 'other'` (D22) and the
   *                       reason in `remediationHint`.
   */
  async function runScheduler(
    writ: WritDoc,
    ext: ReckonerExt,
    now: Date,
  ): Promise<void> {
    if (!reckoningsBook) return;

    // 1. Pre-seal guard (D35).
    if (!activeScheduler) return;

    // 2. Dedupe before paying the scheduler cost.
    if (await alreadyConsidered(reckoningsBook, writ.id, writ.updatedAt)) {
      return;
    }

    // 3. Per-evaluation config re-read + validate.
    const rawSchedulerConfig = resolveSchedulerConfig();
    let validatedConfig: unknown = rawSchedulerConfig;
    if (typeof activeScheduler.validateConfig === 'function') {
      try {
        validatedConfig = activeScheduler.validateConfig(rawSchedulerConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] scheduler: "${activeScheduler.id}" validateConfig threw — skipping evaluation for writ "${writ.id}". ${msg}`,
        );
        return;
      }
    }

    // 4. Evaluate.
    let decisions: readonly SchedulerDecision[];
    try {
      const result = await activeScheduler.evaluate({
        candidates: [writ],
        capacity: {},
        now,
        config: validatedConfig,
      });
      decisions = result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" evaluate threw — skipping evaluation for writ "${writ.id}". ${msg}`,
      );
      return;
    }

    if (!Array.isArray(decisions)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" evaluate did not return an array — skipping evaluation for writ "${writ.id}".`,
      );
      return;
    }

    // 5. Validate decisions: filter-and-warn on stranger writIds (D24).
    const candidateIds = new Set<string>([writ.id]);
    const inScope: SchedulerDecision[] = [];
    for (const decision of decisions) {
      if (
        decision === null ||
        typeof decision !== 'object' ||
        typeof decision.writId !== 'string' ||
        decision.writId.length === 0
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] scheduler: "${activeScheduler.id}" returned a malformed decision (missing writId) — ignoring.`,
        );
        continue;
      }
      if (!candidateIds.has(decision.writId)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] scheduler: "${activeScheduler.id}" returned a decision for writ "${decision.writId}" which was not in the candidate set — ignoring.`,
        );
        continue;
      }
      inScope.push(decision);
    }

    // Group by writId; fail-loud-skip on multi-decision-per-writ (D23).
    const grouped = new Map<string, SchedulerDecision[]>();
    for (const decision of inScope) {
      const list = grouped.get(decision.writId) ?? [];
      list.push(decision);
      grouped.set(decision.writId, list);
    }
    for (const [writId, list] of grouped) {
      if (list.length > 1) {
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] scheduler: "${activeScheduler.id}" returned ${list.length} decisions for writ "${writId}" — refusing to apply any. Schedulers must emit at most one decision per candidate.`,
        );
        return;
      }
    }

    const decision = grouped.get(writ.id)?.[0];
    if (!decision) {
      // No decision for this candidate — defer-equivalent, no row, no transition.
      return;
    }

    // 6. Outcome mapping (D21).
    if (decision.outcome === 'defer') {
      // No transition, no row. v0 defer means absence-of-row signal.
      return;
    }

    if (
      decision.outcome !== 'approve' &&
      decision.outcome !== 'decline' &&
      decision.outcome !== 'defer'
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] scheduler: "${activeScheduler.id}" returned an unknown outcome "${String((decision as { outcome?: unknown }).outcome)}" for writ "${writ.id}" — ignoring.`,
      );
      return;
    }

    if (decision.outcome === 'decline') {
      const resolution = decision.reason;
      try {
        await clerk.transition(writ.id, 'cancelled' as WritPhase, { resolution });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] cdc: failed to transition writ "${writ.id}" to cancelled (scheduler decline): ${msg}`,
        );
        return;
      }
      const row = buildReckoningRow({
        now,
        writ,
        ext,
        outcome: 'declined',
        declineReason: 'other',
        remediationHint: decision.reason,
        ...(decision.weight !== undefined ? { weight: decision.weight } : {}),
      });
      try {
        await reckoningsBook!.put(row);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] cdc: failed to persist Reckonings row for writ "${writ.id}" (scheduler decline): ${msg}`,
        );
      }
      return;
    }

    // approve.
    let target: string;
    try {
      target = resolveActiveTargetPhase(writ);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] cdc: writ "${writ.id}" has no resolvable active target — leaving in new. ${msg}`,
      );
      return;
    }

    try {
      await clerk.transition(writ.id, target as WritPhase, {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] cdc: failed to transition writ "${writ.id}" to "${target}" (scheduler approve): ${msg}`,
      );
      return;
    }

    const row = buildReckoningRow({
      now,
      writ,
      ext,
      outcome: 'accepted',
      ...(decision.weight !== undefined ? { weight: decision.weight } : {}),
    });
    try {
      await reckoningsBook!.put(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] cdc: failed to persist Reckonings row for writ "${writ.id}" (scheduler approve): ${msg}`,
      );
    }
  }

  /**
   * Phase 2 CDC handler body. Filters to update events only (D10),
   * gates on the `phase`-or-`ext.reckoner`-changed predicate (D14),
   * then routes through `considerWrit`.
   */
  async function handleWritsChange(event: ChangeEvent<WritDoc>): Promise<void> {
    if (event.type !== 'update') return;

    const entry = event.entry;
    const prev = event.prev;

    // Re-firing gate (D14): run the rule sequence only when the
    // phase changed or when `ext.reckoner` differs deeply between
    // the two snapshots. Other update events are ignored at the
    // gate so unrelated ext writes don't amplify the dedupe-lookup
    // budget. JSON.stringify is the project's accepted deep-equal
    // proxy (no in-tree deepEqual helper).
    const phaseChanged = entry.phase !== prev.phase;
    const extPrev = prev.ext?.[RECKONER_PLUGIN_ID];
    const extNext = entry.ext?.[RECKONER_PLUGIN_ID];
    const extChanged = JSON.stringify(extPrev) !== JSON.stringify(extNext);
    if (!phaseChanged && !extChanged) return;

    await considerWrit(entry);
  }

  /**
   * Startup catch-up scan (D12). Held writs that pre-date the
   * apparatus's `start()` would otherwise sit in `new` forever; we
   * sweep them through the same handler path so dedupe and the rule
   * sequence apply uniformly. Runs after the watcher is registered
   * so events arriving during the scan are not lost.
   *
   * The query uses a direct read of `clerk/writs` rather than
   * `clerk.list({ phase: 'new' })` because Clerk's list applies an
   * implicit `type = 'mandate'` filter when `phase` is supplied
   * without `type` — a non-mandate held petition (with its own
   * type carrying a `new` initial state) would not surface through
   * that path.
   */
  async function runCatchUpScan(): Promise<void> {
    if (!stacks || !reckoningsBook) return;
    const writsBook: ReadOnlyBook<WritDoc> = stacks.readBook<WritDoc>('clerk', 'writs');
    const candidates = await writsBook.find({
      where: [['phase', '=', 'new']],
      orderBy: ['createdAt', 'asc'],
    });
    for (const writ of candidates) {
      // Cheap pre-filter so writs without a Reckoner ext slot don't
      // walk through the handler path or the dedupe lookup.
      if (!writ.ext?.[RECKONER_PLUGIN_ID]) continue;
      try {
        await considerWrit(writ);
      } catch (err) {
        // Per-writ swallow — one corrupt held writ should not stop
        // the scan from reaching the rest.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[reckoner] cdc: catch-up scan: considerWrit failed on "${writ.id}": ${msg}`,
        );
      }
    }
  }

  /**
   * Single canonical validation path for both `petition()` forms.
   *
   * Runs the input-only guards: source-registry check (gated by
   * `enforceRegistration`), priority dimension validation, and
   * partial-priority default-fill. Returns the validated, default-
   * filled `ReckonerExt` ready for `clerk.setWritExt()`.
   *
   * Both the create+stamp form and the stamp-only form route through
   * this helper before any writ-state work — a malformed input never
   * reaches `clerk.post()` (so the create+stamp form cannot leak an
   * orphan writ on bad input) and never reaches `clerk.show()` /
   * `clerk.setWritExt()` (so the stamp-only form does not pay a
   * Stacks read just to be told the input is wrong).
   */
  function validateAndFillExt(extRequest: PetitionExtRequest): ReckonerExt {
    // ── Source resolution ────────────────────────────────────────
    const config = resolveConfig();
    const isRegistered = registry.has(extRequest.source);

    if (!isRegistered) {
      if (config.enforceRegistration) {
        // Fail-loud without side-effect (D8): no writ created, no
        // ext stamped.
        throw new Error(
          `[reckoner] petition: source "${extRequest.source}" is not registered. Registered sources: ${
            registry.size === 0
              ? '(none)'
              : [...registry.keys()].map((s) => `"${s}"`).join(', ')
          }. enforceRegistration is true; refusing to post.`,
        );
      }
      // Permissive mode: warn and proceed (D6).
      console.warn(
        `[reckoner] petition: source "${extRequest.source}" is not registered; proceeding because reckoner.enforceRegistration is false.`,
      );
    }

    // ── Priority validation + default-fill ───────────────────────
    validatePriorityDimensions(extRequest.priority ?? {});
    const priority = mergePriorityWithDefaults(extRequest.priority);

    // Build the minimum-viable ext shape — optional fields are
    // included only when the caller supplied them so the on-disk
    // shape never carries dead keys.
    const ext: ReckonerExt = {
      source: extRequest.source,
      priority,
      ...(extRequest.complexity !== undefined ? { complexity: extRequest.complexity } : {}),
      ...(extRequest.payload !== undefined ? { payload: extRequest.payload } : {}),
      ...(extRequest.labels !== undefined ? { labels: extRequest.labels } : {}),
    };
    return ext;
  }

  // ── petition() — overloaded: create+stamp and stamp-only ─────────
  //
  // The two forms share validation (source registry + priority
  // default-fill via `validateAndFillExt`) but differ in whether a
  // writ is created. The stamp-only form is the canonical
  // implementation: the create+stamp form composes
  // `clerk.post()` + a self-call into the stamp-only form so a
  // single code path carries source / priority / ext-write.
  function petition(request: PetitionRequest): Promise<WritDoc>;
  function petition(writId: string, extRequest: PetitionExtRequest): Promise<WritDoc>;
  async function petition(
    arg1: PetitionRequest | string,
    arg2?: PetitionExtRequest,
  ): Promise<WritDoc> {
    if (typeof arg1 === 'string') {
      if (arg2 === undefined) {
        throw new Error(
          '[reckoner] petition: stamp-only form requires an extRequest argument.',
        );
      }
      return petitionStampOnly(arg1, arg2);
    }
    return petitionCreateAndStamp(arg1);
  }

  /**
   * Stamp-only form — the canonical implementation.
   *
   * Guard order (D4 cheap-first): input validation (via
   * `validateAndFillExt`) before writ-state guards. Every fail-loud
   * path carries the `[reckoner] petition:` diagnostic prefix and
   * produces no writ mutation.
   */
  async function petitionStampOnly(
    writId: string,
    extRequest: PetitionExtRequest,
  ): Promise<WritDoc> {
    // 1. Input-only guards: source registry + priority dimensions +
    //    default-fill. A malformed input never pays a Stacks read.
    const ext = validateAndFillExt(extRequest);

    // 2. Writ-state guards. clerk.show() throws if the writ does
    //    not exist; the throw is rewrapped with the helper's
    //    diagnostic prefix so operators can grep for every helper-
    //    boundary throw with one prefix.
    let writ: WritDoc;
    try {
      writ = await clerk.show(writId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[reckoner] petition: writ "${writId}" cannot be stamped: ${msg}`,
      );
    }

    // 3. Initial-phase guard. Type-aware via clerk.isInitial — never
    //    hardcode `'new'` here. A non-mandate writ-type with a
    //    differently-named initial state is supported by construction.
    if (!clerk.isInitial(writ)) {
      throw new Error(
        `[reckoner] petition: writ "${writId}" is not in its writ-type's initial phase (current phase: "${writ.phase}"). Stamp-only form requires the writ to be in its initial phase.`,
      );
    }

    // 4. No-existing-ext guard. Petitioning is a one-time act;
    //    fail-loud rather than silently re-stamping or deep-comparing
    //    the existing slot.
    if (writ.ext?.[RECKONER_PLUGIN_ID] !== undefined) {
      throw new Error(
        `[reckoner] petition: writ "${writId}" already carries ext.reckoner. Petitioning is a one-time act; refusing to overwrite.`,
      );
    }

    // 5. Stamp. Returns the patched writ; symmetry with the create+
    //    stamp form lets that form return the result of this call
    //    directly.
    return clerk.setWritExt(writId, RECKONER_PLUGIN_ID, ext);
  }

  /**
   * Create+stamp form — convenience wrapper that posts a writ in
   * its registered initial phase and then routes through the stamp-
   * only form for the ext write. Source/priority validation runs
   * once (in `validateAndFillExt`) before `clerk.post()` so a
   * malformed input never produces an orphan writ.
   */
  async function petitionCreateAndStamp(
    request: PetitionRequest,
  ): Promise<WritDoc> {
    // Run validation up-front — a malformed input must never reach
    // clerk.post() (no orphan writ on bad input).
    validateAndFillExt(request);

    // Step 1: clerk.post() with the writ-shape fields. The optional
    // type passes straight through (D21); when omitted Clerk uses
    // the guild-default writ type.
    const writ = await clerk.post({
      ...(request.type !== undefined ? { type: request.type } : {}),
      title: request.title,
      body: request.body,
      ...(request.codex !== undefined ? { codex: request.codex } : {}),
      ...(request.parentId !== undefined ? { parentId: request.parentId } : {}),
    });

    // Step 2: delegate to the stamp-only form for the ext write.
    // Re-running validation in the helper is intentional and cheap:
    // there is exactly one canonical validation path, and the
    // helper-boundary diagnostics fire from the same place
    // regardless of which form the caller invoked.
    return petitionStampOnly(writ.id, request);
  }

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

    petition,

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
      // `requires: ['clerk']` only (D22). No explicit Stacks
      // dependency — the topo sort handles transitives. No
      // `recommends` because no consumer of one exists in this
      // commission.
      requires: ['clerk'],

      // The Reckoner is the consumer of `petitioners` and
      // `schedulers` kit contributions. Declaring `consumes` here
      // suppresses the Arbor's "no consumer" warning for kits
      // contributing those arrays.
      consumes: ['petitioners', 'schedulers'],

      provides: api,

      // Reckoner-owned book (D1, D9, D21) plus the Reckoner's own
      // contribution to its own scheduler registry — the built-in
      // `reckoner.always-approve` scheduler flows through
      // `ctx.kits('schedulers')` exactly like a user-contributed
      // scheduler (D29). Stacks materialises the book during the
      // Wire phase from the supportKit declaration; the Wire-phase
      // ensure call carries the index set forward to the backend.
      // The Reckoner is the sole writer.
      supportKit: {
        books: {
          reckonings: {
            indexes: [
              'writId',
              'consideredAt',
              'outcome',
              'source',
              'visionRelation',
              'severity',
              'declineReason',
              ['outcome', 'consideredAt'],
              ['visionRelation', 'consideredAt'],
              ['severity', 'consideredAt'],
              ['writId', 'consideredAt'],
            ],
          },
        },
        schedulers: [alwaysApproveScheduler],
      },

      async start(ctx: StartupContext): Promise<void> {
        // Resolve the Clerk handle inside start() so the closure
        // captures the populated provides object — at this point
        // the `requires: ['clerk']` declaration has guaranteed
        // Clerk has already started.
        clerk = guild().apparatus<ClerkApi>('clerk');
        // Stacks is reached transitively via Clerk's hard-require
        // (D22). Resolving it here keeps the topology declaration
        // minimal while letting the CDC handler subscribe.
        stacks = guild().apparatus<StacksApi>('stacks');
        reckoningsBook = stacks.book<ReckoningDoc>('reckoner', 'reckonings');

        // Build the registry from `petitioners` kit contributions.
        // Hard-fail at any malformed entry (D4): a registry that
        // silently swallows drift is worse than a startup failure.
        for (const entry of ctx.kits('petitioners')) {
          registerKitPetitioners(entry);
        }

        // Build the scheduler registry from `schedulers` kit
        // contributions (D9/D29). The Reckoner's own
        // `apparatus.supportKit.schedulers: [alwaysApproveScheduler]`
        // surfaces here too — there is no special-cased default-
        // bypass; the built-in instance is registered exactly like
        // a user-contributed one.
        for (const entry of ctx.kits('schedulers')) {
          registerKitSchedulers(entry);
        }

        // Seal both registries on the framework's `phase:started`
        // signal — the same moment Clerk seals its writ-type
        // registry (D5/D12). Any post-seal registration attempt
        // throws a sealed-registry error patterned on Clerk's
        // `[clerk] registerWritType:` diagnostic. Immediately after
        // sealing, resolve the active scheduler (D14) so any
        // selector misconfiguration surfaces at startup rather than
        // on the first considered writ. The catch-up scan is
        // deferred to this same handler (D35) — pre-seal CDC events
        // are silently skipped via the `activeScheduler` guard, and
        // the scan reprocesses every held writ post-seal so no
        // event is lost.
        ctx.on('phase:started', async () => {
          registrySealed = true;
          schedulerRegistrySealed = true;
          activeScheduler = resolveActiveScheduler();
          await runCatchUpScan();
        });

        // ── Phase 2 CDC subscription (D2/D3) ─────────────────────
        // `failOnError: false` keeps the handler post-commit so a
        // throw never rolls back the petitioner's `clerk.post()`
        // (or any other writ write). The Reckoner's decisions are
        // post-hoc by design.
        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          (event) => handleWritsChange(event),
          { failOnError: false },
        );
      },
    },
  };

  const hooks: ReckonerTestHooks = {
    registerKitPetitioners,
    registerKitSchedulers,
    isSealed: () => registrySealed,
    sealRegistry: () => {
      registrySealed = true;
      schedulerRegistrySealed = true;
    },
    handleWritsChange: (event) => handleWritsChange(event),
    runCatchUpScan: () => runCatchUpScan(),
    getActiveSchedulerId: () => activeScheduler?.id,
    getRegisteredSchedulerIds: () => [...schedulerRegistry.keys()].sort(),
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
