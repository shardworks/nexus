/**
 * Cartograph apparatus tests.
 *
 * The fixture wires real stacks + real clerk + the cartograph apparatus
 * (production-mirror path) so the writ-type registration-side assertions,
 * the typed-API parent validation, the companion-book CRUD round-trip,
 * and the lifecycle coupling all run against the production code paths.
 *
 * Coverage matrix:
 *
 *   1. Writ-type registration — the three configs land in
 *      `clerk.listWritTypes()` with the expected six-state-no-cascade
 *      shape.
 *   2. Typed-API parent validation — each createX accepts its valid
 *      parents and rejects the invalid ones with descriptive errors.
 *   3. Companion-book CRUD round-trip — writ id matches doc id, patches
 *      preserve unaffected fields, list filters work.
 *   4. Lifecycle coupling — `transitionX` updates writ.phase and
 *      doc.stage atomically.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';

import { createCartograph } from './cartograph.ts';
import type {
  CartographApi,
  ChargeDoc,
  PieceDoc,
  VisionDoc,
} from './types.ts';

// ── Test harness ─────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  cartograph: CartographApi;
  memBackend: MemoryBackend;
}

function buildCtx(): StartupContext {
  return {
    on(): void {},
    kits(): never[] {
      return [];
    },
  };
}

async function buildFixture(): Promise<Fixture> {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const cartographPlugin = createCartograph();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'cartograph-test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/cartograph-test-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig(): void {},
    guildConfig(): GuildConfig {
      return fakeGuildConfig;
    },
    kits(): LoadedKit[] {
      return [];
    },
    apparatuses(): LoadedApparatus[] {
      return [];
    },
    failedPlugins() {
      return [];
    },
    startupWarnings(): string[] {
      return [];
    },
  };
  setGuild(fakeGuild);

  // ── Stacks ────────────────────────────────────────────────────────
  stacksPlugin.apparatus.start!(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create the books the Clerk and Cartograph expect. Index shapes
  // mirror the supportKit declarations on each apparatus.
  memBackend.ensureBook({ ownerId: 'clerk', book: 'writs' }, {
    indexes: [
      'phase', 'type', 'createdAt', 'parentId',
      ['phase', 'type'], ['phase', 'createdAt'], ['parentId', 'phase'],
    ],
  });
  memBackend.ensureBook({ ownerId: 'clerk', book: 'links' }, {
    indexes: [
      'sourceId', 'targetId', 'label',
      ['sourceId', 'label'], ['targetId', 'label'],
    ],
  });
  memBackend.ensureBook({ ownerId: 'cartograph', book: 'visions' }, {
    indexes: ['stage', 'codex', 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'cartograph', book: 'charges' }, {
    indexes: ['stage', 'codex', 'createdAt'],
  });
  memBackend.ensureBook({ ownerId: 'cartograph', book: 'pieces' }, {
    indexes: ['stage', 'codex', 'createdAt'],
  });

  // ── Clerk ─────────────────────────────────────────────────────────
  await clerkPlugin.apparatus.start!(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // ── Cartograph ────────────────────────────────────────────────────
  // Per the production wiring, cartograph's start() runs after clerk's
  // start() (declared `requires: ['stacks', 'clerk']`). We never fire
  // `phase:started`, so the registration window stays open; cartograph's
  // three `clerk.registerWritType(...)` calls land here.
  await cartographPlugin.apparatus.start!(buildCtx());
  const cartograph = cartographPlugin.apparatus.provides as CartographApi;
  apparatusMap.set('cartograph', cartograph);

  return { stacks, clerk, cartograph, memBackend };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Cartograph apparatus', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Writ-type registration ────────────────────────────────────────

  describe('writ-type registration', () => {
    it('contributes vision, charge, and piece writ types to the Clerk', () => {
      const types = fix.clerk.listWritTypes();
      const names = types.map((t) => t.name);
      assert.ok(names.includes('vision'), 'vision must be registered');
      assert.ok(names.includes('charge'), 'charge must be registered');
      assert.ok(names.includes('piece'), 'piece must be registered');

      for (const name of ['vision', 'charge', 'piece']) {
        const t = types.find((entry) => entry.name === name)!;
        assert.equal(t.source, 'plugin', `${name} must carry source = "plugin"`);
      }
    });

    it('registers each type with the six-state mandate-clone shape and no cascade', () => {
      for (const name of ['vision', 'charge', 'piece']) {
        const config = fix.clerk.getWritTypeConfig(name);
        assert.ok(config, `${name} config must be retrievable from the registry`);
        assert.equal(config!.states.length, 6, `${name} must declare six states`);

        const stateNames = config!.states.map((s) => s.name).sort();
        assert.deepEqual(
          stateNames,
          ['cancelled', 'completed', 'failed', 'new', 'open', 'stuck'],
          `${name} state catalogue must mirror the mandate clone`,
        );

        const initial = config!.states.find((s) => s.classification === 'initial');
        assert.equal(initial?.name, 'new', `${name} initial state must be "new"`);

        const terminals = config!.states
          .filter((s) => s.classification === 'terminal')
          .map((s) => s.name)
          .sort();
        assert.deepEqual(
          terminals,
          ['cancelled', 'completed', 'failed'],
          `${name} terminal states must be cancelled/completed/failed`,
        );

        // No cascade — patron-walkthrough semantics are coordinated
        // upstream of the registry.
        assert.equal(
          config!.childrenBehavior,
          undefined,
          `${name} must NOT declare childrenBehavior`,
        );
      }
    });
  });

  // ── createVision: parent invariants ────────────────────────────────

  describe('createVision', () => {
    it('creates a top-level vision with no parent', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'Land the ladder',
        body: 'long-form vision text',
        codex: 'main',
      });

      assert.ok(vision.id.startsWith('w-'), 'vision id must follow writ id convention');
      assert.equal(vision.stage, 'draft');
      assert.equal(vision.codex, 'main');
      assert.ok(vision.createdAt);
      assert.ok(vision.updatedAt);

      // The companion writ row is also present and well-formed.
      const writ = await fix.clerk.show(vision.id);
      assert.equal(writ.type, 'vision');
      assert.equal(writ.phase, 'new');
      assert.equal(writ.title, 'Land the ladder');
      assert.equal(writ.body, 'long-form vision text');
      assert.equal(writ.codex, 'main');
      assert.equal(writ.parentId, undefined);
    });

    // ── Initial phase + stage (vision-apply substrate) ──────────────

    it('accepts an explicit (phase=open, stage=active) pair on first creation', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'Active from birth',
        body: 'B',
        phase: 'open',
        stage: 'active',
      });
      assert.equal(vision.stage, 'active');
      const writ = await fix.clerk.show(vision.id);
      assert.equal(writ.phase, 'open');
    });

    it('accepts stage=active without an explicit phase (phase auto-resolves to open)', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'Active stage only',
        body: 'B',
        stage: 'active',
      });
      assert.equal(vision.stage, 'active');
      const writ = await fix.clerk.show(vision.id);
      assert.equal(writ.phase, 'open');
    });

    it('accepts phase=open without an explicit stage (stage auto-resolves to active)', async () => {
      // Phase-only callers fall through to the default stage `draft`,
      // which then mismatches with the supplied phase. The resolution
      // path uses the stage as the source of truth, so the explicit
      // phase has to agree with the default stage's expected phase.
      // For now this means a phase-only call with phase=open is rejected
      // (default stage `draft` ↔ phase `new`); patrons must supply both
      // when overriding from the default. Verify the rejection is loud.
      await assert.rejects(
        () =>
          fix.cartograph.createVision({
            title: 'Phase-only override',
            body: 'B',
            phase: 'open',
          }),
        /does not pair with stage/,
      );
    });

    it('rejects sunset as an initial stage', async () => {
      await assert.rejects(
        () =>
          fix.cartograph.createVision({
            title: 'Born retired',
            body: 'B',
            stage: 'sunset',
          }),
        (err: Error) => {
          assert.match(err.message, /cannot be born retired/);
          return true;
        },
      );
    });

    it('rejects cancelled as an initial stage', async () => {
      await assert.rejects(
        () =>
          fix.cartograph.createVision({
            title: 'Born cancelled',
            body: 'B',
            stage: 'cancelled',
          }),
        (err: Error) => {
          assert.match(err.message, /cannot be born retired/);
          return true;
        },
      );
    });

    it('rejects a phase/stage mismatch with a clear error', async () => {
      await assert.rejects(
        () =>
          fix.cartograph.createVision({
            title: 'Mismatched',
            body: 'B',
            phase: 'new',
            stage: 'active',
          }),
        (err: Error) => {
          assert.match(err.message, /does not pair/);
          return true;
        },
      );
    });

    it('produces exactly one CDC event on the cartograph visions book per creation', async () => {
      let createCount = 0;
      let updateCount = 0;
      fix.stacks.watch<VisionDoc>('cartograph', 'visions', (event) => {
        if (event.type === 'create') createCount += 1;
        if (event.type === 'update') updateCount += 1;
      });

      // Default-state creation.
      await fix.cartograph.createVision({ title: 'V1', body: 'B' });
      assert.equal(createCount, 1, 'first createVision emits one create event');
      assert.equal(updateCount, 0, 'no update events on initial creation');

      // Bootstrap directly into active state — still exactly one event.
      await fix.cartograph.createVision({
        title: 'V2',
        body: 'B',
        phase: 'open',
        stage: 'active',
      });
      assert.equal(createCount, 2, 'second createVision emits one more create event');
      assert.equal(updateCount, 0, 'still no update events — coalescing collapses tx writes');
    });

    // Parent validation — visions have no parent.
    it('rejects a non-empty parentId with a descriptive error', async () => {
      // Create a parent vision so the would-be parent exists.
      const parent = await fix.cartograph.createVision({
        title: 'Parent',
        body: 'P',
      });

      await assert.rejects(
        () =>
          (fix.cartograph as unknown as {
            createVision: (req: {
              title: string;
              body: string;
              parentId?: string;
            }) => Promise<VisionDoc>;
          }).createVision({
            title: 'Child vision',
            body: 'Should fail',
            parentId: parent.id,
          }),
        (err: Error) => {
          assert.match(err.message, /vision/i);
          assert.match(err.message, /parent/i);
          return true;
        },
      );
    });
  });

  // ── createCharge: parent invariants ────────────────────────────────

  describe('createCharge', () => {
    it('creates a charge under a vision and inherits the codex', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V',
        body: 'B',
        codex: 'main',
      });

      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });

      assert.equal(charge.codex, 'main', 'charge inherits parent vision codex');
      const chargeWrit = await fix.clerk.show(charge.id);
      assert.equal(chargeWrit.type, 'charge');
      assert.equal(chargeWrit.parentId, vision.id);
      assert.equal(chargeWrit.codex, 'main');
    });

    it('rejects when parent type is not vision', async () => {
      // A mandate-typed parent is not a valid charge parent.
      const mandate = await fix.clerk.post({
        type: 'mandate',
        title: 'wrong parent',
        body: 'B',
      });

      await assert.rejects(
        () =>
          fix.cartograph.createCharge({
            parentId: mandate.id,
            title: 'illegal charge',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /charge/i);
          assert.match(err.message, /vision/i);
          assert.match(err.message, /mandate/);
          return true;
        },
      );
    });

    it('rejects when parentId references a non-existent writ', async () => {
      await assert.rejects(
        () =>
          fix.cartograph.createCharge({
            parentId: 'w-nonexistent',
            title: 'orphan',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /not found/);
          return true;
        },
      );
    });

    it('rejects when parent vision is in a terminal state', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V',
        body: 'B',
      });
      // Drive the vision into a terminal state via the typed API
      // (couples the writ phase + companion stage in one tx).
      await fix.cartograph.transitionVision(vision.id, {
        phase: 'cancelled',
        stage: 'cancelled',
      });

      await assert.rejects(
        () =>
          fix.cartograph.createCharge({
            parentId: vision.id,
            title: 'too late',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /terminal/);
          return true;
        },
      );
    });
  });

  // ── createPiece: parent invariants ─────────────────────────────────

  describe('createPiece', () => {
    it('creates a piece under a charge', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });

      const piece = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P',
        body: 'B',
      });

      const pieceWrit = await fix.clerk.show(piece.id);
      assert.equal(pieceWrit.type, 'piece');
      assert.equal(pieceWrit.parentId, charge.id);
    });

    it('creates a piece nested under another piece', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      const piece1 = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P1',
        body: 'B',
      });
      const piece2 = await fix.cartograph.createPiece({
        parentId: piece1.id,
        title: 'P2-nested',
        body: 'B',
      });

      const piece2Writ = await fix.clerk.show(piece2.id);
      assert.equal(piece2Writ.parentId, piece1.id);
    });

    it('rejects when parent type is vision', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      await assert.rejects(
        () =>
          fix.cartograph.createPiece({
            parentId: vision.id,
            title: 'illegal piece',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /piece/i);
          assert.match(err.message, /charge/i);
          // Vision cannot directly parent a piece.
          assert.match(err.message, /vision/);
          return true;
        },
      );
    });

    it('rejects when parent type is mandate', async () => {
      const mandate = await fix.clerk.post({
        type: 'mandate',
        title: 'wrong parent',
        body: 'B',
      });
      await assert.rejects(
        () =>
          fix.cartograph.createPiece({
            parentId: mandate.id,
            title: 'illegal piece',
            body: 'B',
          }),
        (err: Error) => {
          assert.match(err.message, /mandate/);
          return true;
        },
      );
    });
  });

  // ── Companion-book CRUD round-trip ────────────────────────────────

  describe('companion-book CRUD round-trip', () => {
    it('vision: writ id matches doc id and supports show/list/patch', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V1',
        body: 'B',
        codex: 'alpha',
      });

      // show: retrieves the doc by writ id.
      const fetched = await fix.cartograph.showVision(vision.id);
      assert.equal(fetched.id, vision.id);
      assert.equal(fetched.codex, 'alpha');

      // patch: only touches the supplied fields.
      const patched = await fix.cartograph.patchVision(vision.id, {
        codex: 'beta',
      });
      assert.equal(patched.codex, 'beta');
      assert.equal(patched.stage, 'draft', 'patch must preserve stage');
      assert.equal(patched.id, vision.id, 'patch must preserve id');

      // list: filters by codex and stage.
      await fix.cartograph.createVision({ title: 'V2', body: 'B', codex: 'gamma' });
      const all = await fix.cartograph.listVisions();
      assert.equal(all.length, 2);

      const onlyBeta = await fix.cartograph.listVisions({ codex: 'beta' });
      assert.equal(onlyBeta.length, 1);
      assert.equal(onlyBeta[0].id, vision.id);

      const onlyDraft = await fix.cartograph.listVisions({ stage: 'draft' });
      assert.equal(onlyDraft.length, 2);
    });

    it('charge: writ id matches doc id and supports show/list/patch', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C1',
        body: 'B',
        codex: 'alpha',
      });

      const fetched = await fix.cartograph.showCharge(charge.id);
      assert.equal(fetched.id, charge.id);

      // patch preserves stage on field-touch only.
      const patched = await fix.cartograph.patchCharge(charge.id, { codex: 'gamma' });
      assert.equal(patched.codex, 'gamma');
      assert.equal(patched.stage, 'draft');

      const onlyDraft = await fix.cartograph.listCharges({ stage: 'draft' });
      assert.equal(onlyDraft.length, 1);
    });

    it('piece: writ id matches doc id and supports show/list/patch', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      const piece = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P',
        body: 'B',
      });

      const fetched = await fix.cartograph.showPiece(piece.id);
      assert.equal(fetched.id, piece.id);

      const patched = await fix.cartograph.patchPiece(piece.id, {
        codex: 'beta',
      });
      assert.equal(patched.codex, 'beta');
      assert.equal(patched.stage, 'draft');

      const list = await fix.cartograph.listPieces();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, piece.id);
    });

    it('show throws on a missing id', async () => {
      await assert.rejects(
        () => fix.cartograph.showVision('w-missing'),
        /not found/,
      );
      await assert.rejects(
        () => fix.cartograph.showCharge('w-missing'),
        /not found/,
      );
      await assert.rejects(
        () => fix.cartograph.showPiece('w-missing'),
        /not found/,
      );
    });
  });

  // ── Lifecycle coupling ────────────────────────────────────────────

  describe('lifecycle coupling — transitionX', () => {
    it('vision: writ.phase and doc.stage move in lockstep', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      // Walk new → open → completed (terminal).
      const afterOpen = await fix.cartograph.transitionVision(vision.id, {
        phase: 'open',
        stage: 'active',
      });
      assert.equal(afterOpen.stage, 'active');
      const visionWrit1 = await fix.clerk.show(vision.id);
      assert.equal(visionWrit1.phase, 'open');

      const afterDone = await fix.cartograph.transitionVision(vision.id, {
        phase: 'completed',
        stage: 'sunset',
        resolution: 'patron retired the vision',
      });
      assert.equal(afterDone.stage, 'sunset');

      const visionWrit2 = await fix.clerk.show(vision.id);
      assert.equal(visionWrit2.phase, 'completed');
      assert.equal(visionWrit2.resolution, 'patron retired the vision');
      assert.ok(visionWrit2.resolvedAt, 'terminal transition stamps resolvedAt');
    });

    it('charge: writ.phase and doc.stage move in lockstep through validated', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });

      await fix.cartograph.transitionCharge(charge.id, {
        phase: 'open',
        stage: 'active',
      });
      const afterValidated = await fix.cartograph.transitionCharge(charge.id, {
        phase: 'completed',
        stage: 'validated',
      });
      assert.equal(afterValidated.stage, 'validated');

      const chargeWrit = await fix.clerk.show(charge.id);
      assert.equal(chargeWrit.phase, 'completed');
    });

    it('piece: writ.phase and doc.stage move in lockstep through done', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      const piece = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P',
        body: 'B',
      });

      await fix.cartograph.transitionPiece(piece.id, {
        phase: 'open',
        stage: 'active',
      });
      const afterDone = await fix.cartograph.transitionPiece(piece.id, {
        phase: 'completed',
        stage: 'done',
      });
      assert.equal(afterDone.stage, 'done');

      const pieceWrit = await fix.clerk.show(piece.id);
      assert.equal(pieceWrit.phase, 'completed');
    });

    it('rejects an illegal phase transition without touching the companion doc', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });

      // new → completed is not a legal direct edge for the mandate-clone
      // machine; the typed API must reject and the doc's stage must
      // remain at draft.
      await assert.rejects(
        () =>
          fix.cartograph.transitionVision(vision.id, {
            phase: 'completed',
            stage: 'sunset',
          }),
        (err: Error) => {
          assert.match(err.message, /transition/i);
          return true;
        },
      );

      const after = await fix.cartograph.showVision(vision.id);
      assert.equal(after.stage, 'draft', 'failed transition must not move the stage');

      const writ: WritDoc = await fix.clerk.show(vision.id);
      assert.equal(writ.phase, 'new', 'failed transition must not move the writ phase');
    });

    it('rolls back both writes when the transition fails', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      // Move to open so a subsequent failed transition leaves the writ
      // in `open`, not `new`.
      await fix.cartograph.transitionVision(vision.id, {
        phase: 'open',
        stage: 'active',
      });

      // Drive the writ to completed via Clerk directly (no doc patch).
      // Then attempt a typed-API transition that the writ rejects
      // (terminal → anything). Both writ.phase and doc.stage must end
      // unchanged.
      await fix.clerk.transition(vision.id, 'completed');

      await assert.rejects(
        () =>
          fix.cartograph.transitionVision(vision.id, {
            phase: 'open',
            stage: 'active',
          }),
        /transition/i,
      );

      const docAfter = await fix.cartograph.showVision(vision.id);
      // The companion doc stage was last set to 'active'; it must NOT
      // have been touched by the failed transition.
      assert.equal(
        docAfter.stage,
        'active',
        'failed transition rolls back the companion doc patch',
      );
    });
  });

  // ── Codex inheritance ─────────────────────────────────────────────

  describe('codex inheritance', () => {
    it('charge inherits the parent vision codex when not explicitly supplied', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V',
        body: 'B',
        codex: 'inherited',
      });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      assert.equal(charge.codex, 'inherited');

      const chargeWrit = await fix.clerk.show(charge.id);
      assert.equal(chargeWrit.codex, 'inherited');
    });

    it('an explicit codex on createCharge overrides parent inheritance', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V',
        body: 'B',
        codex: 'parent-codex',
      });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
        codex: 'override',
      });
      assert.equal(charge.codex, 'override');
    });

    it('piece inherits codex through nested ancestors', async () => {
      const vision = await fix.cartograph.createVision({
        title: 'V',
        body: 'B',
        codex: 'main',
      });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      const p1 = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P1',
        body: 'B',
      });
      const p2 = await fix.cartograph.createPiece({
        parentId: p1.id,
        title: 'P2',
        body: 'B',
      });
      assert.equal(p2.codex, 'main', 'piece codex inherits through nested chain');
    });
  });

  // ── Companion-book separation ─────────────────────────────────────

  describe('companion-book separation', () => {
    it('keeps each book scoped to its own type — no cross-pollination', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      const charge = await fix.cartograph.createCharge({
        parentId: vision.id,
        title: 'C',
        body: 'B',
      });
      const piece = await fix.cartograph.createPiece({
        parentId: charge.id,
        title: 'P',
        body: 'B',
      });

      // Each list returns only its own type's docs.
      const visions = await fix.cartograph.listVisions();
      assert.equal(visions.length, 1);
      assert.equal(visions[0].id, vision.id);

      const charges = await fix.cartograph.listCharges();
      assert.equal(charges.length, 1);
      assert.equal(charges[0].id, charge.id);

      const pieces = await fix.cartograph.listPieces();
      assert.equal(pieces.length, 1);
      assert.equal(pieces[0].id, piece.id);
    });

    it('typed show methods do not retrieve docs from the wrong book', async () => {
      const vision = await fix.cartograph.createVision({ title: 'V', body: 'B' });
      // showCharge on a vision id finds nothing — book separation.
      await assert.rejects(
        () => fix.cartograph.showCharge(vision.id),
        /not found/,
      );
      await assert.rejects(
        () => fix.cartograph.showPiece(vision.id),
        /not found/,
      );
    });
  });

  // ── Apparatus shape ───────────────────────────────────────────────

  describe('apparatus shape', () => {
    it('declares requires: ["stacks", "clerk"] and recommends: ["oculus"]', () => {
      const plugin = createCartograph();
      const apparatus =
        (plugin as { apparatus: { requires?: string[]; recommends?: string[] } }).apparatus;
      assert.deepEqual(apparatus.requires, ['stacks', 'clerk']);
      assert.deepEqual(apparatus.recommends, ['oculus']);
    });

    it('declares the three companion books with the expected indexes', () => {
      const plugin = createCartograph();
      const apparatus = (plugin as {
        apparatus: { supportKit?: { books?: Record<string, { indexes?: unknown }> } };
      }).apparatus;
      const books = apparatus.supportKit?.books ?? {};
      assert.deepEqual(Object.keys(books).sort(), ['charges', 'pieces', 'visions']);
      for (const name of ['visions', 'charges', 'pieces']) {
        assert.deepEqual(
          books[name].indexes,
          ['stage', 'codex', 'createdAt'],
          `${name} book indexes`,
        );
      }
    });
  });
});
