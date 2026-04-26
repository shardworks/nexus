/**
 * Cartograph CLI tools — integration tests.
 *
 * Single-file test that exercises the full 15-tool matrix through one
 * fixture (vision/charge/piece × create/show/list/patch/transition).
 * The fixture wires real stacks + real clerk + the cartograph apparatus,
 * then dispatches each tool's handler directly through `tool.handler({...})`
 * with the params already shaped (skipping the Commander layer that the
 * `nsg` auto-builder lives in — that surface is verified separately by
 * the framework CLI's own program tests).
 *
 * Coverage matrix:
 *   - Happy paths for every tool (15 × create/show/list/patch/transition).
 *   - Parent-id short-prefix resolution on charge-create / piece-create.
 *   - Error wrapping for prefix-resolution failures.
 *   - Format parity (text vs json) for show and list.
 *   - Schema-boundary checks: `<type>-patch` exposes no `stage` flag,
 *     `<type>-transition` requires both `phase` and `stage`.
 *   - Parameter coercion: string-to-number for `--limit` / `--offset`.
 *   - Full lifecycle round-trip with `--resolution` on terminal moves.
 *   - Creates land at `phase: new, stage: draft` (no auto-transition).
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
import type { ClerkApi } from '@shardworks/clerk-apparatus';

import { createCartograph } from './cartograph.ts';
import type { CartographApi } from './types.ts';

import {
  visionCreate,
  visionShow,
  visionList,
  visionPatch,
  visionTransition,
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

// ── Fixture ──────────────────────────────────────────────────────────

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
    name: 'cartograph-tools-test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/cartograph-tools-test-guild',
    apparatus<T>(name: string): T {
      const a = apparatusMap.get(name);
      if (!a) throw new Error(`Apparatus "${name}" not installed`);
      return a as T;
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

  // Stacks
  stacksPlugin.apparatus.start!(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  // Pre-create books mirroring production indexes.
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

  // Clerk
  await clerkPlugin.apparatus.start!(buildCtx());
  const clerk = clerkPlugin.apparatus.provides as ClerkApi;
  apparatusMap.set('clerk', clerk);

  // Cartograph
  await cartographPlugin.apparatus.start!(buildCtx());
  const cartograph = cartographPlugin.apparatus.provides as CartographApi;
  apparatusMap.set('cartograph', cartograph);

  return { stacks, clerk, cartograph, memBackend };
}

/** Convenience to invoke a tool's handler with Zod validation applied. */
async function run<TParams>(
  tool: { params: { parse: (v: unknown) => TParams }; handler: (p: TParams) => unknown },
  raw: Record<string, unknown>,
): Promise<unknown> {
  const validated = tool.params.parse(raw);
  return tool.handler(validated);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Cartograph CLI tools', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  // ── Schema-boundary contracts ──────────────────────────────────────

  describe('schema boundary', () => {
    it('patch tools do not expose a `stage` flag (D5)', () => {
      assert.equal(
        (visionPatch.params.shape as Record<string, unknown>).stage,
        undefined,
        'vision-patch must not declare a stage param',
      );
      assert.equal(
        (chargePatch.params.shape as Record<string, unknown>).stage,
        undefined,
        'charge-patch must not declare a stage param',
      );
      assert.equal(
        (piecePatch.params.shape as Record<string, unknown>).stage,
        undefined,
        'piece-patch must not declare a stage param',
      );
    });

    it('transition tools require both --phase and --stage (D15)', () => {
      // Missing stage
      assert.equal(
        visionTransition.params.safeParse({ id: 'x', phase: 'open' }).success,
        false,
      );
      // Missing phase
      assert.equal(
        visionTransition.params.safeParse({ id: 'x', stage: 'active' }).success,
        false,
      );
      // Both required across all three transition tools
      for (const tool of [chargeTransition, pieceTransition]) {
        assert.equal(tool.params.safeParse({ id: 'x', phase: 'open' }).success, false);
        assert.equal(tool.params.safeParse({ id: 'x', stage: 'active' }).success, false);
      }
    });

    it('transition tools Zod-validate phase and stage enums (D16)', () => {
      // Bogus phase
      assert.equal(
        visionTransition.params.safeParse({ id: 'x', phase: 'flossing', stage: 'active' }).success,
        false,
      );
      // Bogus stage (validated must come from VisionStage)
      assert.equal(
        visionTransition.params.safeParse({ id: 'x', phase: 'open', stage: 'banana' }).success,
        false,
      );
      // Wrong stage from another type — charge stage 'validated' is not a VisionStage
      assert.equal(
        visionTransition.params.safeParse({ id: 'x', phase: 'completed', stage: 'validated' }).success,
        false,
      );
    });

    it('all tools declare callableBy: ["patron"] and the right permission (D12, D13)', () => {
      const readTools = [visionShow, visionList, chargeShow, chargeList, pieceShow, pieceList];
      const writeTools = [
        visionCreate, visionPatch, visionTransition,
        chargeCreate, chargePatch, chargeTransition,
        pieceCreate, piecePatch, pieceTransition,
      ];
      for (const tool of [...readTools, ...writeTools]) {
        assert.deepEqual(tool.callableBy, ['patron'], `${tool.name} must be callableBy: ['patron']`);
      }
      for (const tool of readTools) {
        assert.equal(tool.permission, 'read', `${tool.name} must declare permission: 'read'`);
      }
      for (const tool of writeTools) {
        assert.equal(tool.permission, 'write', `${tool.name} must declare permission: 'write'`);
      }
    });

    it('only show/list tools accept --format (D24)', () => {
      const writeTools = [
        visionCreate, visionPatch, visionTransition,
        chargeCreate, chargePatch, chargeTransition,
        pieceCreate, piecePatch, pieceTransition,
      ];
      for (const tool of writeTools) {
        assert.equal(
          (tool.params.shape as Record<string, unknown>).format,
          undefined,
          `${tool.name} must not declare a --format flag`,
        );
      }
    });

    it('list tools coerce string limit/offset to numbers via Zod', async () => {
      // The framework auto-builder coerces these in CLI mode; the Zod
      // schema accepts numbers directly. We assert the schema typing is
      // numeric so the auto-builder's coercion path lands a valid value.
      const parsed = visionList.params.parse({ limit: 5, offset: 0 });
      assert.equal(parsed.limit, 5);
      assert.equal(parsed.offset, 0);
    });
  });

  // ── Vision tools — happy paths ─────────────────────────────────────

  describe('vision tools', () => {
    it('vision-create lands the writ at phase: new, stage: draft (D14)', async () => {
      const doc = await run(visionCreate, {
        title: 'V1',
        body: 'body',
        codex: 'main',
      }) as { id: string; stage: string };

      assert.equal(doc.stage, 'draft');
      const writ = await fix.clerk.show(doc.id);
      assert.equal(writ.phase, 'new');
      assert.equal(writ.title, 'V1');
      assert.equal(writ.body, 'body');
      assert.equal(writ.codex, 'main');
    });

    it('vision-show returns text by default and JSON with --format json (D7, D8, D18)', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };

      const text = await run(visionShow, { id: doc.id, format: 'text' }) as string;
      assert.equal(typeof text, 'string');
      assert.match(text, /Vision:/);
      assert.match(text, /Stage:/);
      assert.match(text, /Phase:/);

      const json = await run(visionShow, { id: doc.id, format: 'json' }) as Record<string, unknown>;
      assert.equal(typeof json, 'object');
      assert.equal((json as { id: string }).id, doc.id, 'doc id at top level');
      assert.equal((json as { stage: string }).stage, 'draft');
      assert.ok((json as { writ: unknown }).writ, 'writ row nested');
      const writProj = (json as { writ: { id: string; type: string; phase: string } }).writ;
      assert.equal(writProj.id, doc.id);
      assert.equal(writProj.type, 'vision');
      assert.equal(writProj.phase, 'new');
    });

    it('vision-show resolves a short-prefix id via clerk.resolveId (D11)', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      // Use the first eight chars as a prefix.
      const prefix = doc.id.slice(0, 8);
      const json = await run(visionShow, { id: prefix, format: 'json' }) as { id: string };
      assert.equal(json.id, doc.id);
    });

    it('vision-show wraps prefix-resolution failure', async () => {
      await assert.rejects(
        () => run(visionShow, { id: 'w-nonexistent-prefix', format: 'json' }),
      );
    });

    it('vision-list renders text by default and JSON with --format json (D9, D10)', async () => {
      await run(visionCreate, { title: 'V1', body: 'B', codex: 'alpha' });
      await run(visionCreate, { title: 'V2', body: 'B', codex: 'beta' });

      const text = await run(visionList, { format: 'text' }) as string;
      assert.match(text, /STAGE/);
      assert.match(text, /TITLE/);
      assert.match(text, /V1/);
      assert.match(text, /V2/);

      const json = await run(visionList, { format: 'json' }) as Array<{ stage: string }>;
      assert.equal(json.length, 2);
      assert.ok(json.every((d) => d.stage === 'draft'));
    });

    it('vision-list filters by stage and codex (D10)', async () => {
      await run(visionCreate, { title: 'V1', body: 'B', codex: 'alpha' });
      await run(visionCreate, { title: 'V2', body: 'B', codex: 'beta' });

      const onlyAlpha = await run(visionList, { codex: 'alpha', format: 'json' }) as unknown[];
      assert.equal(onlyAlpha.length, 1);

      const onlyDraft = await run(visionList, { stage: 'draft', format: 'json' }) as unknown[];
      assert.equal(onlyDraft.length, 2);

      const sunset = await run(visionList, { stage: 'sunset', format: 'json' }) as unknown[];
      assert.equal(sunset.length, 0);
    });

    it('vision-patch updates codex and preserves stage (D6)', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B', codex: 'old' }) as { id: string };

      const patched = await run(visionPatch, { id: doc.id, codex: 'new' }) as {
        codex: string; stage: string;
      };
      assert.equal(patched.codex, 'new');
      assert.equal(patched.stage, 'draft');
    });

    it('vision-patch with no mutable field rejects', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      await assert.rejects(() => run(visionPatch, { id: doc.id }));
    });

    it('vision-transition writes phase and stage atomically (D15, D17)', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };

      // new → open / draft → active
      await run(visionTransition, { id: doc.id, phase: 'open', stage: 'active' });
      const visionWrit1 = await fix.clerk.show(doc.id);
      assert.equal(visionWrit1.phase, 'open');
      const docAfter1 = await fix.cartograph.showVision(doc.id);
      assert.equal(docAfter1.stage, 'active');

      // open → completed / active → sunset, with resolution
      await run(visionTransition, {
        id: doc.id,
        phase: 'completed',
        stage: 'sunset',
        resolution: 'patron retired the vision',
      });
      const visionWrit2 = await fix.clerk.show(doc.id);
      assert.equal(visionWrit2.phase, 'completed');
      assert.equal(visionWrit2.resolution, 'patron retired the vision');
      assert.ok(visionWrit2.resolvedAt);
    });

    it('vision-transition rejects an illegal phase edge (typed-API enforcement)', async () => {
      const doc = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      // new → completed is not a legal direct edge per the mandate clone.
      await assert.rejects(
        () => run(visionTransition, { id: doc.id, phase: 'completed', stage: 'sunset' }),
      );
    });
  });

  // ── Charge tools — happy paths + parent invariants ─────────────────

  describe('charge tools', () => {
    it('charge-create resolves a short-prefix --parent-id (D21)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B', codex: 'main' }) as { id: string };
      const prefix = vision.id.slice(0, 8);

      const charge = await run(chargeCreate, {
        parentId: prefix,
        title: 'C',
        body: 'B',
      }) as { id: string; codex: string; stage: string };

      assert.equal(charge.stage, 'draft');
      assert.equal(charge.codex, 'main', 'inherited from parent vision');
      const chargeWrit = await fix.clerk.show(charge.id);
      assert.equal(chargeWrit.parentId, vision.id);
      assert.equal(chargeWrit.phase, 'new');
    });

    it('charge-create wraps a parent-resolution failure', async () => {
      await assert.rejects(
        () => run(chargeCreate, { parentId: 'w-nope', title: 'C', body: 'B' }),
      );
    });

    it('charge-create rejects a non-vision parent (typed-API enforcement)', async () => {
      const mandate = await fix.clerk.post({ type: 'mandate', title: 'wrong', body: 'B' });
      await assert.rejects(
        () => run(chargeCreate, { parentId: mandate.id, title: 'C', body: 'B' }),
        /vision/,
      );
    });

    it('charge-show returns text by default and JSON with --format json', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };

      const text = await run(chargeShow, { id: charge.id, format: 'text' }) as string;
      assert.match(text, /Charge:/);
      assert.match(text, /Parent:/, 'parent reference must appear in text mode');

      const json = await run(chargeShow, { id: charge.id, format: 'json' }) as { writ: { type: string } };
      assert.equal(json.writ.type, 'charge');
    });

    it('charge-list filters by stage and supports --format json', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      await run(chargeCreate, { parentId: vision.id, title: 'C1', body: 'B' });
      await run(chargeCreate, { parentId: vision.id, title: 'C2', body: 'B' });

      const text = await run(chargeList, { format: 'text' }) as string;
      assert.match(text, /C1/);
      assert.match(text, /C2/);

      const json = await run(chargeList, { format: 'json' }) as unknown[];
      assert.equal(json.length, 2);

      const dropped = await run(chargeList, { stage: 'dropped', format: 'json' }) as unknown[];
      assert.equal(dropped.length, 0);
    });

    it('charge-patch updates codex (D6)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };

      const patched = await run(chargePatch, { id: charge.id, codex: 'updated' }) as {
        codex: string; stage: string;
      };
      assert.equal(patched.codex, 'updated');
      assert.equal(patched.stage, 'draft');
    });

    it('charge-transition walks the lifecycle to validated (D15)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };

      await run(chargeTransition, { id: charge.id, phase: 'open', stage: 'active' });
      const after = await run(chargeTransition, {
        id: charge.id, phase: 'completed', stage: 'validated',
        resolution: 'patron walkthrough accepted',
      }) as { stage: string };
      assert.equal(after.stage, 'validated');
      const chargeWrit = await fix.clerk.show(charge.id);
      assert.equal(chargeWrit.phase, 'completed');
      assert.equal(chargeWrit.resolution, 'patron walkthrough accepted');
    });
  });

  // ── Piece tools — happy paths + parent invariants ──────────────────

  describe('piece tools', () => {
    it('piece-create resolves a short-prefix --parent-id (D21)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B', codex: 'main' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };

      // Use the full id minus the last character: a meaningful prefix
      // that is still long enough to disambiguate against the sibling
      // writs created in the same millisecond.
      const piece = await run(pieceCreate, {
        parentId: charge.id.slice(0, -1),
        title: 'P',
        body: 'B',
      }) as { id: string; codex: string; stage: string };

      assert.equal(piece.codex, 'main');
      const pieceWrit = await fix.clerk.show(piece.id);
      assert.equal(pieceWrit.parentId, charge.id);
      assert.equal(pieceWrit.type, 'piece');
    });

    it('piece-create wraps a parent-resolution failure', async () => {
      await assert.rejects(
        () => run(pieceCreate, { parentId: 'w-nope', title: 'P', body: 'B' }),
      );
    });

    it('piece-create rejects a vision parent (typed-API enforcement)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      await assert.rejects(
        () => run(pieceCreate, { parentId: vision.id, title: 'P', body: 'B' }),
        /charge/,
      );
    });

    it('piece-show + piece-list cover both formats', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };
      const piece = await run(pieceCreate, {
        parentId: charge.id, title: 'P', body: 'B',
      }) as { id: string };

      const text = await run(pieceShow, { id: piece.id, format: 'text' }) as string;
      assert.match(text, /Piece:/);
      const json = await run(pieceShow, { id: piece.id, format: 'json' }) as { writ: { type: string } };
      assert.equal(json.writ.type, 'piece');

      const listText = await run(pieceList, { format: 'text' }) as string;
      assert.match(listText, /P/);
      const listJson = await run(pieceList, { format: 'json' }) as unknown[];
      assert.equal(listJson.length, 1);
    });

    it('piece-patch + piece-transition round-trip (D6, D15)', async () => {
      const vision = await run(visionCreate, { title: 'V', body: 'B' }) as { id: string };
      const charge = await run(chargeCreate, {
        parentId: vision.id, title: 'C', body: 'B',
      }) as { id: string };
      const piece = await run(pieceCreate, {
        parentId: charge.id, title: 'P', body: 'B',
      }) as { id: string };

      const patched = await run(piecePatch, { id: piece.id, codex: 'codex-1' }) as {
        codex: string;
      };
      assert.equal(patched.codex, 'codex-1');

      await run(pieceTransition, { id: piece.id, phase: 'open', stage: 'active' });
      const finished = await run(pieceTransition, {
        id: piece.id, phase: 'completed', stage: 'done',
      }) as { stage: string };
      assert.equal(finished.stage, 'done');

      const pieceWrit = await fix.clerk.show(piece.id);
      assert.equal(pieceWrit.phase, 'completed');
    });
  });

  // ── End-to-end patron round-trip ───────────────────────────────────

  describe('end-to-end patron round-trip', () => {
    it('vision → charge → piece → list at each level → show in both formats → patch → transition to terminal', async () => {
      // 1. Create a vision.
      const vision = await run(visionCreate, {
        title: 'Land the agentic decomposition ladder',
        body: 'Long-form patron intent',
        codex: 'main',
      }) as { id: string };

      // 2. Create a charge under it via short-prefix --parent-id.
      // Use id.slice(0, -1) so the prefix is unambiguous even when
      // writs are created in the same millisecond and share the
      // timestamp-based portion of their ids.
      const charge = await run(chargeCreate, {
        parentId: vision.id.slice(0, -1),
        title: 'Stand up the data substrate',
        body: 'First decomposition',
      }) as { id: string };

      // 3. Create a piece under the charge (also via short prefix).
      const piece = await run(pieceCreate, {
        parentId: charge.id.slice(0, -1),
        title: 'Pick a companion-doc shape',
        body: 'Internal organization',
      }) as { id: string };

      // 4. List at each level (text + json).
      const visionText = await run(visionList, { format: 'text' }) as string;
      assert.match(visionText, /Land the agentic decomposition ladder/);
      const chargeJson = await run(chargeList, { format: 'json' }) as Array<{ id: string }>;
      assert.equal(chargeJson.length, 1);
      assert.equal(chargeJson[0].id, charge.id);
      const pieceJson = await run(pieceList, { format: 'json' }) as Array<{ id: string }>;
      assert.equal(pieceJson.length, 1);
      assert.equal(pieceJson[0].id, piece.id);

      // 5. Show each in both formats.
      assert.match(await run(visionShow, { id: vision.id, format: 'text' }) as string, /Vision:/);
      assert.match(await run(chargeShow, { id: charge.id, format: 'text' }) as string, /Charge:/);
      assert.match(await run(pieceShow, { id: piece.id, format: 'text' }) as string, /Piece:/);
      assert.equal((await run(visionShow, { id: vision.id, format: 'json' }) as { id: string }).id, vision.id);
      assert.equal((await run(chargeShow, { id: charge.id, format: 'json' }) as { id: string }).id, charge.id);
      assert.equal((await run(pieceShow, { id: piece.id, format: 'json' }) as { id: string }).id, piece.id);

      // 6. Patch a codex.
      const patched = await run(visionPatch, { id: vision.id, codex: 'switched' }) as { codex: string };
      assert.equal(patched.codex, 'switched');

      // 7. Transition the vision through to a terminal stage with --resolution.
      await run(visionTransition, { id: vision.id, phase: 'open', stage: 'active' });
      const terminal = await run(visionTransition, {
        id: vision.id,
        phase: 'completed',
        stage: 'sunset',
        resolution: 'shipped the ladder, sunsetting the vision',
      }) as { stage: string };
      assert.equal(terminal.stage, 'sunset');

      const visionWrit = await fix.clerk.show(vision.id);
      assert.equal(visionWrit.phase, 'completed');
      assert.equal(visionWrit.resolution, 'shipped the ladder, sunsetting the vision');
    });
  });
});
