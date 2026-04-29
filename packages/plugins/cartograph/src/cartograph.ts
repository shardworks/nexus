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
 * Three companion books (`visions`, `charges`, `pieces`) under owner id
 * `cartograph` shadow each writ with a typed companion document. The
 * doc's primary key is the writ id one-for-one. Vision text lives on
 * `writ.body`; the companion docs carry typed metadata only.
 *
 * The typed API is the **only** layer that enforces the ladder's parent
 * invariants — vision has no parent, `charge.parentId` must be a vision,
 * `piece.parentId` must be a charge or piece. Raw `clerk.post({ type:
 * 'vision' })` continues to succeed without parent-type checks.
 *
 * Each `createX` method opens a single `stacks.transaction(...)` and
 * writes the writ row and the companion doc inside one boundary. Parent
 * existence, parent-not-terminal, codex inheritance, and id generation
 * mirror Clerk's `post()` validation byte-for-byte. `transitionX`
 * methods update both `writ.phase` and the companion doc's `stage`
 * field atomically inside one transaction.
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild, generateId } from '@shardworks/nexus-core';
import type {
  Book,
  BookQuery,
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
 * typed-API `createX` methods set this on the companion doc at creation
 * time so the doc's stage starts in lockstep with the writ's phase.
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
  let visionsBook: Book<VisionDoc>;
  let chargesBook: Book<ChargeDoc>;
  let piecesBook: Book<PieceDoc>;

  // ── Generic helpers ────────────────────────────────────────────────

  /**
   * Build a list-style query for one of the three companion books.
   * Mirrors astrolabe's `list` body; only the field name differs (`stage`
   * vs `status`).
   */
  function buildListQuery(filters?: {
    stage?: string;
    codex?: string;
    limit?: number;
    offset?: number;
  }): BookQuery {
    const conditions: WhereClause = [];
    if (filters?.stage !== undefined) conditions.push(['stage', '=', filters.stage]);
    if (filters?.codex !== undefined) conditions.push(['codex', '=', filters.codex]);
    const limit = filters?.limit ?? 20;
    const offset = filters?.offset;
    return {
      ...(conditions.length > 0 ? { where: conditions } : {}),
      orderBy: ['createdAt', 'desc'],
      limit,
      ...(offset !== undefined ? { offset } : {}),
    };
  }

  /**
   * Validate parent existence, not-terminal, and (optionally) the parent's
   * type. Returns the parent writ doc on success. The transactional
   * writs-book handle is passed in by the caller so all reads/writes
   * commit under a single boundary.
   */
  async function validateParent(
    txWritsBook: Book<WritDoc>,
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
      // writ row + companion doc must commit under one boundary.
      // Replicating Clerk's validation logic here is the cost of being a
      // typed atomic surface.
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txVisionsBook = tx.book<VisionDoc>('cartograph', 'visions');

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

        const doc: VisionDoc = {
          id: childId,
          stage: requestedStage,
          ...(request.codex !== undefined ? { codex: request.codex } : {}),
          createdAt: now,
          updatedAt: now,
        };

        await txVisionsBook.put(doc);
        return doc;
      });
    },

    async showVision(id: string): Promise<VisionDoc> {
      const doc = await visionsBook.get(id);
      if (!doc) {
        throw new Error(`Vision "${id}" not found.`);
      }
      return doc;
    },

    async listVisions(filters?: VisionFilters): Promise<VisionDoc[]> {
      return visionsBook.find(buildListQuery(filters));
    },

    async patchVision(
      id: string,
      fields: Partial<Omit<VisionDoc, 'id'>>,
    ): Promise<VisionDoc> {
      return visionsBook.patch(id, fields);
    },

    async transitionVision(
      id: string,
      request: TransitionVisionRequest,
    ): Promise<VisionDoc> {
      // Lifecycle coupling lives on the typed API. The caller specifies
      // both target phase and target stage explicitly because a single
      // phase may map to multiple stages (e.g. failed → cancelled vs
      // failed → sunset).
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txVisionsBook = tx.book<VisionDoc>('cartograph', 'visions');

        const writ = await txWritsBook.get(id);
        if (!writ) {
          throw new Error(`Writ "${id}" not found.`);
        }

        const config = clerk.getWritTypeConfig(writ.type);
        if (!config) {
          throw new Error(
            `[cartograph] writ "${id}" carries unregistered type "${writ.type}".`,
          );
        }
        const currentState = config.states.find((s) => s.name === writ.phase);
        if (!currentState) {
          throw new Error(
            `[cartograph] writ "${id}" carries phase "${writ.phase}" not declared in type "${writ.type}".`,
          );
        }
        if (!currentState.allowedTransitions.includes(request.phase)) {
          const legal =
            currentState.allowedTransitions.length === 0
              ? 'none (terminal state)'
              : currentState.allowedTransitions.map((s) => `"${s}"`).join(', ');
          throw new Error(
            `Cannot transition writ "${id}" from "${writ.phase}" to "${request.phase}": legal transitions from "${writ.phase}" are ${legal}.`,
          );
        }
        const targetState = config.states.find((s) => s.name === request.phase);
        if (!targetState) {
          throw new Error(
            `[cartograph] writ type "${writ.type}" has no state "${request.phase}".`,
          );
        }
        const isTerminal = targetState.classification === 'terminal';

        const now = new Date().toISOString();
        const writPatch: Partial<Omit<WritDoc, 'id'>> = {
          phase: request.phase,
          updatedAt: now,
          ...(isTerminal ? { resolvedAt: now } : {}),
          ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
        };
        await txWritsBook.patch(id, writPatch);

        return txVisionsBook.patch(id, { stage: request.stage, updatedAt: now });
      });
    },

    // ── Charge ────────────────────────────────────────────────────

    async createCharge(request: CreateChargeRequest): Promise<ChargeDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txChargesBook = tx.book<ChargeDoc>('cartograph', 'charges');

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

        const doc: ChargeDoc = {
          id: childId,
          stage: INITIAL_STAGE,
          ...(codex !== undefined ? { codex } : {}),
          createdAt: now,
          updatedAt: now,
        };

        await txChargesBook.put(doc);
        return doc;
      });
    },

    async showCharge(id: string): Promise<ChargeDoc> {
      const doc = await chargesBook.get(id);
      if (!doc) {
        throw new Error(`Charge "${id}" not found.`);
      }
      return doc;
    },

    async listCharges(filters?: ChargeFilters): Promise<ChargeDoc[]> {
      return chargesBook.find(buildListQuery(filters));
    },

    async patchCharge(
      id: string,
      fields: Partial<Omit<ChargeDoc, 'id'>>,
    ): Promise<ChargeDoc> {
      return chargesBook.patch(id, fields);
    },

    async transitionCharge(
      id: string,
      request: TransitionChargeRequest,
    ): Promise<ChargeDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txChargesBook = tx.book<ChargeDoc>('cartograph', 'charges');

        const writ = await txWritsBook.get(id);
        if (!writ) {
          throw new Error(`Writ "${id}" not found.`);
        }

        const config = clerk.getWritTypeConfig(writ.type);
        if (!config) {
          throw new Error(
            `[cartograph] writ "${id}" carries unregistered type "${writ.type}".`,
          );
        }
        const currentState = config.states.find((s) => s.name === writ.phase);
        if (!currentState) {
          throw new Error(
            `[cartograph] writ "${id}" carries phase "${writ.phase}" not declared in type "${writ.type}".`,
          );
        }
        if (!currentState.allowedTransitions.includes(request.phase)) {
          const legal =
            currentState.allowedTransitions.length === 0
              ? 'none (terminal state)'
              : currentState.allowedTransitions.map((s) => `"${s}"`).join(', ');
          throw new Error(
            `Cannot transition writ "${id}" from "${writ.phase}" to "${request.phase}": legal transitions from "${writ.phase}" are ${legal}.`,
          );
        }
        const targetState = config.states.find((s) => s.name === request.phase);
        if (!targetState) {
          throw new Error(
            `[cartograph] writ type "${writ.type}" has no state "${request.phase}".`,
          );
        }
        const isTerminal = targetState.classification === 'terminal';

        const now = new Date().toISOString();
        const writPatch: Partial<Omit<WritDoc, 'id'>> = {
          phase: request.phase,
          updatedAt: now,
          ...(isTerminal ? { resolvedAt: now } : {}),
          ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
        };
        await txWritsBook.patch(id, writPatch);

        return txChargesBook.patch(id, { stage: request.stage, updatedAt: now });
      });
    },

    // ── Piece ─────────────────────────────────────────────────────

    async createPiece(request: CreatePieceRequest): Promise<PieceDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txPiecesBook = tx.book<PieceDoc>('cartograph', 'pieces');

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

        const doc: PieceDoc = {
          id: childId,
          stage: INITIAL_STAGE,
          ...(codex !== undefined ? { codex } : {}),
          createdAt: now,
          updatedAt: now,
        };

        await txPiecesBook.put(doc);
        return doc;
      });
    },

    async showPiece(id: string): Promise<PieceDoc> {
      const doc = await piecesBook.get(id);
      if (!doc) {
        throw new Error(`Piece "${id}" not found.`);
      }
      return doc;
    },

    async listPieces(filters?: PieceFilters): Promise<PieceDoc[]> {
      return piecesBook.find(buildListQuery(filters));
    },

    async patchPiece(
      id: string,
      fields: Partial<Omit<PieceDoc, 'id'>>,
    ): Promise<PieceDoc> {
      return piecesBook.patch(id, fields);
    },

    async transitionPiece(
      id: string,
      request: TransitionPieceRequest,
    ): Promise<PieceDoc> {
      return stacks.transaction(async (tx) => {
        const txWritsBook = tx.book<WritDoc>('clerk', 'writs');
        const txPiecesBook = tx.book<PieceDoc>('cartograph', 'pieces');

        const writ = await txWritsBook.get(id);
        if (!writ) {
          throw new Error(`Writ "${id}" not found.`);
        }

        const config = clerk.getWritTypeConfig(writ.type);
        if (!config) {
          throw new Error(
            `[cartograph] writ "${id}" carries unregistered type "${writ.type}".`,
          );
        }
        const currentState = config.states.find((s) => s.name === writ.phase);
        if (!currentState) {
          throw new Error(
            `[cartograph] writ "${id}" carries phase "${writ.phase}" not declared in type "${writ.type}".`,
          );
        }
        if (!currentState.allowedTransitions.includes(request.phase)) {
          const legal =
            currentState.allowedTransitions.length === 0
              ? 'none (terminal state)'
              : currentState.allowedTransitions.map((s) => `"${s}"`).join(', ');
          throw new Error(
            `Cannot transition writ "${id}" from "${writ.phase}" to "${request.phase}": legal transitions from "${writ.phase}" are ${legal}.`,
          );
        }
        const targetState = config.states.find((s) => s.name === request.phase);
        if (!targetState) {
          throw new Error(
            `[cartograph] writ type "${writ.type}" has no state "${request.phase}".`,
          );
        }
        const isTerminal = targetState.classification === 'terminal';

        const now = new Date().toISOString();
        const writPatch: Partial<Omit<WritDoc, 'id'>> = {
          phase: request.phase,
          updatedAt: now,
          ...(isTerminal ? { resolvedAt: now } : {}),
          ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
        };
        await txWritsBook.patch(id, writPatch);

        return txPiecesBook.patch(id, { stage: request.stage, updatedAt: now });
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
        books: {
          visions: { indexes: ['stage', 'codex', 'createdAt'] },
          charges: { indexes: ['stage', 'codex', 'createdAt'] },
          pieces: { indexes: ['stage', 'codex', 'createdAt'] },
        },

        // Cartograph contributes 16 patron-facing CLI tools — five per
        // (vision/charge/piece × create/show/list/patch/transition) plus
        // the on-disk authoring tool `vision-apply`. The framework
        // `nsg` auto-builder discovers them via The Instrumentarium and
        // groups them by hyphen prefix automatically (D2/D3 in the
        // commission spec).
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

        visionsBook = stacks.book<VisionDoc>('cartograph', 'visions');
        chargesBook = stacks.book<ChargeDoc>('cartograph', 'charges');
        piecesBook = stacks.book<PieceDoc>('cartograph', 'pieces');

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
export { VISION_CONFIG, CHARGE_CONFIG, PIECE_CONFIG };

// Local type re-exports kept narrow — see ./index.ts for the full surface.
export type {
  ChargeStage,
  PieceStage,
  VisionStage,
  WritPhase,
};
