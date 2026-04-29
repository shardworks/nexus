/**
 * vision-apply — integration tests with real filesystem round-trips.
 *
 * Uses a `mkdtemp`-backed fakeGuild `home` so vision.md and the sidecar
 * round-trip on disk (D17). Wires real stacks + clerk + cartograph
 * exactly like cartograph.test.ts so the apply tool exercises the
 * production code paths through `tool.handler({...})` directly.
 *
 * Coverage:
 *   - First-apply happy path (writ + doc created, sidecar gains
 *     visionId, exactly one CDC event on the cartograph visions book).
 *   - Nth-apply happy path (writ resolved via visionId, body and
 *     stage/codex synced, single CDC event).
 *   - CLI flag overrides sidecar for severity/deadline/decay.
 *   - Stale-binding errors: missing, cancelled, completed, failed.
 *   - Missing vision.md or sidecar errors.
 *   - Malformed sidecar errors.
 *   - sunset / cancelled initial stage rejection.
 *   - Bad-slug rejection (path separators, leading dots, "..").
 *   - ext['surveyor'] payload shape per merge rule.
 *   - Comments and key order in the sidecar survive the visionId
 *     round-trip write-back.
 *   - Resolution flows through on terminal Nth-apply transitions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

import { createCartograph } from '../cartograph.ts';
import type { CartographApi, VisionDoc } from '../types.ts';

import visionApply, { SURVEYOR_PLUGIN_ID } from './vision-apply.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clerk: ClerkApi;
  cartograph: CartographApi;
  memBackend: MemoryBackend;
  home: string;
  // Live counter of CDC events on the cartograph visions book.
  cdc: { create: number; update: number; delete: number };
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
  const home = await mkdtemp(path.join(tmpdir(), 'cartograph-vision-apply-'));

  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  const clerkPlugin = createClerk();
  const cartographPlugin = createCartograph();

  const apparatusMap = new Map<string, unknown>();

  const fakeGuildConfig: GuildConfig = {
    name: 'cartograph-vision-apply-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home,
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

  // Stacks
  stacksPlugin.apparatus.start!(buildCtx());
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

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

  // CDC counter — register before any writes so we observe the very
  // first create event from the first apply.
  const cdc = { create: 0, update: 0, delete: 0 };
  stacks.watch<VisionDoc>('cartograph', 'visions', (event) => {
    if (event.type === 'create') cdc.create += 1;
    if (event.type === 'update') cdc.update += 1;
    if (event.type === 'delete') cdc.delete += 1;
  });

  return { stacks, clerk, cartograph, memBackend, home, cdc };
}

async function teardown(fix: Fixture): Promise<void> {
  clearGuild();
  await rm(fix.home, { recursive: true, force: true });
}

/** Materialize a vision dir at `<home>/vision/<slug>/` with the given files. */
async function writeVisionDir(
  home: string,
  slug: string,
  contents: { visionMd?: string | null; sidecar?: string | null },
): Promise<{ visionDir: string; visionMdPath: string; sidecarPath: string }> {
  const visionDir = path.join(home, 'vision', slug);
  await mkdir(visionDir, { recursive: true });
  const visionMdPath = path.join(visionDir, 'vision.md');
  const sidecarPath = path.join(visionDir, 'vision-metadata.yml');
  if (contents.visionMd !== null && contents.visionMd !== undefined) {
    await writeFile(visionMdPath, contents.visionMd, 'utf8');
  }
  if (contents.sidecar !== null && contents.sidecar !== undefined) {
    await writeFile(sidecarPath, contents.sidecar, 'utf8');
  }
  return { visionDir, visionMdPath, sidecarPath };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('vision-apply tool', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(async () => {
    await teardown(fix);
  });

  // ── First apply happy path ───────────────────────────────────────

  describe('first apply — bootstrap', () => {
    it('creates a vision writ + VisionDoc, writes ext[surveyor], writes visionId back to sidecar', async () => {
      await writeVisionDir(fix.home, 'my-vision', {
        visionMd: '# Land the ladder\n\nLong-form vision text here.',
        sidecar:
          'title: Land the ladder\n' +
          'stage: draft\n' +
          'codex: main\n' +
          'severity: high\n',
      });

      const result = await visionApply.handler({ slug: 'my-vision' }) as VisionDoc;

      // Companion doc was created.
      assert.ok(result.id.startsWith('w-'));
      assert.equal(result.stage, 'draft');
      assert.equal(result.codex, 'main');

      // Underlying writ has the right type/phase/title/body/codex.
      const writ = await fix.clerk.show(result.id);
      assert.equal(writ.type, 'vision');
      assert.equal(writ.phase, 'new');
      assert.equal(writ.title, 'Land the ladder');
      assert.equal(writ.body, '# Land the ladder\n\nLong-form vision text here.');
      assert.equal(writ.codex, 'main');

      // Surveyor ext slot was written with severity from sidecar.
      assert.deepEqual(writ.ext?.[SURVEYOR_PLUGIN_ID], { severity: 'high' });

      // Exactly one CDC event on the cartograph visions book — the
      // single-event-per-apply contract.
      assert.equal(fix.cdc.create, 1);
      assert.equal(fix.cdc.update, 0);

      // Sidecar gained the visionId binding.
      const sidecarPath = path.join(fix.home, 'vision', 'my-vision', 'vision-metadata.yml');
      const updatedSidecar = await readFile(sidecarPath, 'utf8');
      assert.match(updatedSidecar, /visionId:/);
      assert.ok(
        updatedSidecar.includes(result.id),
        `sidecar should embed the new visionId "${result.id}", got:\n${updatedSidecar}`,
      );
    });

    it('respects sidecar stage=active and bootstraps directly into the active state', async () => {
      await writeVisionDir(fix.home, 'active-from-birth', {
        visionMd: 'body',
        sidecar: 'title: Active\nstage: active\n',
      });

      const result = await visionApply.handler({ slug: 'active-from-birth' }) as VisionDoc;
      assert.equal(result.stage, 'active');

      const writ = await fix.clerk.show(result.id);
      assert.equal(writ.phase, 'open');

      // Still exactly one CDC event despite landing in `active`.
      assert.equal(fix.cdc.create, 1);
      assert.equal(fix.cdc.update, 0);
    });

    it('writes ext[surveyor] = {} when neither flags nor sidecar provide priority fields', async () => {
      await writeVisionDir(fix.home, 'empty-payload', {
        visionMd: 'body',
        sidecar: 'title: Empty payload\nstage: draft\n',
      });

      const result = await visionApply.handler({ slug: 'empty-payload' }) as VisionDoc;
      const writ = await fix.clerk.show(result.id);
      // Slot is always written, even when payload is empty (D11).
      assert.deepEqual(writ.ext?.[SURVEYOR_PLUGIN_ID], {});
    });

    it('CLI flags override sidecar values for severity/deadline/decay', async () => {
      await writeVisionDir(fix.home, 'cli-overrides', {
        visionMd: 'body',
        sidecar:
          'title: Overrides\n' +
          'stage: draft\n' +
          'severity: low\n' +
          'deadline: 2026-01-01\n' +
          'decay: slow\n',
      });

      const result = await visionApply.handler({
        slug: 'cli-overrides',
        severity: 'high',
        deadline: '2026-12-31',
        decay: 'fast',
      }) as VisionDoc;

      const writ = await fix.clerk.show(result.id);
      assert.deepEqual(writ.ext?.[SURVEYOR_PLUGIN_ID], {
        severity: 'high',
        deadline: '2026-12-31',
        decay: 'fast',
      });
    });

    it('preserves comments and key order in the sidecar across visionId write-back', async () => {
      const original =
        '# This vision is important\n' +
        'title: Land the ladder\n' +
        '# stage describes the lifecycle\n' +
        'stage: draft\n' +
        'codex: main\n' +
        '# severity is a priority hint\n' +
        'severity: high\n';
      await writeVisionDir(fix.home, 'comment-survival', {
        visionMd: 'body',
        sidecar: original,
      });

      await visionApply.handler({ slug: 'comment-survival' });

      const sidecarPath = path.join(fix.home, 'vision', 'comment-survival', 'vision-metadata.yml');
      const updated = await readFile(sidecarPath, 'utf8');

      // Comments survive.
      assert.ok(updated.includes('# This vision is important'));
      assert.ok(updated.includes('# stage describes the lifecycle'));
      assert.ok(updated.includes('# severity is a priority hint'));

      // Key order — title, stage, codex, severity all appear in their
      // original relative order, and visionId is appended at the end.
      const titleIdx = updated.indexOf('title:');
      const stageIdx = updated.indexOf('stage:');
      const codexIdx = updated.indexOf('codex:');
      const severityIdx = updated.indexOf('severity:');
      const visionIdIdx = updated.indexOf('visionId:');
      assert.ok(titleIdx >= 0 && stageIdx > titleIdx, 'title before stage');
      assert.ok(stageIdx < codexIdx && codexIdx < severityIdx, 'stage before codex before severity');
      assert.ok(visionIdIdx > severityIdx, 'visionId appended after existing keys');
    });
  });

  // ── First-apply error paths ──────────────────────────────────────

  describe('first apply — error paths', () => {
    it('errors cleanly when vision.md is missing', async () => {
      await writeVisionDir(fix.home, 'no-md', {
        sidecar: 'title: t\nstage: draft\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'no-md' }),
        /vision\.md not found/,
      );
      assert.equal(fix.cdc.create, 0, 'no writes happen on missing vision.md');
    });

    it('errors cleanly when the sidecar is missing', async () => {
      await writeVisionDir(fix.home, 'no-sidecar', {
        visionMd: 'body',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'no-sidecar' }),
        /vision-metadata\.yml not found/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('errors on a malformed sidecar (top-level not a YAML map)', async () => {
      await writeVisionDir(fix.home, 'not-a-map', {
        visionMd: 'body',
        // A top-level YAML list — not a map — so parseSidecar rejects.
        sidecar: '- title: t\n- stage: draft\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'not-a-map' }),
        /must be a YAML map at the top level/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('errors when a sidecar field has the wrong shape', async () => {
      await writeVisionDir(fix.home, 'wrong-shape', {
        visionMd: 'body',
        // `stage:` followed by a nested map makes the field a non-string;
        // the parser surfaces a clear typed error rather than silently
        // coercing.
        sidecar: 'title: t\nstage:\n  nested: oops\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'wrong-shape' }),
        /must be a string \(got object\)/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('errors when the sidecar is missing the title field', async () => {
      await writeVisionDir(fix.home, 'no-title', {
        visionMd: 'body',
        sidecar: 'stage: draft\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'no-title' }),
        /missing the required field "title"/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('errors when the sidecar is missing the stage field', async () => {
      await writeVisionDir(fix.home, 'no-stage', {
        visionMd: 'body',
        sidecar: 'title: t\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'no-stage' }),
        /missing the required field "stage"/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('rejects sunset as an initial sidecar stage', async () => {
      await writeVisionDir(fix.home, 'born-retired', {
        visionMd: 'body',
        sidecar: 'title: t\nstage: sunset\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'born-retired' }),
        /cannot create a vision with initial stage "sunset"|cannot be born retired/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('rejects cancelled as an initial sidecar stage', async () => {
      await writeVisionDir(fix.home, 'born-cancelled', {
        visionMd: 'body',
        sidecar: 'title: t\nstage: cancelled\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'born-cancelled' }),
        /cannot create a vision with initial stage "cancelled"|cannot be born retired/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('rejects an unknown stage value at the sidecar boundary', async () => {
      await writeVisionDir(fix.home, 'bad-stage', {
        visionMd: 'body',
        sidecar: 'title: t\nstage: nonsense\n',
      });
      await assert.rejects(
        () => visionApply.handler({ slug: 'bad-stage' }),
        /not a valid VisionStage/,
      );
      assert.equal(fix.cdc.create, 0);
    });

    it('rejects bad slugs at the CLI boundary', async () => {
      // Each of these should fail Zod validation before any IO happens.
      const badSlugs = [
        'has/slash',
        '..',
        '.hidden',
        'has\\backslash',
        'has spaces',
      ];
      for (const slug of badSlugs) {
        await assert.rejects(
          () => visionApply.params.parseAsync({ slug }),
          (err: Error) => {
            // Zod's regex error message includes the param description.
            assert.match(err.message, /slug/);
            return true;
          },
          `bad slug "${slug}" should be rejected at the CLI boundary`,
        );
      }
    });
  });

  // ── Nth apply happy path ──────────────────────────────────────────

  describe('Nth apply — sync', () => {
    it('updates body and stage on a bound writ; emits one CDC event for the change', async () => {
      // First apply lands draft.
      await writeVisionDir(fix.home, 'sync-body', {
        visionMd: 'original body',
        sidecar: 'title: Sync me\nstage: draft\n',
      });
      const created = await visionApply.handler({ slug: 'sync-body' }) as VisionDoc;
      assert.equal(fix.cdc.create, 1);
      assert.equal(fix.cdc.update, 0);

      // Edit vision.md and bump stage to active.
      const sidecarPath = path.join(fix.home, 'vision', 'sync-body', 'vision-metadata.yml');
      const visionMdPath = path.join(fix.home, 'vision', 'sync-body', 'vision.md');
      // Read back the now-bound sidecar (it has visionId baked in).
      const boundSidecar = await readFile(sidecarPath, 'utf8');
      // Swap stage draft → active.
      const activated = boundSidecar.replace(/stage: draft/, 'stage: active');
      await writeFile(sidecarPath, activated, 'utf8');
      await writeFile(visionMdPath, 'updated body', 'utf8');

      const updated = await visionApply.handler({ slug: 'sync-body' }) as VisionDoc;
      assert.equal(updated.id, created.id);
      assert.equal(updated.stage, 'active');

      const writ = await fix.clerk.show(created.id);
      assert.equal(writ.phase, 'open');
      assert.equal(writ.body, 'updated body');

      // Expect at least one update event from the transition. The
      // brief's "at most one CDC event per logical change" is the
      // upper bound; cartograph's transitionVision currently emits
      // exactly one, mirroring the createVision coalescing path.
      assert.equal(fix.cdc.create, 1, 'no second create event');
      assert.equal(fix.cdc.update, 1, 'exactly one update event from the transition');
    });

    it('produces no update event on the visions book when only the body changed', async () => {
      await writeVisionDir(fix.home, 'body-only', {
        visionMd: 'original body',
        sidecar: 'title: Body-only\nstage: draft\n',
      });
      await visionApply.handler({ slug: 'body-only' });
      assert.equal(fix.cdc.create, 1);
      assert.equal(fix.cdc.update, 0);

      // Edit only vision.md.
      const visionMdPath = path.join(fix.home, 'vision', 'body-only', 'vision.md');
      await writeFile(visionMdPath, 'rewritten body', 'utf8');

      await visionApply.handler({ slug: 'body-only' });
      // No transition + no codex change + no stage change → no
      // visions-book mutation. The body lives on writs, not visions.
      assert.equal(fix.cdc.update, 0, 'body-only edit does not mutate the cartograph visions book');
      assert.equal(fix.cdc.create, 1);
    });

    it('syncs codex changes through patchVision', async () => {
      await writeVisionDir(fix.home, 'codex-sync', {
        visionMd: 'body',
        sidecar: 'title: Codex sync\nstage: draft\ncodex: original\n',
      });
      const created = await visionApply.handler({ slug: 'codex-sync' }) as VisionDoc;
      assert.equal(created.codex, 'original');

      const sidecarPath = path.join(fix.home, 'vision', 'codex-sync', 'vision-metadata.yml');
      const boundSidecar = await readFile(sidecarPath, 'utf8');
      await writeFile(sidecarPath, boundSidecar.replace('codex: original', 'codex: updated'), 'utf8');

      const updated = await visionApply.handler({ slug: 'codex-sync' }) as VisionDoc;
      assert.equal(updated.codex, 'updated');
    });

    it('refreshes ext[surveyor] on every apply', async () => {
      await writeVisionDir(fix.home, 'surveyor-refresh', {
        visionMd: 'body',
        sidecar: 'title: t\nstage: draft\nseverity: low\n',
      });
      const created = await visionApply.handler({ slug: 'surveyor-refresh' }) as VisionDoc;
      const writ1 = await fix.clerk.show(created.id);
      assert.deepEqual(writ1.ext?.[SURVEYOR_PLUGIN_ID], { severity: 'low' });

      // Sidecar update — bump severity to high.
      const sidecarPath = path.join(fix.home, 'vision', 'surveyor-refresh', 'vision-metadata.yml');
      const boundSidecar = await readFile(sidecarPath, 'utf8');
      await writeFile(sidecarPath, boundSidecar.replace('severity: low', 'severity: high'), 'utf8');

      await visionApply.handler({ slug: 'surveyor-refresh' });
      const writ2 = await fix.clerk.show(created.id);
      assert.deepEqual(writ2.ext?.[SURVEYOR_PLUGIN_ID], { severity: 'high' });
    });

    it('passes resolution through transitionVision on terminal moves', async () => {
      await writeVisionDir(fix.home, 'sunset-vision', {
        visionMd: 'body',
        sidecar: 'title: Will retire\nstage: active\n',
      });
      const created = await visionApply.handler({ slug: 'sunset-vision' }) as VisionDoc;

      const sidecarPath = path.join(fix.home, 'vision', 'sunset-vision', 'vision-metadata.yml');
      const bound = await readFile(sidecarPath, 'utf8');
      // Switch to sunset (terminal) with a resolution.
      const updated =
        bound.replace('stage: active', 'stage: sunset') +
        'resolution: patron retired the vision\n';
      await writeFile(sidecarPath, updated, 'utf8');

      await visionApply.handler({ slug: 'sunset-vision' });
      const writ = await fix.clerk.show(created.id);
      assert.equal(writ.phase, 'completed');
      assert.equal(writ.resolution, 'patron retired the vision');
      assert.ok(writ.resolvedAt, 'terminal transition stamps resolvedAt');
    });
  });

  // ── Stale-binding errors ─────────────────────────────────────────

  describe('Nth apply — stale bindings', () => {
    async function bootstrapAndCorrupt(
      slug: string,
      driveTo?: 'cancelled' | 'completed' | 'failed' | 'delete',
    ): Promise<{ id: string; sidecarPath: string }> {
      await writeVisionDir(fix.home, slug, {
        visionMd: 'body',
        sidecar: 'title: t\nstage: draft\n',
      });
      const created = await visionApply.handler({ slug }) as VisionDoc;

      // Move to open first so terminal transitions are legal from the
      // mandate-clone state machine.
      if (driveTo === 'cancelled') {
        await fix.cartograph.transitionVision(created.id, { phase: 'cancelled', stage: 'cancelled' });
      } else if (driveTo === 'completed') {
        await fix.cartograph.transitionVision(created.id, { phase: 'open', stage: 'active' });
        await fix.cartograph.transitionVision(created.id, { phase: 'completed', stage: 'sunset' });
      } else if (driveTo === 'failed') {
        await fix.cartograph.transitionVision(created.id, { phase: 'open', stage: 'active' });
        await fix.cartograph.transitionVision(created.id, { phase: 'failed', stage: 'cancelled' });
      } else if (driveTo === 'delete') {
        await fix.stacks.book<WritDoc>('clerk', 'writs').delete(created.id);
      }

      const sidecarPath = path.join(fix.home, 'vision', slug, 'vision-metadata.yml');
      return { id: created.id, sidecarPath };
    }

    it('errors on a missing bound writ', async () => {
      await bootstrapAndCorrupt('missing-binding', 'delete');
      await assert.rejects(
        () => visionApply.handler({ slug: 'missing-binding' }),
        /no such writ exists|stale/,
      );
    });

    it('errors on a cancelled bound writ', async () => {
      await bootstrapAndCorrupt('cancelled-binding', 'cancelled');
      await assert.rejects(
        () => visionApply.handler({ slug: 'cancelled-binding' }),
        /terminal phase "cancelled"/,
      );
    });

    it('errors on a completed bound writ', async () => {
      await bootstrapAndCorrupt('completed-binding', 'completed');
      await assert.rejects(
        () => visionApply.handler({ slug: 'completed-binding' }),
        /terminal phase "completed"/,
      );
    });

    it('errors on a failed bound writ', async () => {
      await bootstrapAndCorrupt('failed-binding', 'failed');
      await assert.rejects(
        () => visionApply.handler({ slug: 'failed-binding' }),
        /terminal phase "failed"/,
      );
    });

    it('does not partially write when the binding is stale', async () => {
      await bootstrapAndCorrupt('cancelled-no-partial', 'cancelled');
      const ridBefore = fix.cdc.create + fix.cdc.update;
      await assert.rejects(
        () => visionApply.handler({ slug: 'cancelled-no-partial' }),
      );
      const ridAfter = fix.cdc.create + fix.cdc.update;
      assert.equal(
        ridAfter,
        ridBefore,
        'no new CDC events on the visions book during a stale-binding apply attempt',
      );
    });
  });
});
