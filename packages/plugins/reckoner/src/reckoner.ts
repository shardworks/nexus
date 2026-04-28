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
  PetitionRequest,
  PetitionerDescriptor,
  Priority,
  ReckonerApi,
  ReckonerConfig,
  ReckonerExt,
  ReckoningDoc,
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
  let stacks: StacksApi | undefined;
  let reckoningsBook: Book<ReckoningDoc> | undefined;

  /**
   * Always-approve scheduling stub (D4). Returns the outcome to apply
   * to a held petition once it has cleared the source / disabled /
   * registration gates. Hardcoded private function (D13) — not
   * exported and not configurable. The Reckoner-core scheduling
   * commission introduces its own seam when it lands.
   */
  function evaluateScheduler(_writ: WritDoc): 'accepted' {
    return 'accepted';
  }

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
    declineReason?: 'source_unregistered';
    remediationHint?: string;
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
   * Accept path (writes a row, transitions to the active target):
   *   - source registered, OR source unregistered with
   *     `enforceRegistration: false`. Routes through the always-
   *     approve stub (D4).
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

    // Accept path. Always-approve stub (D4).
    const decision = evaluateScheduler(writ);
    if (decision !== 'accepted') return; // pleased the type checker

    if (await alreadyConsidered(reckoningsBook, writ.id, writ.updatedAt)) {
      return;
    }

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
        `[reckoner] cdc: failed to transition writ "${writ.id}" to "${target}" (accept path): ${msg}`,
      );
      return;
    }

    const row = buildReckoningRow({
      now,
      writ,
      ext,
      outcome: 'accepted',
    });
    try {
      await reckoningsBook.put(row);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[reckoner] cdc: failed to persist Reckonings row for writ "${writ.id}" (accept path): ${msg}`,
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
      // `requires: ['clerk']` only (D22). No explicit Stacks
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

      // Reckoner-owned book (D1, D9, D21). Stacks materialises this
      // during the Wire phase from the supportKit declaration; the
      // Wire-phase ensure call carries the index set forward to the
      // backend. The Reckoner is the sole writer.
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

        // Seal the registry on the framework's `phase:started`
        // signal — the same moment Clerk seals its writ-type
        // registry (D5). Any post-seal registration attempt throws
        // a sealed-registry error patterned on Clerk's `[clerk]
        // registerWritType:` diagnostic (D5).
        ctx.on('phase:started', () => {
          registrySealed = true;
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

        // ── Startup catch-up scan (D12) ─────────────────────────
        // Held petitions pre-dating apparatus startup are picked
        // up here. The watcher is already registered, so events
        // arriving during the scan are observed; idempotency
        // guards prevent double-counting if an event arrives for
        // a writ the scan also picks up.
        await runCatchUpScan();
      },
    },
  };

  const hooks: ReckonerTestHooks = {
    registerKitPetitioners,
    isSealed: () => registrySealed,
    sealRegistry: () => {
      registrySealed = true;
    },
    handleWritsChange: (event) => handleWritsChange(event),
    runCatchUpScan: () => runCatchUpScan(),
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
