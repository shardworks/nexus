/**
 * The Cartograph — vision/charge/piece decomposition-ladder apparatus.
 *
 * Stands up the data-and-typed-API substrate for the four-level
 * decomposition ladder:
 *
 *   vision (top, patron-owned, long-lived)
 *     → charge (first decomposition, the unit of patron walkthrough)
 *       → piece (recursive, internal organization, self-nesting)
 *         → mandate (existing leaf where rigs attach)
 *
 * Three writ types (`vision`, `charge`, `piece`) are contributed to the
 * Clerk via `clerk.registerWritType` from `start()`. Each type uses a
 * six-state mandate-clone lifecycle without `childrenBehavior` cascade —
 * patron-walkthrough semantics are coordinated by the typed API and
 * downstream consumers, not by registry-side cascade rules.
 *
 * Per-writ lifecycle stage lives on the Clerk's sanctioned plugin-keyed
 * metadata slot at `writ.ext['cartograph']`, written exclusively through
 * `clerk.setWritExt` so sibling sub-slots (e.g. `ext['surveyor']`) are
 * preserved under concurrent writers. The Cartograph contributes no
 * companion books — the writ row is the single source of truth for both
 * the framework-level lifecycle (writ.phase) and the cartograph-level
 * lifecycle (`ext['cartograph'].stage`).
 *
 * The typed API is the **only** layer that enforces the ladder's parent
 * invariants — vision has no parent, `charge.parentId` must be a vision,
 * `piece.parentId` must be a charge or piece. Raw `clerk.post({ type:
 * 'vision' })` continues to succeed without parent-type checks.
 *
 * Each `createX` opens a single `stacks.transaction(...)`, replicates
 * Clerk's `post()` validation byte-for-byte (parent existence,
 * parent-not-terminal, codex inheritance, id generation), writes the
 * writ row, and stamps `ext['cartograph']` via `clerk.setWritExt`. The
 * setWritExt's inner tx flattens via Stacks' nested-tx semantics, so
 * both writes commit atomically and CDC sees one coalesced `create`
 * event on the writs book. Each `transitionX` wraps `clerk.transition`
 * + `clerk.setWritExt('cartograph', ...)` in one outer transaction;
 * both inner txs flatten and CDC sees one coalesced `update` event.
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type {
  StacksApi,
  WhereClause,
} from '@shardworks/stacks-apparatus';
import type {
  ClerkApi,
  WritDoc,
  WritPhase,
  WritTypeConfig,
} from '@shardworks/clerk-apparatus';

import type {
  CartographApi,
  CartographExt,
  ChargeDoc,
  ChargeFilters,
  ChargeStage,
  CreateChargeRequest,
  CreatePieceRequest,
  CreateVisionRequest,
  PieceDoc,
  PieceFilters,
  PieceStage,
  TransitionChargeRequest,
  TransitionPieceRequest,
  TransitionVisionRequest,
  VisionDoc,
  VisionFilters,
  VisionStage,
} from './types.ts';

import {
  visionCreate,
  visionShow,
  visionList,
  visionPatch,
  visionTransition,
  visionApply,
  chargeCreate,
  chargeShow,
  chargeList,
  chargePatch,
  chargeTransition,
  pieceCreate,
  pieceShow,
  pieceList,
  piecePatch,
  pieceTransition,
} from './tools/index.ts';

// ── Plugin identity ──────────────────────────────────────────────────

/**
 * Plugin id used as the key into `writ.ext` for the cartograph's
 * sub-slot. By convention each plugin writes under its own pluginId;
 * the cartograph's id is `'cartograph'`. Centralised here so the
 * read paths and the write paths stay in lockstep.
 */
const CARTOGRAPH_PLUGIN_ID = 'cartograph';

// ── Writ-type configs ────────────────────────────────────────────────
//
// Six-state mandate-clone byte-shape, identical to astrolabe's
// `STEP_CONFIG` / `OBSERVATION_SET_CONFIG`. NO `childrenBehavior`
// cascade — the typed API and downstream consumers coordinate
// patron-walkthrough semantics; the registry stays generic.

const VISION_CONFIG: WritTypeConfig = {
  name: 'vision',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

const CHARGE_CONFIG: WritTypeConfig = {
  name: 'charge',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

const PIECE_CONFIG: WritTypeConfig = {
  name: 'piece',
  states: [
    { name: 'new', classification: 'initial', allowedTransitions: ['open', 'cancelled'] },
    { name: 'open', classification: 'active', allowedTransitions: ['stuck', 'completed', 'failed', 'cancelled'] },
    { name: 'stuck', classification: 'active', attrs: ['stuck'], allowedTransitions: ['open', 'failed', 'cancelled'] },
    { name: 'completed', classification: 'terminal', attrs: ['success'], allowedTransitions: [] },
    { name: 'failed', classification: 'terminal', attrs: ['failure'], allowedTransitions: [] },
    { name: 'cancelled', classification: 'terminal', attrs: ['cancelled'], allowedTransitions: [] },
  ],
};

/**
 * Initial stage that pairs with a writ's `new` initial phase. The
 * typed-API `createX` methods set this in `ext['cartograph']` at
 * creation time so the slot starts in lockstep with the writ's phase.
 */
const INITIAL_STAGE = 'draft' as const;

/**
 * Allowed initial (phase, stage) pairs for `createVision`. A vision
 * cannot be born retired, so terminal stages (`sunset`, `cancelled`)
 * are deliberately absent — to drive a vision to a terminal state,
 * create it then call `transitionVision`.
 *
 * The mapping mirrors the call-site logic the on-disk vision-apply tool
 * uses when deriving the writ phase from the patron's sidecar `stage`.
 */
const VISION_INITIAL_STAGE_TO_PHASE: Record<string, WritPhase> = {
  draft: 'new',
  active: 'open',
};

/**
 * Return true when the given writ is in a terminal state per its
 * registered type config. Replicates `clerk.isTerminal()` against the
 * locally-resolved config so the call site doesn't need to round-trip
 * through the Clerk API mid-transaction.
 */
function isTerminalPhase(
  writ: WritDoc,
  getConfig: (name: string) => WritTypeConfig | undefined,
): boolean {
  const config = getConfig(writ.type);
  if (!config) {
    throw new Error(
      `[cartograph] writ "${writ.id}" carries unregistered type "${writ.type}".`,
    );
  }
  const state = config.states.find((s) => s.name === writ.phase);
  if (!state) {
    throw new Error(
      `[cartograph] writ "${writ.id}" carries phase "${writ.phase}" not declared in type "${writ.type}".`,
    );
  }
  return state.classification === 'terminal';
}

// ── Factory ──────────────────────────────────────────────────────────

export function createCartograph(): Plugin {
  let stacks: StacksApi;
  let clerk: ClerkApi;

  // ── Generic helpers ────────────────────────────────────────────────

  /**
   * Read the cartograph sub-slot off a writ. Returns `undefined` when
   * the slot is absent — the show paths interpret that as fail-loud,
   * and the list paths interpret it as a tolerant `stage: undefined`
   * projection (D7 + D18 in the commission spec).
   */
  function readCartographExt(writ: WritDoc): CartographExt | undefined {
    const slot = writ.ext?.[CARTOGRAPH_PLUGIN_ID];
    if (slot === undefined || slot === null) return undefined;
    if (typeof slot !== 'object') return undefined;
    return slot as CartographExt;
  }

  /**
   * Build the typed projection for a writ. Throws when the
   * `ext['cartograph']` slot is missing — the typed-API contract is
   * that every cartograph-typed writ stamped through `createX` carries
   * the slot, so a missing slot indicates the contract was bypassed.
   */
  function projectVision(writ: WritDoc): VisionDoc {
    const ext = readCartographExt(writ);
    if (ext === undefined) {
      throw new Error(
        `Vision "${writ.id}" not found: writ exists but is missing its ext['${CARTOGRAPH_PLUGIN_ID}'] sub-slot. ` +
          `The cartograph typed API is the only sanctioned path that stamps this slot — was the writ posted via raw clerk.post?`,
      );
    }
    return {
      id: writ.id,
      stage: ext.stage as VisionStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  function projectCharge(writ: WritDoc): ChargeDoc {
    const ext = readCartographExt(writ);
    if (ext === undefined) {
      throw new Error(
        `Charge "${writ.id}" not found: writ exists but is missing its ext['${CARTOGRAPH_PLUGIN_ID}'] sub-slot. ` +
          `The cartograph typed API is the only sanctioned path that stamps this slot — was the writ posted via raw clerk.post?`,
      );
    }
    return {
      id: writ.id,
      stage: ext.stage as ChargeStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  function projectPiece(writ: WritDoc): PieceDoc {
    const ext = readCartographExt(writ);
    if (ext === undefined) {
      throw new Error(
        `Piece "${writ.id}" not found: writ exists but is missing its ext['${CARTOGRAPH_PLUGIN_ID}'] sub-slot. ` +
          `The cartograph typed API is the only sanctioned path that stamps this slot — was the writ posted via raw clerk.post?`,
      );
    }
    return {
      id: writ.id,
      stage: ext.stage as PieceStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  /**
   * Tolerant projection used by listX endpoints (per D18). When the
   * `ext['cartograph']` slot is absent — a writ posted via raw
   * `clerk.post` rather than the typed API — the row still appears in
   * results with `stage: undefined`. Listing is a tolerant read; the
   * fail-loud behavior lives at showX (per D7).
   */
  function tolerantProjectVision(writ: WritDoc): VisionDoc {
    const ext = readCartographExt(writ);
    return {
      id: writ.id,
      stage: ext?.stage as VisionStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  function tolerantProjectCharge(writ: WritDoc): ChargeDoc {
    const ext = readCartographExt(writ);
    return {
      id: writ.id,
      stage: ext?.stage as ChargeStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  function tolerantProjectPiece(writ: WritDoc): PieceDoc {
    const ext = readCartographExt(writ);
    return {
      id: writ.id,
      stage: ext?.stage as PieceStage,
      ...(writ.codex !== undefined ? { codex: writ.codex } : {}),
      createdAt: writ.createdAt,
      updatedAt: writ.updatedAt,
    };
  }

  /**
   * Validate parent existence, not-terminal, and (optionally) the parent's
   * type. Returns the parent writ doc on success. The transactional
   * writs-book handle is passed in by the caller so all reads/writes
   * commit under a single boundary.
   */
  async function validateParent(
    txWritsBook: { get(id: string): Promise<WritDoc | null> },
    parentId: string,
    childId: string,
    options: { allowedParentTypes?: string[]; childTypeName: string },
  ): Promise<WritDoc> {
    const parent = await txWritsBook.get(parentId);
    if (!parent) {
      throw new Error(`Parent writ "${parentId}" not found.`);
    }
    if (parentId === childId) {
      throw new Error(`Cannot create a writ as its own parent.`);
    }
    if (isTerminalPhase(parent, (name) => clerk.getWritTypeConfig(name))) {
      throw new Error(
        `Cannot add children to writ "${parentId}": phase is "${parent.phase}" (terminal). Children can only be added to writs in non-terminal states.`,
      );
    }
    if (options.allowedParentTypes !== undefined) {
      if (!options.allowedParentTypes.includes(parent.type)) {
        const allowed = options.allowedParentTypes.map((t) => `"${t}"`).join(' or ');
        throw new Error(
          `[cartograph] cannot create ${options.childTypeName} under writ "${parentId}": parent type is "${parent.type}", expected ${allowed}.`,
        );
      }
    }
    return parent;
  }

  /**
   * Build the where-clause used by listX endpoints. The `stage` filter
   * uses the dot-notation field `ext.cartograph.stage` — Stacks'
   * SQLite backend translates dotted field names into `json_extract`
   * calls (see the tier3 conformance suite). Per D5, the writs book
   * carries no index on this field; cartograph row counts are small,
   * so the unindexed scan is acceptable.
   */
  function buildListWhere(filters: { stage?: string; codex?: string } | undefined, type: string): WhereClause {
    const conditions: WhereClause = [['type', '=', type]];
    if (filters?.stage !== undefined) {
      conditions.push([`ext.${CARTOGRAPH_PLUGIN_ID}.stage`, '=', filters.stage]);
    }
    if (filters?.codex !== undefined) {
      conditions.push(['codex', '=', filters.codex]);
    }
    return conditions;
  }

  // ── API ────────────────────────────────────────────────────────────

  const api: CartographApi = {
    // ── Vision ────────────────────────────────────────────────────

    async createVision(request: CreateVisionRequest): Promise<VisionDoc> {
      // Runtime guard for the typed-API parent invariant: a vision has
      // no parent. The static `CreateVisionRequest` shape does not
      // include `parentId`, but a structurally-typed caller could still
      // pass one — reject explicitly so the rule is enforced at the
      // boundary.
      const maybeParentId = (request as { parentId?: unknown }).parentId;
      if (typeof maybeParentId === 'string' && maybeParentId.length > 0) {
        throw new Error(
          '[cartograph] createVision: a vision is a top-level writ and cannot have a parent — refusing to create a vision with parentId.',
        );
      }

      // Initial-state resolution. Defaults to (phase=new, stage=draft) so
      // existing callers are unaffected. A caller may supply either or
      // both; whatever they supply must agree with the fixed mapping in
      // VISION_INITIAL_STAGE_TO_PHASE. Terminal initial states
      // (sunset/cancelled) are rejected — a vision cannot be born retired.
      const requestedStage: VisionStage = request.stage ?? INITIAL_STAGE;
      const expectedPhase = VISION_INITIAL_STAGE_TO_PHASE[requestedStage];
      if (expectedPhase === undefined) {
        throw new Error(
          `[cartograph] createVision: stage "${requestedStage}" is not a valid initial stage. ` +
            `A vision cannot be born retired — allowed initial stages are "draft" and "active". ` +
            `To drive a vision to a terminal state, create it then call transitionVision.`,
        );
      }
      const requestedPhase: WritPhase = request.phase ?? expectedPhase;
      if (requestedPhase !== expectedPhase) {
        throw new Error(
          `[cartograph] createVision: phase "${requestedPhase}" does not pair with stage "${requestedStage}". ` +
            `Allowed initial pairs are (phase=new, stage=draft) and (phase=open, stage=active).`,
        );
      }
      // Validate phase against the registered VISION_CONFIG, mirroring
      // transitionVision's defensive check. Catches an unregistered or
      // typo'd phase value before we write the writ row.
      const visionConfig = clerk.getWritTypeConfig('vision');
      if (!visionConfig) {
        throw new Error(
          '[cartograph] createVision: writ type "vision" is not registered with the Clerk.',
        );
      }
      const requestedState = visionConfig.states.find((s) => s.name === requestedPhase);
      if (!requestedState) {
        throw new Error(
          `[cartograph] createVision: phase "${requestedPhase}" is not declared in writ type "vision".`,
        );
      }

      // The createX methods cannot delegate to clerk.post because Clerk's
      // `post` does not accept an external transaction context, and the
      // writ row + ext['cartograph'] stamp must commit under one boundary.
      // Replicating Clerk's validation logic here is the cost of being a
      // typed atomic surface.
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');

        const childId = generateId('w', 6);
        const now = new Date().toISOString();

        const writ: WritDoc = {
          id: childId,
          type: 'vision',
          phase: requestedPhase,
          title: request.title,
          body: request.body,
          ...(request.codex !== undefined ? { codex: request.codex } : {}),
          createdAt: now,
          updatedAt: now,
        };

        await txWritsBook.put(writ);

        // setWritExt opens its own inner tx; nested-tx semantics flatten
        // it into the outer tx so both writes coalesce to one CDC create
        // event with the final state (writ fields + ext['cartograph']).
        const stamped = await clerk.setWritExt(
          childId,
          CARTOGRAPH_PLUGIN_ID,
          { stage: requestedStage } satisfies CartographExt,
        );
        return projectVision(stamped);
      });
    },

    async showVision(id: string): Promise<VisionDoc> {
      const writ = await clerk.show(id);
      if (writ.type !== 'vision') {
        throw new Error(`Vision "${id}" not found (writ exists but type is "${writ.type}").`);
      }
      return projectVision(writ);
    },

    async listVisions(filters?: VisionFilters): Promise<VisionDoc[]> {
      const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
      const rows = await writsBook.find({
        where: buildListWhere(filters, 'vision'),
        orderBy: ['createdAt', 'desc'],
        limit: filters?.limit ?? 20,
        ...(filters?.offset !== undefined ? { offset: filters.offset } : {}),
      });
      return rows.map(tolerantProjectVision);
    },

    async patchVision(
      id: string,
      fields: Partial<Omit<VisionDoc, 'id'>>,
    ): Promise<VisionDoc> {
      // Codex flows through `clerk.edit` so the writ row stays the
      // single source of truth (D2). Stage flows through `setWritExt`
      // so sibling sub-slots are preserved (per the setWritExt
      // contract). Both writes target the same writ row; if both are
      // requested they coalesce to one CDC update event.
      return stacks.transaction(async () => {
        // The projection type carries `[key: string]: unknown` (D6) so
        // property access on `fields` widens to `unknown`. Cast at the
        // boundary; the typed-API contract is that callers supply
        // string codex / stage values matching the projection.
        const codex = fields.codex as string | undefined;
        const stage = fields.stage as VisionStage | undefined;
        if (codex !== undefined) {
          await clerk.edit({ id, codex });
        }
        if (stage !== undefined) {
          await clerk.setWritExt(
            id,
            CARTOGRAPH_PLUGIN_ID,
            { stage } satisfies CartographExt,
          );
        }
        // Re-read so the returned projection reflects every write
        // performed in this tx (including the fall-through case where
        // neither codex nor stage was supplied — the projection still
        // returns the current state).
        const writ = await clerk.show(id);
        return projectVision(writ);
      });
    },

    async transitionVision(
      id: string,
      request: TransitionVisionRequest,
    ): Promise<VisionDoc> {
      // Lifecycle coupling: the writ phase patch and the
      // `ext['cartograph'].stage` stamp must commit atomically. Both
      // `clerk.transition` and `clerk.setWritExt` open their own inner
      // transactions; under Stacks' nested-tx semantics they flatten
      // into this outer tx, so CDC sees one coalesced update event.
      return stacks.transaction(async () => {
        const transitionFields: Partial<WritDoc> = {};
        if (request.resolution !== undefined) {
          transitionFields.resolution = request.resolution;
        }
        await clerk.transition(id, request.phase, transitionFields);

        const stamped = await clerk.setWritExt(
          id,
          CARTOGRAPH_PLUGIN_ID,
          { stage: request.stage } satisfies CartographExt,
        );
        return projectVision(stamped);
      });
    },

    // ── Charge ────────────────────────────────────────────────────

    async createCharge(request: CreateChargeRequest): Promise<ChargeDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');

        const childId = generateId('w', 6);
        const now = new Date().toISOString();
        const initialPhase = 'new';

        if (!request.parentId) {
          throw new Error(
            '[cartograph] createCharge requires a parentId — a charge must be created under a vision.',
          );
        }

        const parent = await validateParent(txWritsBook, request.parentId, childId, {
          allowedParentTypes: ['vision'],
          childTypeName: 'charge',
        });

        const codex = request.codex ?? parent.codex;

        const writ: WritDoc = {
          id: childId,
          type: 'charge',
          phase: initialPhase,
          title: request.title,
          body: request.body,
          ...(codex !== undefined ? { codex } : {}),
          parentId: request.parentId,
          createdAt: now,
          updatedAt: now,
        };

        await txWritsBook.put(writ);

        const stamped = await clerk.setWritExt(
          childId,
          CARTOGRAPH_PLUGIN_ID,
          { stage: INITIAL_STAGE } satisfies CartographExt,
        );
        return projectCharge(stamped);
      });
    },

    async showCharge(id: string): Promise<ChargeDoc> {
      const writ = await clerk.show(id);
      if (writ.type !== 'charge') {
        throw new Error(`Charge "${id}" not found (writ exists but type is "${writ.type}").`);
      }
      return projectCharge(writ);
    },

    async listCharges(filters?: ChargeFilters): Promise<ChargeDoc[]> {
      const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
      const rows = await writsBook.find({
        where: buildListWhere(filters, 'charge'),
        orderBy: ['createdAt', 'desc'],
        limit: filters?.limit ?? 20,
        ...(filters?.offset !== undefined ? { offset: filters.offset } : {}),
      });
      return rows.map(tolerantProjectCharge);
    },

    async patchCharge(
      id: string,
      fields: Partial<Omit<ChargeDoc, 'id'>>,
    ): Promise<ChargeDoc> {
      return stacks.transaction(async () => {
        const codex = fields.codex as string | undefined;
        const stage = fields.stage as ChargeStage | undefined;
        if (codex !== undefined) {
          await clerk.edit({ id, codex });
        }
        if (stage !== undefined) {
          await clerk.setWritExt(
            id,
            CARTOGRAPH_PLUGIN_ID,
            { stage } satisfies CartographExt,
          );
        }
        const writ = await clerk.show(id);
        return projectCharge(writ);
      });
    },

    async transitionCharge(
      id: string,
      request: TransitionChargeRequest,
    ): Promise<ChargeDoc> {
      return stacks.transaction(async () => {
        const transitionFields: Partial<WritDoc> = {};
        if (request.resolution !== undefined) {
          transitionFields.resolution = request.resolution;
        }
        await clerk.transition(id, request.phase, transitionFields);

        const stamped = await clerk.setWritExt(
          id,
          CARTOGRAPH_PLUGIN_ID,
          { stage: request.stage } satisfies CartographExt,
        );
        return projectCharge(stamped);
      });
    },

    // ── Piece ─────────────────────────────────────────────────────

    async createPiece(request: CreatePieceRequest): Promise<PieceDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');

        const childId = generateId('w', 6);
        const now = new Date().toISOString();
        const initialPhase = 'new';

        if (!request.parentId) {
          throw new Error(
            '[cartograph] createPiece requires a parentId — a piece must be created under a charge or piece.',
          );
        }

        const parent = await validateParent(txWritsBook, request.parentId, childId, {
          allowedParentTypes: ['charge', 'piece'],
          childTypeName: 'piece',
        });

        const codex = request.codex ?? parent.codex;

        const writ: WritDoc = {
          id: childId,
          type: 'piece',
          phase: initialPhase,
          title: request.title,
          body: request.body,
          ...(codex !== undefined ? { codex } : {}),
          parentId: request.parentId,
          createdAt: now,
          updatedAt: now,
        };

        await txWritsBook.put(writ);

        const stamped = await clerk.setWritExt(
          childId,
          CARTOGRAPH_PLUGIN_ID,
          { stage: INITIAL_STAGE } satisfies CartographExt,
        );
        return projectPiece(stamped);
      });
    },

    async showPiece(id: string): Promise<PieceDoc> {
      const writ = await clerk.show(id);
      if (writ.type !== 'piece') {
        throw new Error(`Piece "${id}" not found (writ exists but type is "${writ.type}").`);
      }
      return projectPiece(writ);
    },

    async listPieces(filters?: PieceFilters): Promise<PieceDoc[]> {
      const writsBook = stacks.readBook<WritDoc>('clerk', 'writs');
      const rows = await writsBook.find({
        where: buildListWhere(filters, 'piece'),
        orderBy: ['createdAt', 'desc'],
        limit: filters?.limit ?? 20,
        ...(filters?.offset !== undefined ? { offset: filters.offset } : {}),
      });
      return rows.map(tolerantProjectPiece);
    },

    async patchPiece(
      id: string,
      fields: Partial<Omit<PieceDoc, 'id'>>,
    ): Promise<PieceDoc> {
      return stacks.transaction(async () => {
        const codex = fields.codex as string | undefined;
        const stage = fields.stage as PieceStage | undefined;
        if (codex !== undefined) {
          await clerk.edit({ id, codex });
        }
        if (stage !== undefined) {
          await clerk.setWritExt(
            id,
            CARTOGRAPH_PLUGIN_ID,
            { stage } satisfies CartographExt,
          );
        }
        const writ = await clerk.show(id);
        return projectPiece(writ);
      });
    },

    async transitionPiece(
      id: string,
      request: TransitionPieceRequest,
    ): Promise<PieceDoc> {
      return stacks.transaction(async () => {
        const transitionFields: Partial<WritDoc> = {};
        if (request.resolution !== undefined) {
          transitionFields.resolution = request.resolution;
        }
        await clerk.transition(id, request.phase, transitionFields);

        const stamped = await clerk.setWritExt(
          id,
          CARTOGRAPH_PLUGIN_ID,
          { stage: request.stage } satisfies CartographExt,
        );
        return projectPiece(stamped);
      });
    },
  };

  // ── Apparatus ─────────────────────────────────────────────────────

  return {
    apparatus: {
      requires: ['stacks', 'clerk'],
      // Recommend `oculus` so the writs page renders the new types via
      // its type-vocabulary helper. Without oculus the data is invisible
      // to the dashboard; recommending it surfaces a clean startup
      // warning when an operator forgets.
      recommends: ['oculus'],

      supportKit: {
        // Cartograph contributes 16 patron-facing CLI tools — five per
        // (vision/charge/piece × create/show/list/patch/transition) plus
        // the on-disk authoring tool `vision-apply`. The framework
        // `nsg` auto-builder discovers them via The Instrumentarium and
        // groups them by hyphen prefix automatically (D2/D3 in the
        // commission spec). No companion books are contributed —
        // per-writ stage lives in the Clerk's `writ.ext['cartograph']`
        // sub-slot, written through `clerk.setWritExt`.
        tools: [
          visionCreate,
          visionShow,
          visionList,
          visionPatch,
          visionTransition,
          visionApply,
          chargeCreate,
          chargeShow,
          chargeList,
          chargePatch,
          chargeTransition,
          pieceCreate,
          pieceShow,
          pieceList,
          piecePatch,
          pieceTransition,
        ],
      },

      provides: api,

      start(_ctx: StartupContext): void {
        const g = guild();
        stacks = g.apparatus<StacksApi>('stacks');
        clerk = g.apparatus<ClerkApi>('clerk');

        // Register the three writ types. Cartograph's `requires: ['stacks',
        // 'clerk']` declaration ensures Clerk has already started; the
        // registration window stays open until the framework's
        // `phase:started` signal seals it.
        clerk.registerWritType(VISION_CONFIG);
        clerk.registerWritType(CHARGE_CONFIG);
        clerk.registerWritType(PIECE_CONFIG);
      },
    },
  };
}

// Re-export the type-config constants so tests can assert them without
// reaching back into the apparatus module.
export { VISION_CONFIG, CHARGE_CONFIG, PIECE_CONFIG, CARTOGRAPH_PLUGIN_ID };

// Local type re-exports kept narrow — see ./index.ts for the full surface.
export type {
  ChargeStage,
  PieceStage,
  VisionStage,
  WritPhase,
};
