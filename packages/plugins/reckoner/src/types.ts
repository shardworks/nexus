/**
 * Reckoner public types.
 *
 * The Reckoner is the petitioner-scheduler apparatus. It owns the
 * kit-static petitioner registry, exposes the canonical
 * `petition()` / `withdraw()` helpers (Workflow 2 in the contract
 * document), and surfaces inspection helpers for downstream
 * consumers (the future CDC handler, the vision-keeper kit, the
 * patron-bridge apparatus).
 *
 * This file is the single source of public-symbol truth — every
 * type a downstream import touches lives here, including
 * `ReckonerApi`. The factory in `./reckoner.ts` builds a value
 * matching `ReckonerApi`; see that module for how `provides` is
 * assembled.
 *
 * See: docs/architecture/petitioner-registration.md  (the load-
 * bearing contract document) and
 * docs/architecture/apparatus/reckoner.md (the apparatus shape).
 */

import type { WritDoc } from '@shardworks/clerk-apparatus';

// ── Priority ──────────────────────────────────────────────────────────

/**
 * The five-dimensional priority shape declared on every petition.
 *
 * Each dimension answers a different question; the Reckoner
 * combines them at consideration time. See §3 of the contract
 * document for the semantics of every value.
 */
export interface Priority {
  /** Relationship to the product vision (vision-blocker, vision-violator, vision-advancer, vision-neutral). */
  visionRelation:
    | 'vision-blocker'
    | 'vision-violator'
    | 'vision-advancer'
    | 'vision-neutral';
  /** Magnitude axis (critical, serious, moderate, minor). */
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  /** What fraction of the system is affected (whole-product, major-area, minor-area). */
  scope: 'whole-product' | 'major-area' | 'minor-area';
  /** Two genuinely-independent time-pressure axes. */
  time: {
    /** Drift sentinel / accumulating-debt flag. */
    decay: boolean;
    /** Hard deadline if any (ISO date string), else `null`. */
    deadline: string | null;
  };
  /** Multi-valued classification tag set. NOT a priority axis — describes what kind of work this is. */
  domain: Array<
    | 'security'
    | 'compliance'
    | 'cost'
    | 'feature'
    | 'quality'
    | 'infrastructure'
    | 'documentation'
    | 'research'
    | 'ergonomics'
  >;
}

/** Allowed values for `Priority.visionRelation`. */
export const VISION_RELATION_VALUES = [
  'vision-blocker',
  'vision-violator',
  'vision-advancer',
  'vision-neutral',
] as const;

/** Allowed values for `Priority.severity`. */
export const SEVERITY_VALUES = [
  'critical',
  'serious',
  'moderate',
  'minor',
] as const;

/** Allowed values for `Priority.scope`. */
export const SCOPE_VALUES = [
  'whole-product',
  'major-area',
  'minor-area',
] as const;

/** Allowed values for `Priority.domain[]`. */
export const DOMAIN_VALUES = [
  'security',
  'compliance',
  'cost',
  'feature',
  'quality',
  'infrastructure',
  'documentation',
  'research',
  'ergonomics',
] as const;

// ── Complexity ────────────────────────────────────────────────────────

/**
 * Petitioner-side coarse cost estimate. See §4 of the contract
 * document for the calibration ranges. Refined by the Astrolabe at
 * plan time; this exists for early-stage trade-offs only.
 */
export type ComplexityTier =
  | 'mechanical'
  | 'bounded'
  | 'exploratory'
  | 'open-ended';

// ── Reckoner ext shape ────────────────────────────────────────────────

/**
 * Shape of `writ.ext['reckoner']` — the contract slot a petitioner
 * stamps onto a writ to opt it into Reckoner consideration.
 *
 * The Reckoner observes CDC on the writs book and treats every writ
 * carrying this slot in `new` phase as a held petition. Petitioners
 * can stamp it directly via `clerk.post()` + `clerk.setWritExt()`
 * (Workflow 1) or use the `petition()` helper (Workflow 2) for
 * default-fill and validation; both paths produce the same on-disk
 * shape.
 */
export interface ReckonerExt {
  /** Identifies the petitioner. Must be `{pluginId}.{kebab-suffix}`. */
  source: string;
  /** Fully-defaulted multi-dimensional priority. */
  priority: Priority;
  /** Optional petitioner-side coarse cost estimate. */
  complexity?: ComplexityTier;
  /** Opaque petitioner-defined data; the Reckoner stores but does not introspect. */
  payload?: unknown;
  /** Additive non-priority metadata (multi-instance discrimination, observability hints). */
  labels?: Record<string, string>;
}

// ── Petition request ──────────────────────────────────────────────────

/**
 * Argument shape for `ReckonerApi.petition()`.
 *
 * The helper takes a partial priority — every omitted dimension is
 * filled with the contract default at the helper boundary (D15) so
 * petitioners with one strongly-felt dimension do not need to
 * supply the entire shape.
 *
 * Writ-shape fields (`type`, `title`, `body`, `codex`, `parentId`)
 * pass straight through to `clerk.post()`. The optional `type`
 * mirrors `PostCommissionRequest.type?` exactly — when omitted, the
 * guild's default writ type is used (D21).
 */
export interface PetitionRequest {
  // ── writ fields (passed through to clerk.post) ───────────────────
  /** Writ type. Defaults to the guild's configured default writ type. */
  type?: string;
  /** Short human-readable title describing the petition. */
  title: string;
  /** Detail text. */
  body: string;
  /** Optional target codex name. */
  codex?: string;
  /** Create this writ as a child of the specified parent writ. */
  parentId?: string;

  // ── ext.reckoner fields ──────────────────────────────────────────
  /** Petitioner source id. Required. Matched against the registry. */
  source: string;
  /** Partial priority — omitted dimensions fall back to defaults at the helper boundary. */
  priority?: Partial<Priority>;
  /** Optional coarse complexity estimate. */
  complexity?: ComplexityTier;
  /** Opaque petitioner-defined data. */
  payload?: unknown;
  /** Additive metadata labels. */
  labels?: Record<string, string>;
}

// ── Petitioner descriptor ─────────────────────────────────────────────

/**
 * Kit-contributed petitioner descriptor.
 *
 * Petitioners declare themselves via a `petitioners` kit
 * contribution — an array of these objects under that key on a kit
 * (or apparatus supportKit). The Reckoner consumes the array at
 * boot, validates each entry's source-id grammar, and seals the
 * registry at `phase:started`.
 *
 * The contract floor is intentionally minimal (D19, patron
 * override): only `source` and `description`. Enrichment fields
 * (contributing plugin id, timestamps, etc.) wait for a named
 * consumer.
 */
export interface PetitionerDescriptor {
  /** Fully-qualified source id of the form `{pluginId}.{kebab-suffix}`. */
  source: string;
  /** Human-readable description of what this petitioner emits. */
  description: string;
}

// ── Reckoner config ───────────────────────────────────────────────────

/**
 * Reckoner apparatus configuration — lives under the `reckoner`
 * key in `guild.json`.
 *
 * Both fields are optional. Missing config is treated as defaults
 * (`enforceRegistration: false`, `disabledSources: []`). When the
 * block is present, type mismatches throw fail-loud at the read
 * site (D12).
 */
export interface ReckonerConfig {
  /**
   * Controls how the Reckoner handles petitions whose source is
   * not in the registry. `false` (default) — log a warning and
   * proceed. `true` — decline the petition fail-loud at the
   * helper boundary.
   */
  enforceRegistration?: boolean;
  /**
   * Per-source disable list. Petitions from any source in this
   * array are skipped (left in `new` phase). The list is re-read
   * on each call so operators can hot-edit `guild.json` without a
   * restart (D20).
   */
  disabledSources?: string[];
}

// Augment GuildConfig so `guild().guildConfig().reckoner` is typed
// without requiring a manual type parameter at the call site.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    reckoner?: ReckonerConfig;
  }
}

// ── API surface ───────────────────────────────────────────────────────

/**
 * The Reckoner's runtime API — retrieved via
 * `guild().apparatus<ReckonerApi>('reckoner')`.
 *
 * The surface is a coherent set of helpers for petitioner authoring
 * (`petition`, `withdraw`) and registry inspection
 * (`isSourceRegistered`, `isSourceDisabled`, `listPetitioners`).
 * The CDC handler that lands in the follow-on commission consumes
 * the inspection helpers per-event; the petitioner authoring
 * helpers are the canonical Workflow-2 path for petitioners.
 */
export interface ReckonerApi {
  /**
   * Post a writ in `new` phase with `writ.ext['reckoner']` set
   * correctly.
   *
   * Resolves the source against the registry. When the source is
   * not registered:
   *   - `enforceRegistration: true` — throws fail-loud, no writ
   *     is created.
   *   - `enforceRegistration: false` (default) — logs a warning
   *     and proceeds.
   *
   * Validates every priority dimension against its enum. Applies
   * defaults to omitted priority dimensions (field-by-field
   * merge). Calls `clerk.post()` then `clerk.setWritExt()` — the
   * two-step non-atomic flow described in D7.
   *
   * Returns the resulting writ document (post-`setWritExt`, so
   * `writ.ext.reckoner` is populated on the returned shape).
   */
  petition(request: PetitionRequest): Promise<WritDoc>;

  /**
   * Withdraw a held writ by transitioning it to `cancelled`.
   *
   * Thin wrapper around `clerk.transition(writId, 'cancelled',
   * { resolution: reason })`. No source check, no owner check,
   * no ext check. Reason is passed through verbatim — undefined
   * stays undefined (no fabricated default).
   */
  withdraw(writId: string, reason?: string): Promise<WritDoc>;

  /**
   * Return `true` when `source` is in the kit-static petitioner
   * registry. Reads the sealed in-memory registry; cheap to call.
   */
  isSourceRegistered(source: string): boolean;

  /**
   * Return `true` when `source` is currently in the live
   * `disabledSources` config list. Re-reads `guild.json` on
   * every call so operators can hot-edit (D20).
   */
  isSourceDisabled(source: string): boolean;

  /**
   * Return projections of every registered petitioner descriptor.
   *
   * Surfaces the contract floor only — `source` and `description`
   * — per D19. Returns an empty array when no petitioners are
   * registered.
   */
  listPetitioners(): PetitionerDescriptor[];
}
