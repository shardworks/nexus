/**
 * Spider tools — structure and handler delegation.
 *
 * Validates the public Spider tools (rig-show, rig-list, rig-for-writ,
 * crawl-one, crawl-continual): supportKit registration, tool metadata
 * (name, permission, params schema), and handler-level behaviour for
 * each tool against the in-memory fixture.
 *
 * Verbatim relocation from the legacy monolithic `spider.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild, generateId, shortId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus, StartupContext, KitEntry } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import { createClerk } from '@shardworks/clerk-apparatus';
import type { ClerkApi, WritDoc, WritTypeConfig } from '@shardworks/clerk-apparatus';

import { createFabricator } from '@shardworks/fabricator-apparatus';
import type { FabricatorApi, EngineDesign, EngineRunContext } from '@shardworks/fabricator-apparatus';

import type { AnimatorApi, SummonRequest, AnimateHandle, SessionChunk, SessionResult, SessionDoc } from '@shardworks/animator-apparatus';

import { z } from 'zod';

import { createSpider, countRunningEngines, countRunningEnginesInRig } from './spider.ts';
import type { SpiderApi, RigDoc, RigView, EngineInstance, EngineAttempt, ReviewYields, MechanicalCheck, RigTemplate, BlockType, CheckResult, SpiderEngineRunResult, SpiderCollectResult, InputRequestDoc } from './types.ts';

import animaSessionEngine from './engines/anima-session.ts';

import rigShowTool from './tools/rig-show.ts';
import rigListTool from './tools/rig-list.ts';
import rigForWritTool from './tools/rig-for-writ.ts';
import rigResumeTool from './tools/rig-resume.ts';

import {
  latestAttempt,
  STANDARD_TEMPLATE,
  FRAMEWORK_KIT_FIELDS,
  buildKitEntries,
  buildCtx,
  mergeCustomEnginesIntoSpider,
  buildFixture,
  rigsBook,
  mandateLikeWritType,
  postWrit,
  assertTerminalAt,
} from './spider-test-fixture.ts';

// ── Tool structure tests ───────────────────────────────────────────────────

describe('Spider tools — structure (V6/R8/R9/R10/R12)', () => {
  // ── supportKit.tools registration ─────────────────────────────────

  describe('supportKit.tools registration', () => {
    it('contains rig-show, rig-list, and rig-for-writ in supportKit.tools', () => {
      const spiderPlugin = createSpider();
      const kit = spiderPlugin.apparatus.supportKit as { tools?: Array<{ name: string }> };
      const tools = kit.tools ?? [];
      const toolNames = tools.map((t) => t.name);

      assert.ok(toolNames.includes('rig-show'), 'supportKit.tools must include rig-show');
      assert.ok(toolNames.includes('rig-list'), 'supportKit.tools must include rig-list');
      assert.ok(toolNames.includes('rig-for-writ'), 'supportKit.tools must include rig-for-writ');
    });
  });

  // ── rig-show structure ─────────────────────────────────────────────

  describe('rig-show tool definition', () => {
    it('has name "rig-show"', () => {
      assert.equal(rigShowTool.name, 'rig-show');
    });

    it('has permission "read"', () => {
      assert.equal(rigShowTool.permission, 'read');
    });

    it('accepts a valid id string', () => {
      const result = rigShowTool.params.safeParse({ id: 'rig-abc123' });
      assert.ok(result.success, 'valid id should be accepted');
    });

    it('rejects missing id', () => {
      const result = rigShowTool.params.safeParse({});
      assert.ok(!result.success, 'missing id should be rejected');
    });

    it('rejects non-string id', () => {
      const result = rigShowTool.params.safeParse({ id: 42 });
      assert.ok(!result.success, 'non-string id should be rejected');
    });
  });

  // ── rig-list structure ─────────────────────────────────────────────

  describe('rig-list tool definition', () => {
    it('has name "rig-list"', () => {
      assert.equal(rigListTool.name, 'rig-list');
    });

    it('has permission "read"', () => {
      assert.equal(rigListTool.permission, 'read');
    });

    it('accepts empty params (all optional)', () => {
      const result = rigListTool.params.safeParse({});
      assert.ok(result.success, 'empty params should be accepted');
    });

    it('accepts all valid status values', () => {
      for (const status of ['running', 'completed', 'failed', 'stuck', 'blocked']) {
        const result = rigListTool.params.safeParse({ status });
        assert.ok(result.success, `status "${status}" should be accepted`);
      }
    });

    it('rejects an invalid status value', () => {
      const result = rigListTool.params.safeParse({ status: 'pending' });
      assert.ok(!result.success, '"pending" is not a valid rig status');
    });

    it('rejects another invalid status value', () => {
      const result = rigListTool.params.safeParse({ status: 'unknown' });
      assert.ok(!result.success, '"unknown" is not a valid rig status');
    });

    it('accepts numeric limit and offset', () => {
      const result = rigListTool.params.safeParse({ limit: 10, offset: 5 });
      assert.ok(result.success);
      assert.equal(result.data?.limit, 10);
      assert.equal(result.data?.offset, 5);
    });

    it('rejects non-numeric limit', () => {
      const result = rigListTool.params.safeParse({ limit: 'ten' });
      assert.ok(!result.success, 'non-numeric limit should be rejected');
    });

    it('rejects non-numeric offset', () => {
      const result = rigListTool.params.safeParse({ offset: 'five' });
      assert.ok(!result.success, 'non-numeric offset should be rejected');
    });
  });

  // ── rig-for-writ structure ─────────────────────────────────────────

  describe('rig-for-writ tool definition', () => {
    it('has name "rig-for-writ"', () => {
      assert.equal(rigForWritTool.name, 'rig-for-writ');
    });

    it('has permission "read"', () => {
      assert.equal(rigForWritTool.permission, 'read');
    });

    it('accepts a valid writId string', () => {
      const result = rigForWritTool.params.safeParse({ writId: 'w-abc123' });
      assert.ok(result.success, 'valid writId should be accepted');
    });

    it('rejects missing writId', () => {
      const result = rigForWritTool.params.safeParse({});
      assert.ok(!result.success, 'missing writId should be rejected');
    });

    it('rejects non-string writId', () => {
      const result = rigForWritTool.params.safeParse({ writId: 99 });
      assert.ok(!result.success, 'non-string writId should be rejected');
    });
  });
});

// ── Tool handler delegation tests ─────────────────────────────────────────

describe('Spider tools — handler delegation', () => {
  afterEach(() => {
    clearGuild();
  });

  // ── rig-show handler ───────────────────────────────────────────────

  describe('rig-show handler', () => {
    it('returns the full RigDoc for a valid rig id', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const rigs = await spider.list();
      const rigId = rigs[0].id;

      const result = await rigShowTool.handler({ id: rigId, format: 'json' }) as RigDoc;
      assert.equal(result.id, rigId);
      assert.equal(result.writId, writ.id);
      assert.equal(result.status, 'running');
      assert.equal(result.engines.length, 5);
      assert.equal(typeof result.createdAt, 'string');
    });

    it('populates writTitle from the clerk/writs book', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk, 'A rig title regression guard');
      await spider.crawl(); // spawn

      const rigs = await spider.list();
      const rigId = rigs[0].id;

      // Tool defaults to text format; ask for JSON so the assertions can
      // read structured fields off the response.
      const result = await rigShowTool.handler({ id: rigId, format: 'json' }) as RigView;
      assert.equal(result.writId, writ.id);
      assert.equal(result.writTitle, 'A rig title regression guard');
    });

    it('leaves writTitle unset when the writ cannot be resolved', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      // Seed a rig whose writId does not exist in clerk/writs.
      const book = rigsBook(stacks);
      await book.put({
        id: 'rig-orphan',
        writId: 'w-does-not-exist',
        status: 'running',
        engines: [],
        createdAt: new Date().toISOString(),
      });

      const result = await rigShowTool.handler({ id: 'rig-orphan', format: 'json' }) as RigView;
      assert.equal(result.writId, 'w-does-not-exist');
      assert.equal(result.writTitle, undefined, 'writTitle must be absent when the writ is missing');
    });

    it('throws with "not found" message for an unknown rig id', async () => {
      buildFixture();
      await assert.rejects(
        () => rigShowTool.handler({ id: 'rig-nonexistent' }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, 'Rig "rig-nonexistent" not found.');
          return true;
        },
      );
    });
  });

  // ── rig-list handler ───────────────────────────────────────────────

  describe('rig-list handler', () => {
    it('returns empty array when no rigs exist', async () => {
      buildFixture();
      const result = await rigListTool.handler({}) as RigDoc[];
      assert.deepEqual(result, []);
    });

    it('returns rigs ordered by createdAt descending (newest first)', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      const older = new Date(Date.now() - 100).toISOString();
      const newer = new Date().toISOString();
      await book.put({ id: 'rig-handler-old', writId: 'w-1', status: 'running', engines: [], createdAt: older });
      await book.put({ id: 'rig-handler-new', writId: 'w-2', status: 'running', engines: [], createdAt: newer });

      const rigs = await rigListTool.handler({}) as RigDoc[];
      assert.equal(rigs.length, 2);
      assert.ok(rigs[0].createdAt >= rigs[1].createdAt, 'rigs must be newest first');
    });

    it('filters by status — only running rigs returned', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      await postWrit(clerk);
      await spider.crawl(); // spawn (status: running)

      const running = await rigListTool.handler({ status: 'running' }) as RigDoc[];
      assert.equal(running.length, 1);
      assert.equal(running[0].status, 'running');

      const completed = await rigListTool.handler({ status: 'completed' }) as RigDoc[];
      assert.equal(completed.length, 0);
    });

    it('respects limit', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({
          id: `rig-lim-${i}`, writId: `w-${i}`, status: 'running', engines: [],
          createdAt: new Date().toISOString(),
        });
      }

      const limited = await rigListTool.handler({ limit: 2 }) as RigDoc[];
      assert.equal(limited.length, 2);
    });

    it('respects offset', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      for (let i = 0; i < 3; i++) {
        await book.put({
          id: `rig-off-${i}`, writId: `w-${i}`, status: 'running', engines: [],
          createdAt: new Date().toISOString(),
        });
      }

      const all = await rigListTool.handler({}) as RigDoc[];
      assert.equal(all.length, 3);

      const page = await rigListTool.handler({ limit: 2, offset: 2 }) as RigDoc[];
      assert.equal(page.length, 1);
    });

    it('populates writTitle on every RigView from the clerk/writs book', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      await postWrit(clerk, 'Writ-title join coverage');
      await spider.crawl(); // spawn

      const rigs = await rigListTool.handler({}) as RigView[];
      assert.equal(rigs.length, 1);
      assert.equal(rigs[0].writTitle, 'Writ-title join coverage');
    });

    it('leaves writTitle unset for rigs whose writs are missing from the book', async () => {
      const fix = buildFixture();
      const { stacks } = fix;
      const book = rigsBook(stacks);
      await book.put({
        id: 'rig-missing-a',
        writId: 'w-absent-a',
        status: 'running',
        engines: [],
        createdAt: new Date().toISOString(),
      });
      await book.put({
        id: 'rig-missing-b',
        writId: 'w-absent-b',
        status: 'running',
        engines: [],
        createdAt: new Date().toISOString(),
      });

      const rigs = await rigListTool.handler({}) as RigView[];
      assert.equal(rigs.length, 2);
      for (const rig of rigs) {
        assert.equal(rig.writTitle, undefined, `writTitle must be undefined for rig ${rig.id}`);
      }
    });
  });

  // ── rig-for-writ handler ───────────────────────────────────────────

  describe('rig-for-writ handler', () => {
    it('returns the rig for a writ that has been spawned', async () => {
      const fix = buildFixture();
      const { clerk, spider } = fix;
      const writ = await postWrit(clerk);
      await spider.crawl(); // spawn

      const result = await rigForWritTool.handler({ writId: writ.id }) as RigDoc | null;
      assert.ok(result !== null, 'expected a rig doc');
      assert.equal(result.writId, writ.id);
    });

    it('returns null when no rig has been spawned for a writ', async () => {
      const fix = buildFixture();
      const { clerk } = fix;
      const writ = await postWrit(clerk);
      // Do not crawl — no rig spawned yet

      const result = await rigForWritTool.handler({ writId: writ.id });
      assert.equal(result, null);
    });

    it('returns null for a non-existent writ id (does not throw)', async () => {
      buildFixture();
      const result = await rigForWritTool.handler({ writId: 'w-nonexistent' });
      assert.equal(result, null);
    });
  });
});
