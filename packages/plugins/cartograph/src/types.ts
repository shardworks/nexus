/**
 * Cartograph — public types.
 *
 * The Cartograph contributes three writ types to the Clerk —
 * `vision`, `charge`, and `piece` — and stamps each writ with a typed
 * sub-slot under `writ.ext['cartograph']` carrying the per-type
 * lifecycle stage. Vision/charge/piece text lives on `writ.body`; the
 * stage is the only field the cartograph needs to carry as an attribute
 * of writ identity beyond what Clerk already records.
 *
 * The typed-API surface (`createX` / `showX` / `listX` / `patchX` /
 * `transitionX`) is the only sanctioned writer to the slot — every
 * mutation is composed inside one `stacks.transaction(...)` so the writ
 * row and its `ext['cartograph']` stamp commit atomically and CDC sees
 * one coalesced event per logical change. The projection types
 * (`VisionDoc` / `ChargeDoc` / `PieceDoc`) are derived views joined
 * from `writ.id`, `writ.codex`, `writ.createdAt`, `writ.updatedAt`,
 * and `writ.ext['cartograph'].stage`.
 *
 * Stage enums are per-type so each carries the domain-level vocabulary
 * relevant to its level of the decomposition ladder (see D10 in the
 * commission spec).
 */

import type { WritPhase } from '@shardworks/clerk-apparatus';

// ── Stage enums (per type) ───────────────────────────────────────────

/**
 * Lifecycle stage on a `VisionDoc`. Captures the patron-facing meaning
 * of a vision's progression separately from the writ's `phase`:
 *
 *  - `draft`     — the vision is being shaped; not yet active.
 *  - `active`    — the vision is in flight.
 *  - `sunset`    — the patron retired the vision (graceful wind-down).
 *  - `cancelled` — the vision was cancelled before reaching `sunset`.
 *
 * The typed-API `transitionVision` helper is the only sanctioned path
 * that updates this field; it writes both `writ.phase` and the
 * `ext['cartograph'].stage` slot inside one transaction so the two
 * never drift.
 */
export type VisionStage = 'draft' | 'active' | 'sunset' | 'cancelled';

/**
 * Lifecycle stage on a `ChargeDoc`. The `validated` value records the
 * patron-walkthrough acceptance moment that distinguishes a charge from
 * a piece:
 *
 *  - `draft`      — the charge is being shaped.
 *  - `active`     — the charge is in flight under its parent vision.
 *  - `validated`  — the patron walked through and accepted the charge.
 *  - `dropped`    — the charge was abandoned without acceptance.
 */
export type ChargeStage = 'draft' | 'active' | 'validated' | 'dropped';

/**
 * Lifecycle stage on a `PieceDoc`. Pieces are internal organization;
 * the `done` value records completion as a structural fact rather than
 * a patron-walkthrough fact:
 *
 *  - `draft`   — the piece is being shaped.
 *  - `active`  — the piece is in flight.
 *  - `done`    — the piece is complete.
 *  - `dropped` — the piece was abandoned.
 */
export type PieceStage = 'draft' | 'active' | 'done' | 'dropped';

// ── Cartograph ext sub-slot ──────────────────────────────────────────

/**
 * Shape of `writ.ext['cartograph']` — the cartograph's plugin-keyed
 * sub-slot under the Clerk's sanctioned `ext` metadata map. Carries the
 * per-type lifecycle stage and nothing else: codex is canonically
 * `writ.codex` (single source of truth) and timestamps are canonically
 * `writ.createdAt` / `writ.updatedAt`.
 *
 * Written exclusively by the cartograph's typed-API write paths
 * (`createX`, `transitionX`, `patchX`) through `clerk.setWritExt`,
 * preserving sibling sub-slots (e.g. `ext['surveyor']`) under
 * concurrent writers per the `setWritExt` contract.
 *
 * The stage union spans every per-type stage enum so a reader can
 * inspect the slot without first knowing the writ's type. The typed
 * projection helpers narrow it back to the per-type enum.
 */
export interface CartographExt {
  /** Lifecycle stage on the writ. Per-type enum union. */
  stage: VisionStage | ChargeStage | PieceStage;
}

// ── Companion projections ────────────────────────────────────────────

/**
 * Typed projection for a `vision` writ. Joins `writ.id`, `writ.codex`,
 * `writ.createdAt`, and `writ.updatedAt` with `stage` from
 * `writ.ext['cartograph']`. Vision text lives on `writ.body` and is not
 * part of this projection — the typed-API surface stays focused on
 * lifecycle metadata.
 *
 * The `[key: string]: unknown` index signature is retained verbatim so
 * future commissions can extend the projection non-breakingly.
 */
export interface VisionDoc {
  /** Index signature required to satisfy BookEntry. */
  [key: string]: unknown;
  /** The vision writ's id — primary key, matches the writ id. */
  id: string;
  /** Lifecycle stage. Coupled to `writ.phase` by the typed-API transition helpers. */
  stage: VisionStage;
  /** Codex this vision targets. Inherited from the writ at creation time. */
  codex?: string;
  /** ISO timestamp when the doc was created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

/**
 * Typed projection for a `charge` writ. Same shape rules as `VisionDoc`
 * — keyed by writ id, minimal fields, index signature retained verbatim
 * for forward compatibility.
 */
export interface ChargeDoc {
  /** Index signature required to satisfy BookEntry. */
  [key: string]: unknown;
  /** The charge writ's id — primary key, matches the writ id. */
  id: string;
  /** Lifecycle stage. Coupled to `writ.phase` by the typed-API transition helpers. */
  stage: ChargeStage;
  /** Codex this charge targets. Inherited from the writ at creation time. */
  codex?: string;
  /** ISO timestamp when the doc was created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

/**
 * Typed projection for a `piece` writ. Same shape rules as
 * `VisionDoc`/`ChargeDoc` — keyed by writ id, minimal fields, index
 * signature retained verbatim for forward compatibility.
 */
export interface PieceDoc {
  /** Index signature required to satisfy BookEntry. */
  [key: string]: unknown;
  /** The piece writ's id — primary key, matches the writ id. */
  id: string;
  /** Lifecycle stage. Coupled to `writ.phase` by the typed-API transition helpers. */
  stage: PieceStage;
  /** Codex this piece targets. Inherited from the writ at creation time. */
  codex?: string;
  /** ISO timestamp when the doc was created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

// ── Filters ──────────────────────────────────────────────────────────

/**
 * Filters for listing visions. Mirrors astrolabe's `PlanFilters` shape
 * with `stage` replacing `status`. Lists are ordered by `createdAt desc`.
 */
export interface VisionFilters {
  /** Filter by stage. */
  stage?: VisionStage;
  /** Filter by codex. */
  codex?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

/** Filters for listing charges. Mirrors `VisionFilters`. */
export interface ChargeFilters {
  /** Filter by stage. */
  stage?: ChargeStage;
  /** Filter by codex. */
  codex?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

/** Filters for listing pieces. Mirrors `VisionFilters`. */
export interface PieceFilters {
  /** Filter by stage. */
  stage?: PieceStage;
  /** Filter by codex. */
  codex?: string;
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── Create requests ──────────────────────────────────────────────────

/**
 * Request to create a top-level vision. Visions have no parent — passing
 * a non-empty `parentId` is rejected by the typed API.
 *
 * The optional `phase` and `stage` fields let a caller (e.g.
 * `nsg vision apply`) bootstrap a vision directly into an active state
 * inside the same atomic transaction that creates the writ row and
 * stamps `ext['cartograph']`. The phase/stage pair must match the fixed
 * mapping the typed API maintains for initial creation:
 *
 *   - phase `'new'`  paired with stage `'draft'`  (default)
 *   - phase `'open'` paired with stage `'active'`
 *
 * Terminal initial states (`sunset` / `cancelled`) are rejected — a vision
 * cannot be born retired. To retire a vision, create it then call
 * `transitionVision`.
 */
export interface CreateVisionRequest {
  /** Short human-readable title describing the vision. */
  title: string;
  /** Long-form vision text, stored on `writ.body`. */
  body: string;
  /** Optional target codex. */
  codex?: string;
  /**
   * Optional initial phase on the underlying writ. Defaults to `'new'`.
   * Must be paired with a matching `stage` per the initial-state mapping.
   */
  phase?: WritPhase;
  /**
   * Optional initial stage on `writ.ext['cartograph'].stage`. Defaults
   * to `'draft'`. Must pair with `phase` per the initial-state mapping.
   * Terminal stages (`sunset`, `cancelled`) are rejected.
   */
  stage?: VisionStage;
}

/**
 * Request to create a charge under a vision. The typed API rejects when
 * `parentId` is missing or when the parent's writ type is not `vision`.
 */
export interface CreateChargeRequest {
  /** Required: must reference an existing vision in a non-terminal state. */
  parentId: string;
  /** Short human-readable title describing the charge. */
  title: string;
  /** Detail text, stored on `writ.body`. */
  body: string;
  /** Optional target codex. Defaults to the parent vision's codex. */
  codex?: string;
}

/**
 * Request to create a piece under a charge or piece. The typed API
 * rejects when `parentId` is missing or when the parent's writ type is
 * not `charge` or `piece`.
 */
export interface CreatePieceRequest {
  /** Required: must reference an existing charge or piece in a non-terminal state. */
  parentId: string;
  /** Short human-readable title describing the piece. */
  title: string;
  /** Detail text, stored on `writ.body`. */
  body: string;
  /** Optional target codex. Defaults to the parent's codex. */
  codex?: string;
}

// ── Transition requests ──────────────────────────────────────────────

/**
 * Lifecycle-coupled transition request for a vision. The caller supplies
 * both the target `phase` and the target `stage` because the mapping is
 * not always one-to-one — for example, a vision driven to `failed` might
 * mean stage `cancelled` or stage `sunset` depending on context. The
 * typed API writes both fields atomically.
 */
export interface TransitionVisionRequest {
  /** Target phase on the underlying writ. */
  phase: WritPhase;
  /** Target stage on `writ.ext['cartograph'].stage`. */
  stage: VisionStage;
  /** Optional resolution string. Set on terminal transitions. */
  resolution?: string;
}

/**
 * Lifecycle-coupled transition request for a charge. See
 * `TransitionVisionRequest` for why both `phase` and `stage` are
 * specified explicitly.
 */
export interface TransitionChargeRequest {
  /** Target phase on the underlying writ. */
  phase: WritPhase;
  /** Target stage on `writ.ext['cartograph'].stage`. */
  stage: ChargeStage;
  /** Optional resolution string. Set on terminal transitions. */
  resolution?: string;
}

/**
 * Lifecycle-coupled transition request for a piece. See
 * `TransitionVisionRequest` for why both `phase` and `stage` are
 * specified explicitly.
 */
export interface TransitionPieceRequest {
  /** Target phase on the underlying writ. */
  phase: WritPhase;
  /** Target stage on `writ.ext['cartograph'].stage`. */
  stage: PieceStage;
  /** Optional resolution string. Set on terminal transitions. */
  resolution?: string;
}

// ── API ──────────────────────────────────────────────────────────────

/**
 * The `provides` interface for the Cartograph apparatus.
 *
 * The typed-API surface is the **only** layer that enforces the ladder's
 * parent invariants:
 *
 *   - `createVision` rejects any non-empty `parentId`.
 *   - `createCharge` rejects unless the parent's writ type is `vision`.
 *   - `createPiece`  rejects unless the parent's writ type is `charge` or `piece`.
 *
 * Raw `clerk.post({ type: 'vision' })` continues to succeed without
 * parent-type checks — the typed API is the validator. WritTypeConfig
 * deliberately carries no parentTypes/allowedChildren restrictions.
 *
 * Each `createX` opens a single `stacks.transaction(...)` and replicates
 * Clerk's `post()` validation (parent existence, parent-not-terminal,
 * codex inheritance, id generation) before writing the writ row plus the
 * `ext['cartograph']` stamp via `clerk.setWritExt`. The ext-slot stamp
 * flattens into the outer transaction so both writes commit atomically
 * and CDC sees one coalesced `create` event on the writs book.
 *
 * Each `transitionX` wraps `clerk.transition` plus a
 * `clerk.setWritExt('cartograph', { stage })` call inside one
 * `stacks.transaction`. Both inner transactions flatten via the Stacks
 * nested-tx semantics, so the writ-phase patch and the ext-slot stamp
 * commit atomically and CDC sees one coalesced `update` event. The
 * caller specifies both targets explicitly because a single phase may
 * map to multiple stages depending on context.
 */
export interface CartographApi {
  // ── Vision ──────────────────────────────────────────────────────

  /** Create a top-level vision. Rejects when `parentId` is set. */
  createVision(request: CreateVisionRequest): Promise<VisionDoc>;
  /** Show a vision by writ id. Throws if the writ is missing or carries no `ext['cartograph']` slot. */
  showVision(id: string): Promise<VisionDoc>;
  /** List visions, ordered by createdAt descending. */
  listVisions(filters?: VisionFilters): Promise<VisionDoc[]>;
  /** Patch a vision's mutable fields (codex via `clerk.edit`, stage via `setWritExt`). Returns the updated projection. */
  patchVision(id: string, fields: Partial<Omit<VisionDoc, 'id'>>): Promise<VisionDoc>;
  /** Atomically transition both the writ phase and the `ext['cartograph'].stage` slot. */
  transitionVision(id: string, request: TransitionVisionRequest): Promise<VisionDoc>;

  // ── Charge ──────────────────────────────────────────────────────

  /** Create a charge under a vision. Rejects when the parent is not a vision. */
  createCharge(request: CreateChargeRequest): Promise<ChargeDoc>;
  /** Show a charge by writ id. Throws if the writ is missing or carries no `ext['cartograph']` slot. */
  showCharge(id: string): Promise<ChargeDoc>;
  /** List charges, ordered by createdAt descending. */
  listCharges(filters?: ChargeFilters): Promise<ChargeDoc[]>;
  /** Patch a charge's mutable fields (codex via `clerk.edit`, stage via `setWritExt`). Returns the updated projection. */
  patchCharge(id: string, fields: Partial<Omit<ChargeDoc, 'id'>>): Promise<ChargeDoc>;
  /** Atomically transition both the writ phase and the `ext['cartograph'].stage` slot. */
  transitionCharge(id: string, request: TransitionChargeRequest): Promise<ChargeDoc>;

  // ── Piece ───────────────────────────────────────────────────────

  /** Create a piece under a charge or piece. Rejects on any other parent type. */
  createPiece(request: CreatePieceRequest): Promise<PieceDoc>;
  /** Show a piece by writ id. Throws if the writ is missing or carries no `ext['cartograph']` slot. */
  showPiece(id: string): Promise<PieceDoc>;
  /** List pieces, ordered by createdAt descending. */
  listPieces(filters?: PieceFilters): Promise<PieceDoc[]>;
  /** Patch a piece's mutable fields (codex via `clerk.edit`, stage via `setWritExt`). Returns the updated projection. */
  patchPiece(id: string, fields: Partial<Omit<PieceDoc, 'id'>>): Promise<PieceDoc>;
  /** Atomically transition both the writ phase and the `ext['cartograph'].stage` slot. */
  transitionPiece(id: string, request: TransitionPieceRequest): Promise<PieceDoc>;
}
