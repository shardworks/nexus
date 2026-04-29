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
 *      coherent set on `provides` so the tick handler and any other
 *      downstream consumer can read the same registry and config
 *      the helpers see.
 *   5. The Reckonings book (`reckoner/reckonings`) — declared via
 *      `supportKit.books` so the Stacks Wire phase materialises it
 *      with the contract index set; the auto-wired
 *      `book.reckoner.reckonings.{created,updated,deleted}`
 *      Clockworks events fire normally (no carve-out).
 *   6. A periodic tick relay (`reckoner.tick`) plus a kit-contributed
 *      standing order (`@every 60s` → `reckoner.tick`). Every tick
 *      sweeps the held-petition set in one batch, applies source /
 *      disabled-source gates, runs the dependency-aware gate
 *      (rule 5: held petitions with one or more outbound `depends-on`
 *      links whose targets are not all cleared are deferred and stay
 *      in `new`), dedupes against the persisted
 *      `(writId, writUpdatedAt)` lookup, calls the active
 *      scheduler's `evaluate` once with the full surviving
 *      candidate set, and applies each emitted decision (approve →
 *      transition to active target; decline → transition to
 *      cancelled with the decision's reason; defer → no
 *      transition). One Reckonings row is appended per writ
 *      considered, including for `defer` outcomes. The tick is the
 *      single evaluation entry — there is no CDC handler, no
 *      catch-up scan, and no per-writ-update path. Dependency-
 *      deferred petitions surface on every tick and release
 *      naturally as their dependencies clear (the polling tick is
 *      the v0 wake-up mechanism).
 *
 * The structural template for the kit-static registry is the
 * Clerk's `registerKitLinkKinds` (link-kind registry); the seal
 * pattern mirrors Clerk's writ-type registry. Diagnostic messages
 * intentionally echo Clerk's `[clerk] registerWritType:` shape
 * with a `[reckoner]` prefix so kit authors see a familiar shape.
 * The tick handler's idempotency strategy (persisted dedupe via the
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
 *   - implement no-op rows, throttling, or per-source quotas — all
 *     reserved for future commissions. (Dependency-aware deferral
 *     is implemented as a tick step; scheduler-emitted `defer`
 *     decisions are written as `'other'` deferred rows by the tick
 *     handler.)
 *   - implement dangling-target escalation or `dependency_failed`
 *     petitioner notification (Lattice-channel push) — those remain
 *     parked. The deferred-petition staleness diagnostic IS now
 *     implemented as a Phase-2 CDC watcher on the `reckonings`
 *     book that maintains a `ReckonerStatus` snapshot at
 *     `writ.status['reckoner']`; see `./staleness-snapshot.ts`.
 *
 * See: docs/architecture/petitioner-registration.md (the
 * load-bearing contract document),
 * docs/architecture/reckonings-book.md (the Reckonings book schema
 * and tick contract), and
 * docs/architecture/apparatus/reckoner.md (the apparatus shape).
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type {
  GuildEvent,
  RelayDefinition,
  StandingOrder,
} from '@shardworks/clockworks-apparatus';
import type {
  Book,
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
  ReckonerExt,
  ReckoningDoc,
  Scheduler,
} from './types.ts';

import {
  DOMAIN_VALUES,
  SCOPE_VALUES,
  SEVERITY_VALUES,
  VISION_RELATION_VALUES,
} from './types.ts';

import { alwaysApproveScheduler } from './schedulers/always-approve.ts';
import { createStalenessHandler } from './staleness-snapshot.ts';
import {
  createTickRelay,
  RECKONER_TICK_RELAY_NAME,
  RECKONER_TICK_SCHEDULE,
  runTickHandler,
  type BuildReckoningRowParams,
  type ResolvedReckonerConfig,
  type TickContext,
} from './tick.ts';

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
   * Drive the periodic tick handler directly with an optional
   * synthetic `GuildEvent`. Used by `reckoner-tick.test.ts` to
   * exercise the per-fire sequence, the dedupe path, and the
   * decision-application paths without booting the Clockworks.
   *
   * When `event` is omitted (or `null`), the rows written this
   * tick carry no `tickEventId` — matching the production absence
   * of the field when the relay is invoked outside the Clockworks
   * dispatcher path.
   */
  runTick(event?: GuildEvent | null): Promise<void>;
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
   * the registry seals; remains `undefined` until then. The tick
   * handler throws fail-loud if it fires while this is unset (the
   * silent-skip the prior CDC path used has been replaced with a
   * loud guard — see D8 in the originating brief).
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

  // The concrete shape returned by `resolveConfig` — `ResolvedReckonerConfig`
  // — is imported from `./tick.ts` so the apparatus core and the tick
  // handler share one source of truth. The shape is intentionally not
  // `Required<ReckonerConfig>` — the scheduler-selector fields
  // (`scheduler`, `schedulerConfig`) live on the same config block
  // but are read through different accessors with different cadences.

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

  // ── Apparatus state ───────────────────────────────────────────────

  let clerk: ClerkApi;
  let stacks: StacksApi;
  let reckoningsBook: Book<ReckoningDoc>;

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
        `[reckoner] tick: writ "${writ.id}" has type "${writt(writ)}" with no registered WritTypeConfig — refusing to choose an acceptance target.`,
      );
    }
    const currentState = config.states.find((s) => s.name === writ.phase);
    if (!currentState) {
      throw new Error(
        `[reckoner] tick: writ "${writ.id}" type "${writ.type}" has no declared state "${writ.phase}" in its WritTypeConfig — refusing to choose an acceptance target.`,
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
        `[reckoner] tick: writ "${writ.id}" type "${writ.type}" current state "${writ.phase}" has no outbound transition to an active state — cannot accept.`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `[reckoner] tick: writ "${writ.id}" type "${writ.type}" current state "${writ.phase}" has multiple outbound transitions to active states (${candidates.map((c) => `"${c}"`).join(', ')}) — refusing to guess. The Reckoner expects exactly one active candidate.`,
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

  // ── Dependency-aware consideration gate (D1–D13) ───────────────────
  //
  // The Reckoner reads outbound `depends-on` links on each held
  // petition under consideration and defers acceptance until every
  // dependency target has reached a *cleared* state. Without this
  // gate, the petitioner could fill the active-WIP cap with writs
  // that are still gated on incomplete dependencies — Spider's
  // existing dispatch-time gate cannot fix that because Spider only
  // fires after the Reckoner has already promoted the writ to
  // `active`. The deadlock has to be prevented at the consideration
  // layer.
  //
  // Classifier (D2): one target writ → `cleared` | `failed` | `gating`
  //   - `cleared`  iff the target's stored phase has classification
  //                `terminal` AND attrs include `success` OR
  //                `cancelled` (cancelled is success-equivalent for
  //                v0).
  //   - `failed`   iff classification is `terminal` and the cleared
  //                attrs are absent (catches `failure`, `stuck` if
  //                terminal, or any plugin-contributed terminal that
  //                does not declare success/cancelled).
  //   - `gating`   iff classification is not terminal.
  //
  // Aggregator (D2, failed-precedence): many targets → one of three
  //   outcomes — `proceed`, `defer-pending`, `defer-failed`. Any
  //   failed dep wins regardless of how many other deps are still
  //   gating; the `dependency_failed` defer reason surfaces that
  //   shape on the Reckonings row.
  //
  // The classifier inspects every outbound `depends-on` link
  // regardless of target type (D13) — plugin-contributed types work
  // transparently as long as they declare the relevant attrs.
  // Dangling targets are treated as `gating` (D2/Spider precedent):
  // the link was created against a live target, so a missing target
  // is an operator/data-integrity condition better surfaced as
  // "still gated" than as "ready".

  /** Per-target classification produced by `classifyDependencyTarget`. */
  type DependencyTargetClass = 'cleared' | 'failed' | 'gating';

  /**
   * Aggregated dependency-gate outcome for one held petition.
   *
   * `proceed` — all outbound `depends-on` targets are cleared (or
   * the writ has no outbound `depends-on` links).
   * `defer-pending` — at least one target is `gating` and none are
   * `failed`.
   * `defer-failed` — at least one target is `failed` (failed-
   * precedence: takes priority over any gating targets).
   */
  type DependencyOutcome =
    | { kind: 'proceed' }
    | { kind: 'defer-pending'; gatingIds: string[] }
    | { kind: 'defer-failed'; failedIds: string[] };

  /**
   * Classify one dependency target via its writ-type config attrs.
   * Mirrors `resolveActiveTargetPhase`'s diagnostic style: fail-loud
   * with `[reckoner]` prefix when the target's writ-type is not
   * registered or its stored phase is not declared in the config.
   * A target reachable via a `depends-on` link with no registered
   * type config is a configuration error, not a transient — defer-
   * as-gating or treat-as-failed would silently absorb registration
   * drift (D10).
   */
  function classifyDependencyTarget(target: WritDoc): DependencyTargetClass {
    const config: WritTypeConfig | undefined = clerk.getWritTypeConfig(target.type);
    if (!config) {
      throw new Error(
        `[reckoner] dependency: target writ "${target.id}" has type "${writt(target)}" with no registered WritTypeConfig — refusing to classify dependency state.`,
      );
    }
    const state = config.states.find((s) => s.name === target.phase);
    if (!state) {
      throw new Error(
        `[reckoner] dependency: target writ "${target.id}" type "${target.type}" has no declared state "${target.phase}" in its WritTypeConfig — refusing to classify dependency state.`,
      );
    }
    if (state.classification !== 'terminal') return 'gating';
    const attrs = state.attrs ?? [];
    if (attrs.includes('success') || attrs.includes('cancelled')) {
      return 'cleared';
    }
    return 'failed';
  }

  /**
   * Walk a held writ's outbound `depends-on` links and aggregate the
   * per-target classifications.
   *
   * Reads links via `clerk.links()` and filters to `kind === 'depends-on'`
   * — the namespace-free Clerk-contributed link kind. The Reckoner
   * does not read any Spider-side link convention; the dep gate
   * keys exclusively on the registered Clerk kind.
   *
   * Resolves each target via a `ReadOnlyBook<WritDoc>` obtained from
   * `stacks.readBook('clerk', 'writs')` (D8) — mirrors the catch-up
   * scan's pattern and Spider's gate evaluator. `book.get(targetId)`
   * returns `undefined` for missing targets, no throw.
   *
   * Aggregation is failed-precedence (D2): any failed → `defer-failed`;
   * else any gating (or dangling) → `defer-pending`; else `proceed`.
   */
  async function evaluateDependencyGate(writId: string): Promise<DependencyOutcome> {
    const { outbound } = await clerk.links(writId);
    const targetIds = outbound
      .filter((l) => l.kind === 'depends-on')
      .map((l) => l.targetId);
    if (targetIds.length === 0) return { kind: 'proceed' };

    if (!stacks) {
      // Defensive: stacks is set in start(); the gate cannot run
      // without it. Falling through to proceed would silently
      // bypass the gate, so fail-loud-skip with a warning instead.
      // (In practice this branch is unreachable — start() runs
      // before considerWrit can fire.)
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] dependency: stacks handle is unavailable; skipping dependency gate for writ "${writId}".`,
      );
      return { kind: 'proceed' };
    }
    const writsBook: ReadOnlyBook<WritDoc> = stacks.readBook<WritDoc>('clerk', 'writs');

    const failedIds: string[] = [];
    const gatingIds: string[] = [];
    for (const targetId of targetIds) {
      const target = await writsBook.get(targetId);
      if (!target) {
        // Dangling target — treat as gating (D2/Spider precedent).
        gatingIds.push(targetId);
        continue;
      }
      const cls = classifyDependencyTarget(target);
      if (cls === 'failed') {
        failedIds.push(targetId);
      } else if (cls === 'gating') {
        gatingIds.push(targetId);
      }
      // cleared → contributes nothing to either bucket
    }

    if (failedIds.length > 0) {
      return { kind: 'defer-failed', failedIds };
    }
    if (gatingIds.length > 0) {
      return { kind: 'defer-pending', gatingIds };
    }
    return { kind: 'proceed' };
  }

  /**
   * Format the `deferNote` for a dependency-defer Reckonings row
   * (D5): `gating: <id>, <id>` for `dependency_pending` or
   * `failed: <id>, <id>` for `dependency_failed`. The dep ids are
   * sorted so the note shape is deterministic — re-evaluations at
   * the same outcome produce byte-identical notes, which the
   * no-op-row suppression check (D12) keys on.
   */
  function buildDependencyDeferNote(
    kind: 'defer-pending' | 'defer-failed',
    ids: readonly string[],
  ): string {
    const prefix = kind === 'defer-failed' ? 'failed' : 'gating';
    const sorted = [...ids].sort();
    return `${prefix}: ${sorted.join(', ')}`;
  }

  /**
   * Idempotency lookup. Reuses the `[writId, consideredAt]` index
   * (D6/D9) to fetch every prior row for `writId`, then filters
   * in-process on `writUpdatedAt` to detect a duplicate terminal
   * consideration for the same triggering writ-version. Returns
   * `true` when a non-deferred row already exists for the
   * (`writId`, `writUpdatedAt`) pair.
   *
   * Deferred rows do *not* count as "already considered". The
   * dependency-aware defer path (D6 of the dependency-aware-
   * consideration commission) writes deferred rows as state-change
   * audit entries while leaving the writ in `new` phase; subsequent
   * ticks must remain free to re-run the gate at the same
   * `writUpdatedAt` and accept (or decline, or re-defer with no-op
   * suppression) once the gate clears. Skipping deferred rows here
   * is what enables that. The accept/decline writes (the only paths
   * that actually advance the writ's phase) still dedupe against
   * the same `writUpdatedAt`.
   */
  async function alreadyConsidered(writId: string, writUpdatedAt: string): Promise<boolean> {
    const candidates = await reckoningsBook.find({
      where: [['writId', '=', writId]],
    });
    for (const row of candidates) {
      if (row.writUpdatedAt !== writUpdatedAt) continue;
      // Deferred rows are state-change records, not terminal
      // dispositions — they do not gate re-evaluation on the next
      // tick. Only accept/decline rows constitute "already considered".
      if (row.outcome === 'deferred') continue;
      return true;
    }
    return false;
  }

  /**
   * Look up the most-recent deferred Reckonings row for `writId`.
   *
   * Used by the dependency-aware defer path to implement no-op-row
   * suppression (D12 of the dependency-aware-consideration
   * commission): when the dep gate produces a defer outcome whose
   * `(deferReason, deferNote)` shape matches the writ's most recent
   * deferred row, we suppress the row write rather than emit a
   * heartbeat duplicate. A fresh row is emitted only when the
   * outcome shape changes (a dep cleared, a new dep failed, or the
   * dep set's classification mix changed).
   *
   * Returns `undefined` when the writ has never been deferred.
   */
  async function findLastDeferredRow(
    book: Book<ReckoningDoc>,
    writId: string,
  ): Promise<ReckoningDoc | undefined> {
    const rows = await book.find({
      where: [['writId', '=', writId]],
    });
    let latest: ReckoningDoc | undefined;
    for (const row of rows) {
      if (row.outcome !== 'deferred') continue;
      if (!latest || row.consideredAt > latest.consideredAt) {
        latest = row;
      }
    }
    return latest;
  }

  /**
   * Build a Reckoning record from the in-flight consideration state.
   *
   * Both `consideredAt` and the `generateId('rk')` timestamp seed are
   * derived from the same `now` Date the caller sampled at handler
   * entry (D17), keeping the row's id and `consideredAt` consistent
   * within a single consideration. `tickEventId` is stamped from the
   * triggering `clockworks.timer` event id when present (D6); the
   * field is omitted when absent.
   *
   * The `'deferred'` branch is populated by both the dependency-aware
   * defer path (D5 of the dependency-aware-consideration commission)
   * and the scheduler-emitted defer path applied by the tick handler.
   * The dep-gate writes `dependency_pending` / `dependency_failed`
   * with a comma-separated list of gating/failed dep writ ids in
   * `deferNote`; the scheduler-emitted defer writes `'other'` with
   * the decision's reason in `deferNote`. The running counters
   * (`deferCount`, `firstDeferredAt`, `lastDeferredAt`) live on the
   * `ReckonerStatus` snapshot at `writ.status['reckoner']`, not on
   * the row — the staleness-diagnostic commission moved them off the
   * row schema once a single source of truth was earned. The wake-up
   * companions (`deferUntil`, `deferSignal`) remain reserved on the
   * row as forward-compat for a future event-driven wake-up
   * mechanism.
   */
  function buildReckoningRow(params: BuildReckoningRowParams): ReckoningDoc {
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
    if (params.outcome === 'deferred') {
      if (params.deferReason !== undefined) {
        row.deferReason = params.deferReason;
      }
      if (params.deferNote !== undefined) {
        row.deferNote = params.deferNote;
      }
    }
    if (params.weight !== undefined) {
      row.weight = params.weight;
    }
    if (params.tickEventId !== undefined) {
      row.tickEventId = params.tickEventId;
    }
    return row;
  }

  /**
   * Run the dependency-aware consideration gate against a single held
   * petition under tick consideration. Returns a tick-friendly
   * verdict — `proceed: true` keeps the writ in the candidate set
   * for the scheduler call; `proceed: false` drops it (the writ
   * stays in `new` phase and a deferred Reckonings row is written,
   * subject to the no-op-row suppression).
   *
   * The dep gate runs every tick (outside the `(writId,
   * writUpdatedAt)` dedupe short-circuit) so a deferred-with-deps
   * writ keeps being re-evaluated as its dependencies clear (D6 of
   * the dependency-aware-consideration commission). Only the row
   * write is dedupe-aware — the no-op-row suppression below
   * compares the new outcome shape to the writ's most-recent
   * deferred row, so re-evaluation at the same state does not
   * produce a heartbeat duplicate (D6/D12).
   *
   * Failed-precedence aggregation (D2) chooses between
   * `dependency_pending` and `dependency_failed`: any failed dep
   * wins regardless of how many other deps are still gating.
   *
   * The classifier fail-loud throws on missing/unknown writ-type
   * config (D10). Surface but do not crash the tick — the writ is
   * left in `new` without a row and the rest of the tick continues.
   */
  async function runDependencyGate(args: {
    writ: WritDoc;
    ext: ReckonerExt;
    now: Date;
    tickEventId?: string;
  }): Promise<{ proceed: boolean }> {
    const { writ, ext, now } = args;

    let depOutcome: DependencyOutcome;
    try {
      depOutcome = await evaluateDependencyGate(writ.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] tick: dependency gate threw for writ "${writ.id}" — leaving in new without a row. ${msg}`,
      );
      return { proceed: false };
    }
    if (depOutcome.kind === 'proceed') {
      return { proceed: true };
    }

    const reason: ReckoningDoc['deferReason'] =
      depOutcome.kind === 'defer-failed' ? 'dependency_failed' : 'dependency_pending';
    const ids =
      depOutcome.kind === 'defer-failed' ? depOutcome.failedIds : depOutcome.gatingIds;
    const deferNote = buildDependencyDeferNote(depOutcome.kind, ids);

    // No-op-row suppression (D12). Re-evaluation at the same
    // outcome shape produces no row. A new row appears only when
    // a dep cleared, a new dep failed, or the dep set's
    // classification mix changed.
    const last = await findLastDeferredRow(reckoningsBook, writ.id);
    if (
      last &&
      last.deferReason === reason &&
      last.deferNote === deferNote
    ) {
      return { proceed: false };
    }

    const row = buildReckoningRow({
      now,
      writ,
      ext,
      outcome: 'deferred',
      deferReason: reason,
      deferNote,
      ...(args.tickEventId !== undefined ? { tickEventId: args.tickEventId } : {}),
    });
    try {
      await reckoningsBook.put(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] tick: failed to persist Reckonings row for writ "${writ.id}" (dependency-defer path): ${msg}`,
      );
    }
    return { proceed: false };
  }

  /**
   * Build the dependency-injection context the tick handler closes
   * over. Threaded through the relay factory and the test-only
   * `runTick` hook so both invocation surfaces share one
   * production-faithful entry into the per-fire sequence.
   */
  function buildTickContext(): TickContext {
    return {
      get clerk(): ClerkApi {
        return clerk;
      },
      get stacks(): StacksApi {
        return stacks;
      },
      get reckoningsBook(): Book<ReckoningDoc> {
        return reckoningsBook;
      },
      getActiveScheduler: () => activeScheduler,
      resolveConfig,
      resolveSchedulerConfig,
      isSourceRegistered: (source: string) => registry.has(source),
      resolveActiveTargetPhase,
      alreadyConsidered,
      buildReckoningRow,
      runDependencyGate,
    };
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

  // The tick relay closes over the same dependency-injection context
  // the test-only `runTick` hook drives. Construct it once outside
  // the apparatus declaration so the `supportKit.relays` slot can
  // reference it without re-building the context per kit-resolve.
  const tickContext = buildTickContext();
  const tickRelay: RelayDefinition = createTickRelay(tickContext);

  // The Reckoner's own kit-contributed standing order. Hard-coded
  // schedule per the originating brief — there is no
  // `reckoner.tickSchedule` operator knob in this commission. The
  // standing order has no `id` field per the kit-standing-orders
  // additive-merge model: operators can append their own orders but
  // cannot disable or override this one. When Clockworks is not
  // installed, this contribution is simply never consumed and the
  // tick never fires — the apparatus continues to boot.
  const tickStandingOrder: StandingOrder = {
    schedule: RECKONER_TICK_SCHEDULE,
    run: RECKONER_TICK_RELAY_NAME,
  };

  const plugin: Plugin = {
    apparatus: {
      // `requires: ['clerk']` (D22). Stacks is transitive through
      // Clerk's hard-require. Clockworks is a soft `recommends`
      // (D5): the periodic tick relay only fires when Clockworks is
      // installed; the Reckoner's `petition()` / `withdraw()` and
      // its registries continue to work without it.
      requires: ['clerk'],
      recommends: ['clockworks'],

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
      //
      // The `reckoner.tick` relay and its `@every 60s` standing
      // order are also kit-contributed here. Together they become
      // the single evaluation entry: every fire of the standing
      // order runs the per-tick sequence end-to-end.
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
        relays: [tickRelay],
        standingOrders: [tickStandingOrder],
      },

      start(ctx: StartupContext): void {
        // Resolve the Clerk handle inside start() so the closure
        // captures the populated provides object — at this point
        // the `requires: ['clerk']` declaration has guaranteed
        // Clerk has already started.
        clerk = guild().apparatus<ClerkApi>('clerk');
        // Stacks is reached transitively via Clerk's hard-require
        // (D22). Resolving it here keeps the topology declaration
        // minimal while letting the tick handler read `clerk/writs`.
        stacks = guild().apparatus<StacksApi>('stacks');
        reckoningsBook = stacks.book<ReckoningDoc>('reckoner', 'reckonings');

        // ── Staleness-snapshot CDC watcher ───────────────────────
        //
        // Phase-2 (post-commit) watcher on the Reckoner's own
        // `reckonings` book. Every `create` event runs the snapshot
        // handler, which derives the writ's current ReckonerStatus
        // from the new row plus the prior snapshot and persists it
        // back through `clerk.setWritStatus(writId, 'reckoner', next)`.
        //
        // Phase-2 is deliberate: a snapshot-write failure must never
        // roll back the journal entry that drove it. The Reckonings
        // row is the durable record; the snapshot is best-effort
        // derived state. (Pure-observation guarantee — see the
        // staleness-snapshot module's top-of-file commentary and
        // D5 of the originating brief.)
        //
        // Registration timing matches the Clerk children-behavior
        // cascade and the Lattice pulse dispatcher: registered in
        // `start()` ahead of `phase:started`, so the watcher closes
        // before the first event flows.
        const stalenessHandler = createStalenessHandler({ clerk });
        stacks.watch<ReckoningDoc>(
          'reckoner',
          'reckonings',
          stalenessHandler,
          { failOnError: false },
        );

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
        // on the first tick. There is no catch-up scan and no CDC
        // subscription — pre-existing held petitions are picked up
        // by the first tick after `phase:started`.
        ctx.on('phase:started', () => {
          registrySealed = true;
          schedulerRegistrySealed = true;
          activeScheduler = resolveActiveScheduler();
        });
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
    runTick: (event = null) => runTickHandler(tickContext, event ?? null),
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
