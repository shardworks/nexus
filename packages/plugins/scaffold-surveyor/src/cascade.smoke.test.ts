/**
 * cascade.smoke.test.ts — End-to-end cascade smoke test.
 *
 * Exercises the full surveying cascade in an in-process test guild:
 *
 *   vision → survey-vision → charges → survey-charge → pieces → survey-piece → mandates
 *
 * The LLM anima session is replaced by a deterministic stub per the commission
 * spec §"Smoke test ships with the commission". The goal is exercising cascade
 * plumbing — writ creation, CDC dispatch, petition routing, cascade chaining
 * across three layers, and survey-writ resolution — rather than validating
 * Claude prompt quality.
 *
 * ## Why the CDC observer is implemented inline
 *
 * The real CDC observer lives in `@shardworks/surveyor-apparatus`
 * (`packages/plugins/surveyor/src/cdc.ts`). When loaded via the pnpm symlink
 * from scaffold-surveyor's `node_modules/`, Node.js resolves transitive
 * imports from the *real path* of the surveyor package directory. That
 * directory has no `node_modules/` of its own — `zod` and other runtime
 * dependencies are absent — so the import fails with
 * `ERR_MODULE_NOT_FOUND`.
 *
 * The inline `createInlineCDCObserver()` function replicates the CDC
 * observer's externally-visible contract:
 *   - Fires on create/update events for vision/charge/piece writ types.
 *   - Ignores survey-*, mandate, and delete events.
 *   - Checks D24 dedupe (parentId + parentUpdatedAt gate).
 *   - Creates the survey writ with the `Survey <type>: <title>` convention.
 *   - Stamps `ext['surveyor']` with surveyorId/rigVersion/parentUpdatedAt.
 *   - Calls `reckoner.petition` with `source: '${surveyorId}.${surveyType}'`.
 *
 * This behavior is verified against the CDC test suite in the surveyor
 * apparatus package (see packages/plugins/surveyor/src/cdc.test.ts).
 *
 * All external apparatus packages are imported as `import type` only —
 * their runtime values are never referenced (same constraint as engine.test.ts).
 * Only `@shardworks/nexus-core` is value-imported (direct dependency).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import type { StacksApi, ChangeEvent } from '@shardworks/stacks-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { ReckonerApi } from '@shardworks/reckoner-apparatus';

import scaffoldSurveyorPlugin from './scaffold-surveyor.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

const tsNow = (): string => new Date().toISOString();

/** Monotonic counter for unique test writ IDs (no generateId import needed). */
let idSeq = 0;
const nextWritId = (): string => `w-smoke-${(++idSeq).toString().padStart(4, '0')}`;

const byType = (writs: WritDoc[], type: string): WritDoc[] =>
  writs.filter((w) => w.type === type);

// ── Inline CDC observer ─────────────────────────────────────────────────────

/**
 * Inline replication of @shardworks/surveyor-apparatus cartograph CDC observer.
 *
 * Implements the same externally-visible contract as `createCartographObserver`
 * in packages/plugins/surveyor/src/cdc.ts. Behaviour verified against the CDC
 * test suite (cdc.test.ts) in that package.
 *
 * Used instead of importing the real module due to the ESM peer-dependency
 * resolution constraint described in the file header.
 */
function createInlineCDCObserver(opts: {
  stacks: StacksApi;
  clerk: ClerkApi;
  reckoner: ReckonerApi;
  surveyorId: string;
  surveyorVersion?: string;
}): (event: ChangeEvent<WritDoc>) => Promise<void> {
  const { stacks, clerk, reckoner, surveyorId, surveyorVersion } = opts;

  // vision → survey-vision, charge → survey-charge, piece → survey-piece
  const SURVEY_TYPE: Record<string, string> = {
    vision: 'survey-vision',
    charge: 'survey-charge',
    piece: 'survey-piece',
  };

  return async (event: ChangeEvent<WritDoc>): Promise<void> => {
    // Only react to create and update events.
    if (event.type !== 'create' && event.type !== 'update') return;
    const writ: WritDoc = event.entry;

    // Only cartograph node types trigger survey writ emission.
    const surveyType = SURVEY_TYPE[writ.type];
    if (!surveyType) return;

    // D24 dedupe gate: skip if a non-terminal survey writ already exists
    // for the same (parentId, parentUpdatedAt) pair.
    const existing = await stacks.readBook('clerk', 'writs').find({});
    const hasExisting = (existing as WritDoc[]).some(
      (w) =>
        w.type === surveyType &&
        w.parentId === writ.id &&
        !['completed', 'failed', 'cancelled'].includes(w.phase) &&
        (w.ext?.['surveyor'] as Record<string, unknown> | undefined)?.parentUpdatedAt ===
          writ.updatedAt,
    );
    if (hasExisting) return;

    await (stacks.transaction as (fn: () => Promise<void>) => Promise<void>)(async () => {
      // Create the survey writ.
      const surveyWrit = await clerk.post({
        type: surveyType,
        title: `Survey ${writ.type}: ${writ.title}`,
        body: '',
        parentId: writ.id,
      } as unknown as Parameters<ClerkApi['post']>[0]);

      // Stamp ext['surveyor'] (matches the real CDC observer's stamp).
      await clerk.setWritExt(surveyWrit.id, 'surveyor', {
        surveyorId,
        ...(surveyorVersion != null ? { rigVersion: surveyorVersion } : {}),
        parentUpdatedAt: writ.updatedAt,
      });

      // Dispatch the survey writ via reckoner.petition (replaces Spider routing).
      await reckoner.petition(surveyWrit.id, {
        source: `${surveyorId}.${surveyType}`,
      });
    });
  };
}

// ── Cascade environment factory ────────────────────────────────────────────

/**
 * Helpers passed to the petition stub so it can create cartograph children
 * without holding direct references to the internal mock clerk.
 */
interface StubHelpers {
  createCharge(parentId: string, title: string): Promise<void>;
  createPiece(parentId: string, title: string): Promise<void>;
  createMandate(parentId: string, title: string): Promise<void>;
}

/**
 * Called when reckoner.petition fires for a survey writ. The stub must create
 * zero or more children via helpers and then return. Throwing fails the test.
 *
 * @param source  Petition source string, e.g. 'scaffold-surveyor.survey-vision'.
 * @param parentId  parentId of the survey writ (the cartograph node being surveyed).
 * @param h  Child-creation helpers.
 */
type PetitionStub = (source: string, parentId: string, h: StubHelpers) => Promise<void>;

interface CascadeEnv {
  /** All writs created during the cascade (vision + survey writs + nodes + mandates). */
  writs: WritDoc[];
  /** Create the fixture vision to kick off the cascade. */
  applyVision(title: string, body?: string): Promise<WritDoc>;
}

/**
 * Build an in-process cascade environment.
 *
 * Wire-up order:
 *   1. In-memory writ store + event bus (CDC observers registered via stacks.watch).
 *   2. Mock clerk that creates writs and emits ChangeEvents.
 *   3. Stub reckoner that calls `petitionStub` and marks survey writs completed.
 *   4. Inline CDC observer registered in the event bus (replicates surveyor CDC).
 *   5. setGuild() with the assembled apparatus map.
 *
 * The inline CDC fires when clerk.post creates a writ, which recursively
 * triggers the cascade until mandates (non-cartograph nodes) are created.
 */
function buildCascadeEnv(petitionStub: PetitionStub): CascadeEnv {
  const writs: WritDoc[] = [];
  const watchHandlers: Array<(e: ChangeEvent<WritDoc>) => Promise<void>> = [];

  // ── Event bus ─────────────────────────────────────────────────────────────

  async function emitWritEvent(event: ChangeEvent<WritDoc>): Promise<void> {
    // Sequential propagation: each cascade step completes before the next begins.
    for (const h of watchHandlers) {
      await h(event);
    }
  }

  // ── Mock stacks ───────────────────────────────────────────────────────────

  const stacks = {
    watch(
      _owner: string,
      _book: string,
      handler: (e: ChangeEvent<WritDoc>) => Promise<void>,
      _opts?: unknown,
    ): void {
      watchHandlers.push(handler);
    },
    readBook(_owner: string, _book: string) {
      // Fresh cascade — no pre-existing survey writs. D24 gate always passes.
      return { find: async (): Promise<WritDoc[]> => [] };
    },
    transaction: async (fn: () => Promise<void>): Promise<void> => fn(),
  } as unknown as StacksApi;

  // ── Mock clerk ────────────────────────────────────────────────────────────
  //
  // Creates writs in-memory and immediately emits ChangeEvents so the inline
  // CDC observer fires for every new cartograph node writ.

  const clerk = {
    registerWritType(): void { /* no-op in smoke test */ },

    post: async (req: Partial<WritDoc>): Promise<WritDoc> => {
      const writ: WritDoc = {
        id: nextWritId(),
        type: req.type ?? 'mandate',
        phase: 'new',
        title: req.title ?? '',
        body: req.body ?? '',
        ...(req.parentId != null ? { parentId: req.parentId } : {}),
        createdAt: tsNow(),
        updatedAt: tsNow(),
      };
      writs.push(writ);
      await emitWritEvent({ type: 'create', ownerId: 'clerk', book: 'writs', entry: writ });
      return writ;
    },

    setWritExt: async (writId: string, pluginId: string, value: unknown): Promise<WritDoc> => {
      const w = writs.find((x) => x.id === writId);
      if (w) w.ext = { ...(w.ext ?? {}), [pluginId]: value };
      return w ?? ({ id: writId } as unknown as WritDoc);
    },

    link: async (): Promise<void> => { /* no-op */ },
  } as unknown as ClerkApi;

  // ── Stub helpers (passed to petitionStub) ─────────────────────────────────
  //
  // Route through clerk.post so the inline CDC fires for every new node.

  const helpers: StubHelpers = {
    createCharge: (parentId, title) =>
      clerk.post({
        type: 'charge', parentId, title, body: 'Stub charge body',
      } as Partial<WritDoc>).then(() => {}),
    createPiece: (parentId, title) =>
      clerk.post({
        type: 'piece', parentId, title, body: 'Stub piece body',
      } as Partial<WritDoc>).then(() => {}),
    createMandate: (parentId, title) =>
      clerk.post({
        type: 'mandate', parentId, title, body: 'Stub mandate body',
      } as Partial<WritDoc>).then(() => {}),
  };

  // ── Stub reckoner ─────────────────────────────────────────────────────────
  //
  // Replaces Spider/Loom/Animator. When petition fires for a survey writ, the
  // stub deterministically creates children (via petitionStub), then marks the
  // survey writ as completed. This simulates "Spider dispatched the survey writ,
  // the anima session ran, and the rig resolved."

  const reckoner = {
    petition: async (surveyWritId: string, ext: unknown): Promise<WritDoc> => {
      const source = (ext as Record<string, unknown>).source as string | undefined ?? '';
      const surveyWrit = writs.find((w) => w.id === surveyWritId);

      if (surveyWrit?.parentId) {
        await petitionStub(source, surveyWrit.parentId, helpers);
        // Mark the survey writ as completed to simulate Spider resolving the session.
        // Direct mutation (no event) avoids triggering the outcome observer,
        // which needs clerk.setStatus not available in this mock.
        surveyWrit.phase = 'completed';
        surveyWrit.updatedAt = tsNow();
      }

      return surveyWrit ?? ({ id: surveyWritId } as unknown as WritDoc);
    },
  } as unknown as ReckonerApi;

  // ── Guild setup ───────────────────────────────────────────────────────────

  const apparatusMap: Record<string, unknown> = { stacks, clerk, reckoner };

  const fakeGuild: Guild = {
    home: '/tmp/cascade-smoke',
    apparatus<T>(name: string): T {
      const a = apparatusMap[name];
      if (!a) throw new Error(`[cascade-env] apparatus "${name}" not installed`);
      return a as T;
    },
    tryApparatus<T>(name: string): T | null {
      return (apparatusMap[name] as T) ?? null;
    },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return { name: 'cascade-smoke', nexus: '0.0.0', plugins: [] }; },
    kits() { return []; },
    apparatuses() { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);

  // ── Register the inline CDC observer ─────────────────────────────────────
  //
  // Read the active surveyor descriptor from the scaffold-surveyor kit so the
  // inline CDC uses the correct id/version values (the same ones the real CDC
  // would read from the registry).

  const descriptor = scaffoldSurveyorPlugin.kit.surveyors[0];
  const cdcObserver = createInlineCDCObserver({
    stacks,
    clerk,
    reckoner,
    surveyorId: descriptor.id,
    surveyorVersion: descriptor.version,
  });

  // Register the CDC observer via the same stacks.watch mechanism the real
  // surveyor apparatus uses. Events emitted by clerk.post propagate through
  // this handler, triggering the cascade.
  stacks.watch('clerk', 'writs', cdcObserver);

  return {
    writs,
    applyVision: (title: string, body = ''): Promise<WritDoc> =>
      clerk.post({ type: 'vision', title, body } as Partial<WritDoc>),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('cascade smoke — full three-layer cascade', () => {
  afterEach(() => clearGuild());

  it(
    'vision create triggers: survey-vision → 2 charges → 2 survey-charges ' +
      '→ 2 pieces → 2 survey-pieces → 2 mandates (12 writs total)',
    async () => {
      // Deterministic stub: 2 charges per vision, 1 piece per charge, 1 mandate per piece.
      const env = buildCascadeEnv(async (source, parentId, h) => {
        if (source === 'scaffold-surveyor.survey-vision') {
          await h.createCharge(parentId, 'Charge A');
          await h.createCharge(parentId, 'Charge B');
        } else if (source === 'scaffold-surveyor.survey-charge') {
          await h.createPiece(parentId, `Piece of ${parentId}`);
        } else if (source === 'scaffold-surveyor.survey-piece') {
          await h.createMandate(parentId, `Mandate of ${parentId}`);
        }
      });

      const vision = await env.applyVision('Cake Bakery', 'A full-stack bakery system');

      // ── Vision ──────────────────────────────────────────────────────────
      const visions = byType(env.writs, 'vision');
      assert.equal(visions.length, 1, 'one vision writ');
      assert.equal(visions[0].id, vision.id, 'vision id matches return value');

      // ── Survey-vision: created by CDC when vision is posted ──────────────
      const surveyVisions = byType(env.writs, 'survey-vision');
      assert.equal(surveyVisions.length, 1, 'one survey-vision');
      assert.equal(surveyVisions[0].parentId, vision.id, 'survey-vision.parentId = vision.id');
      assert.equal(
        surveyVisions[0].phase, 'completed',
        'survey-vision dispatched (petition fired) and resolved',
      );

      // ── Charges: created by stub when survey-vision is dispatched ────────
      const charges = byType(env.writs, 'charge');
      assert.equal(charges.length, 2, 'two charges');
      for (const c of charges) {
        assert.equal(c.parentId, vision.id, `charge ${c.id} parentId = vision.id`);
      }

      // ── Survey-charges: one per charge, dispatched and resolved ──────────
      const surveyCharges = byType(env.writs, 'survey-charge');
      assert.equal(surveyCharges.length, 2, 'two survey-charges (one per charge)');
      const chargeIds = new Set(charges.map((c) => c.id));
      for (const sc of surveyCharges) {
        assert.ok(chargeIds.has(sc.parentId!), `survey-charge ${sc.id} parentId in charge ids`);
        assert.equal(sc.phase, 'completed', `survey-charge ${sc.id} resolved`);
      }

      // ── Pieces: one per charge ────────────────────────────────────────────
      const pieces = byType(env.writs, 'piece');
      assert.equal(pieces.length, 2, 'two pieces (one per charge)');
      for (const p of pieces) {
        assert.ok(chargeIds.has(p.parentId!), `piece ${p.id} parentId in charge ids`);
      }

      // ── Survey-pieces: one per piece, dispatched and resolved ────────────
      const surveyPieces = byType(env.writs, 'survey-piece');
      assert.equal(surveyPieces.length, 2, 'two survey-pieces (one per piece)');
      const pieceIds = new Set(pieces.map((p) => p.id));
      for (const sp of surveyPieces) {
        assert.ok(pieceIds.has(sp.parentId!), `survey-piece ${sp.id} parentId in piece ids`);
        assert.equal(sp.phase, 'completed', `survey-piece ${sp.id} resolved`);
      }

      // ── Mandates: one per piece; CDC ignores mandates → cascade ends ─────
      const mandates = byType(env.writs, 'mandate');
      assert.equal(mandates.length, 2, 'two mandates (one per piece)');
      for (const m of mandates) {
        assert.ok(pieceIds.has(m.parentId!), `mandate ${m.id} parentId in piece ids`);
      }

      // ── Total writ count ──────────────────────────────────────────────────
      // 1 vision + 1 survey-vision + 2 charges + 2 survey-charges +
      // 2 pieces  + 2 survey-pieces  + 2 mandates = 12 writs.
      assert.equal(env.writs.length, 12, 'total 12 writs in three-layer cascade');
    },
  );

  it('CDC stamps ext[surveyor] on each survey writ (surveyorId + parentUpdatedAt)', async () => {
    const env = buildCascadeEnv(async (source, parentId, h) => {
      if (source === 'scaffold-surveyor.survey-vision') {
        await h.createCharge(parentId, 'Charge X');
      }
    });

    await env.applyVision('Ext stamp test');

    const surveyVisions = byType(env.writs, 'survey-vision');
    assert.equal(surveyVisions.length, 1);

    const surveyorExt = surveyVisions[0].ext?.['surveyor'] as
      | Record<string, unknown>
      | undefined;
    assert.ok(surveyorExt !== undefined, 'ext[surveyor] must be stamped by CDC observer');
    assert.equal(surveyorExt.surveyorId, 'scaffold-surveyor', 'surveyorId = scaffold-surveyor');
    assert.ok(
      typeof surveyorExt.parentUpdatedAt === 'string' && surveyorExt.parentUpdatedAt.length > 0,
      'parentUpdatedAt is a non-empty string',
    );
  });

  it('survey writ title follows the "Survey <layer>: <parent title>" convention', async () => {
    const env = buildCascadeEnv(async () => { /* zero children */ });

    await env.applyVision('My Vision Title');

    const sv = byType(env.writs, 'survey-vision')[0];
    assert.equal(sv.title, 'Survey vision: My Vision Title');
  });

  it('parentUpdatedAt in ext matches the parent writ updatedAt (D24 envelope)', async () => {
    const env = buildCascadeEnv(async () => { /* zero children */ });

    const vision = await env.applyVision('D24 envelope test');

    const sv = byType(env.writs, 'survey-vision')[0];
    const surveyorExt = sv.ext?.['surveyor'] as Record<string, unknown>;
    assert.equal(
      surveyorExt.parentUpdatedAt,
      vision.updatedAt,
      'parentUpdatedAt in ext[surveyor] matches vision.updatedAt',
    );
  });
});

describe('cascade smoke — zero-children outcome', () => {
  afterEach(() => clearGuild());

  it('stub creates no children: cascade terminates cleanly; survey-vision completed with no charges', async () => {
    const env = buildCascadeEnv(async (_source, _parentId, _h) => {
      // Zero-children: do nothing. Per spec: "Zero children is an explicit valid outcome."
    });

    const vision = await env.applyVision('Ambiguous Vision', 'Too vague to decompose right now');

    assert.equal(byType(env.writs, 'vision').length, 1, 'vision created');

    const surveyVisions = byType(env.writs, 'survey-vision');
    assert.equal(surveyVisions.length, 1, 'survey-vision still created by CDC');
    assert.equal(surveyVisions[0].parentId, vision.id);
    assert.equal(
      surveyVisions[0].phase, 'completed',
      'survey-vision resolves even with zero children',
    );

    assert.equal(byType(env.writs, 'charge').length, 0, 'no charges');
    assert.equal(byType(env.writs, 'survey-charge').length, 0, 'no survey-charges');
    assert.equal(env.writs.length, 2, 'only vision + survey-vision exist');
  });
});

describe('cascade smoke — per-layer CDC writ type routing', () => {
  afterEach(() => clearGuild());

  it('CDC emits survey-charge when a charge is created; ignores mandate type', async () => {
    const env = buildCascadeEnv(async (source, parentId, h) => {
      if (source === 'scaffold-surveyor.survey-vision') {
        await h.createCharge(parentId, 'Single charge');
        // Also create a mandate (should NOT trigger CDC)
        await h.createMandate(parentId, 'Inline mandate');
      }
      // survey-charge petition: create no children — stop here.
    });

    await env.applyVision('Layer routing check');

    assert.equal(byType(env.writs, 'survey-vision').length, 1, 'survey-vision from vision');
    assert.equal(byType(env.writs, 'survey-charge').length, 1, 'survey-charge from charge');
    assert.equal(byType(env.writs, 'survey-piece').length, 0, 'no survey-piece (no pieces)');
    // Mandate should exist but NOT have a survey writ.
    assert.equal(byType(env.writs, 'mandate').length, 1, 'mandate exists');
    const surveyWrits = env.writs.filter((w) => w.type.startsWith('survey-'));
    assert.equal(
      surveyWrits.length, 2,
      'exactly two survey writs (survey-vision + survey-charge); CDC ignores mandates',
    );
  });

  it('CDC emits survey-piece when a piece is created', async () => {
    const env = buildCascadeEnv(async (source, parentId, h) => {
      if (source === 'scaffold-surveyor.survey-vision') {
        await h.createCharge(parentId, 'Charge');
      } else if (source === 'scaffold-surveyor.survey-charge') {
        await h.createPiece(parentId, 'Piece');
      }
      // survey-piece petition: create no mandates — stop here.
    });

    await env.applyVision('Piece CDC check');

    assert.equal(byType(env.writs, 'survey-vision').length, 1);
    assert.equal(byType(env.writs, 'survey-charge').length, 1);
    assert.equal(byType(env.writs, 'survey-piece').length, 1, 'one survey-piece from piece');
  });

  it('D24: existing non-terminal survey writ with matching parentUpdatedAt blocks re-emission', async () => {
    // Build an env where stacks.readBook returns a pre-existing survey writ.
    // We use a custom env here rather than buildCascadeEnv to override find.

    const writs: WritDoc[] = [];
    const watchHandlers: Array<(e: ChangeEvent<WritDoc>) => Promise<void>> = [];

    async function emitWritEvent(event: ChangeEvent<WritDoc>): Promise<void> {
      for (const h of watchHandlers) await h(event);
    }

    let visionWrit: WritDoc | undefined;

    const stacks = {
      watch(_o: string, _b: string, handler: (e: ChangeEvent<WritDoc>) => Promise<void>): void {
        watchHandlers.push(handler);
      },
      readBook(_o: string, _b: string) {
        return {
          find: async (): Promise<WritDoc[]> => {
            // After the vision writ has been set, return a "pre-existing" survey-vision
            // with the same parentId and parentUpdatedAt → triggers the D24 skip.
            if (!visionWrit) return [];
            return [
              {
                id: 'w-pre-survey',
                type: 'survey-vision',
                phase: 'open', // non-terminal
                title: `Survey vision: ${visionWrit.title}`,
                body: '',
                parentId: visionWrit.id,
                createdAt: tsNow(),
                updatedAt: tsNow(),
                ext: {
                  surveyor: {
                    surveyorId: 'scaffold-surveyor',
                    parentUpdatedAt: visionWrit.updatedAt,
                  },
                },
              },
            ] as WritDoc[];
          },
        };
      },
      transaction: async (fn: () => Promise<void>): Promise<void> => fn(),
    } as unknown as StacksApi;

    const clerk = {
      registerWritType(): void {},
      post: async (req: Partial<WritDoc>): Promise<WritDoc> => {
        const writ: WritDoc = {
          id: nextWritId(),
          type: req.type ?? 'mandate',
          phase: 'new',
          title: req.title ?? '',
          body: req.body ?? '',
          ...(req.parentId != null ? { parentId: req.parentId } : {}),
          createdAt: tsNow(),
          updatedAt: tsNow(),
        };
        writs.push(writ);
        if (req.type === 'vision') visionWrit = writ; // captured for D24 mock
        await emitWritEvent({ type: 'create', ownerId: 'clerk', book: 'writs', entry: writ });
        return writ;
      },
      setWritExt: async (writId: string, pluginId: string, value: unknown): Promise<WritDoc> => {
        const w = writs.find((x) => x.id === writId);
        if (w) w.ext = { ...(w.ext ?? {}), [pluginId]: value };
        return w ?? ({ id: writId } as unknown as WritDoc);
      },
      link: async (): Promise<void> => {},
    } as unknown as ClerkApi;

    const reckoner = {
      petition: async (_id: string, _ext: unknown): Promise<WritDoc> => {
        return {} as WritDoc;
      },
    } as unknown as ReckonerApi;

    const fakeGuild: Guild = {
      home: '/tmp/dedupe-test',
      apparatus<T>(name: string): T {
        const m: Record<string, unknown> = { stacks, clerk, reckoner };
        return m[name] as T;
      },
      tryApparatus<T>(name: string): T | null {
        const m: Record<string, unknown> = { stacks, clerk, reckoner };
        return (m[name] as T) ?? null;
      },
      config<T>(): T { return {} as T; },
      writeConfig(): void {},
      guildConfig(): GuildConfig { return { name: 'dedupe-test', nexus: '0.0.0', plugins: [] }; },
      kits() { return []; },
      apparatuses() { return []; },
      failedPlugins() { return []; },
      startupWarnings() { return []; },
    };
    setGuild(fakeGuild);

    const descriptor = scaffoldSurveyorPlugin.kit.surveyors[0];
    const cdcObserver = createInlineCDCObserver({
      stacks, clerk, reckoner,
      surveyorId: descriptor.id,
      surveyorVersion: descriptor.version,
    });
    stacks.watch('clerk', 'writs', cdcObserver);

    await clerk.post({ type: 'vision', title: 'Repeated Vision', body: '' } as Partial<WritDoc>);

    // The D24 gate should have fired: visionWrit is set in `post`, and the find()
    // returns a pre-existing non-terminal survey with matching parentUpdatedAt.
    // Therefore no new survey-vision should be created (only the vision itself).
    assert.equal(byType(writs, 'survey-vision').length, 0, 'D24 gate: no new survey-vision created');
    assert.equal(writs.length, 1, 'only the vision writ exists');
  });
});
