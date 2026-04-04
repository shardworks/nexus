/**
 * The Loom — unit tests.
 *
 * Tests weave() with role → permissions → tool resolution via a mock
 * Instrumentarium, and the basic structural contract.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import { tool, type InstrumentariumApi, type ResolvedTool, type ResolveOptions } from '@shardworks/tools-apparatus';

import { createLoom, type LoomApi, type LoomConfig } from './loom.ts';
import loomDefault from './index.ts';

// ── Test fixtures ───────────────────────────────────────────────────

/** A minimal tool for testing. */
function testTool(name: string, permission?: string) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(permission !== undefined ? { permission } : {}),
  });
}

/** A mock Instrumentarium that records calls and returns configured tools. */
function mockInstrumentarium(resolvedTools: ResolvedTool[] = []) {
  const calls: ResolveOptions[] = [];
  const api: InstrumentariumApi = {
    resolve(options: ResolveOptions): ResolvedTool[] {
      calls.push(options);
      return resolvedTools;
    },
    find: () => null,
    list: () => resolvedTools,
  };
  return { api, calls };
}

/** Set up a fake guild with the given loom config and apparatus map. */
function setupGuild(opts: {
  loomConfig?: LoomConfig;
  apparatuses?: Record<string, unknown>;
  home?: string;
}) {
  const apparatuses = opts.apparatuses ?? {};
  setGuild({
    home: opts.home ?? '/tmp/test-guild',
    apparatus: <T>(id: string): T => {
      const a = apparatuses[id];
      if (!a) throw new Error(`Apparatus '${id}' not installed`);
      return a as T;
    },
    guildConfig: () => ({
      name: 'test-guild',
      nexus: '0.0.0',
      workshops: {},
      plugins: [],
      loom: opts.loomConfig,
    }),
    kits: () => [],
    apparatuses: () => [],
  } as never);
}

/** Create a started Loom and return its API. */
function startLoom(): LoomApi {
  const plugin = createLoom();
  const apparatus = (plugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  apparatus.start({ on: () => {} });
  return apparatus.provides as LoomApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('The Loom', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('createLoom()', () => {
    it('returns a plugin with apparatus shape', () => {
      const plugin = createLoom();
      assert.ok('apparatus' in plugin, 'should have apparatus key');

      const { apparatus } = plugin as { apparatus: Record<string, unknown> };
      assert.deepStrictEqual(apparatus.requires, ['tools']);
      assert.ok(apparatus.provides, 'should have provides');
      assert.ok(typeof apparatus.start === 'function', 'should have start()');
    });

    it('provides a LoomApi with weave()', () => {
      const plugin = createLoom();
      const api = (plugin as { apparatus: { provides: LoomApi } }).apparatus.provides;
      assert.ok(typeof api.weave === 'function');
    });
  });

  describe('default export', () => {
    it('is a plugin with apparatus shape', () => {
      assert.ok('apparatus' in loomDefault, 'default export should have apparatus key');
      const { apparatus } = loomDefault as { apparatus: Record<string, unknown> };
      assert.ok(apparatus.provides, 'should have provides');
      assert.ok(typeof (apparatus.provides as LoomApi).weave === 'function', 'provides should have weave()');
    });
  });

  describe('weave() — no role', () => {
    it('returns undefined systemPrompt', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('returns undefined tools when no role is provided', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.tools, undefined);
    });

    it('returns a promise', () => {
      setupGuild({});
      const api = startLoom();
      const result = api.weave({});
      assert.ok(result instanceof Promise, 'weave() should return a Promise');
    });

    it('returns an object without initialPrompt', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.ok(!('initialPrompt' in weave), 'AnimaWeave should not have initialPrompt');
    });

    it('returns undefined environment when no role is provided', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.environment, undefined);
    });
  });

  describe('weave() — role with tool resolution', () => {
    it('resolves tools for a configured role', async () => {
      const readTool = testTool('stack-query', 'read');
      const resolved: ResolvedTool[] = [
        { definition: readTool, pluginId: 'stacks' },
      ];
      const { api: instrumentarium, calls } = mockInstrumentarium(resolved);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: {
              permissions: ['stacks:read'],
            },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'scribe' });

      assert.equal(weave.tools?.length, 1);
      assert.equal(weave.tools![0]!.definition.name, 'stack-query');

      // Verify the Instrumentarium was called with correct args
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['stacks:read']);
      assert.equal(calls[0]!.caller, 'anima');
    });

    it('passes strict flag from role definition', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: {
              permissions: ['stacks:read'],
              strict: true,
            },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      await api.weave({ role: 'scribe' });

      assert.equal(calls[0]!.strict, true);
    });

    it('returns undefined tools for an unknown role', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'unknown-role' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0, 'should not call instrumentarium for unknown role');
    });

    it('returns undefined tools when no roles configured', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {},
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0);
    });

    it('returns undefined tools when loom config is absent', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0);
    });

    it('always passes caller: anima to the Instrumentarium', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            admin: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      await api.weave({ role: 'admin' });

      assert.equal(calls[0]!.caller, 'anima');
    });

    it('derives git identity environment from role name', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.deepStrictEqual(weave.environment, {
        GIT_AUTHOR_NAME: 'Artificer',
        GIT_AUTHOR_EMAIL: 'artificer@nexus.local',
      });
    });

    it('capitalizes first letter of role name for display name', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: { permissions: ['stacks:read'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'scribe' });

      assert.equal(weave.environment?.GIT_AUTHOR_NAME, 'Scribe');
    });

    it('derives environment even for unknown roles', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'unknown-role' });

      assert.ok(weave.environment, 'environment should be defined for any role string');
      assert.equal(weave.environment?.GIT_AUTHOR_NAME, 'Unknown-role');
      assert.equal(weave.environment?.GIT_AUTHOR_EMAIL, 'unknown-role@nexus.local');
    });
  });

  // ── System prompt composition ──────────────────────────────────────

  describe('weave() — charter composition', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes charter.md content in systemPrompt', async () => {
      fs.writeFileSync(path.join(tmpDir, 'charter.md'), 'Guild policy: be excellent.');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.equal(weave.systemPrompt, 'Guild policy: be excellent.');
    });

    it('composes charter from directory files in alphabetical order', async () => {
      const charterDir = path.join(tmpDir, 'charter');
      fs.mkdirSync(charterDir);
      fs.writeFileSync(path.join(charterDir, '02-rules.md'), 'Rule 1');
      fs.writeFileSync(path.join(charterDir, '01-values.md'), 'Value 1');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.equal(weave.systemPrompt, 'Value 1\n\nRule 1');
    });

    it('charter.md takes priority over charter/ directory', async () => {
      fs.writeFileSync(path.join(tmpDir, 'charter.md'), 'Single file');
      const charterDir = path.join(tmpDir, 'charter');
      fs.mkdirSync(charterDir);
      fs.writeFileSync(path.join(charterDir, '01.md'), 'Dir file');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.equal(weave.systemPrompt, 'Single file');
    });

    it('returns undefined systemPrompt when no charter exists', async () => {
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('returns undefined systemPrompt when charter/ directory has no .md files', async () => {
      const charterDir = path.join(tmpDir, 'charter');
      fs.mkdirSync(charterDir);
      fs.writeFileSync(path.join(charterDir, '.gitkeep'), '');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('charter directory with mixed file types only reads .md files', async () => {
      const charterDir = path.join(tmpDir, 'charter');
      fs.mkdirSync(charterDir);
      fs.writeFileSync(path.join(charterDir, 'a.md'), 'A content');
      fs.writeFileSync(path.join(charterDir, 'b.txt'), 'B content');
      fs.writeFileSync(path.join(charterDir, 'c.md'), 'C content');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.equal(weave.systemPrompt, 'A content\n\nC content');
    });

    it('includes charter when weave() is called without a role', async () => {
      fs.writeFileSync(path.join(tmpDir, 'charter.md'), 'Charter text');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave1 = await api.weave({});
      const weave2 = await api.weave({ role: undefined });
      assert.equal(weave1.systemPrompt, 'Charter text');
      assert.equal(weave2.systemPrompt, 'Charter text');
    });
  });

  describe('weave() — role instructions composition', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes role instructions when roles/{role}.md exists', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'You are the artificer.');
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.ok(weave.systemPrompt?.includes('You are the artificer.'));
    });

    it('omits role instructions silently when roles/{role}.md is missing', async () => {
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { scribe: { permissions: ['stacks:read'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'scribe' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('omits role instructions for roles not in config even if file exists on disk', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'ghost.md'), 'Ghost instructions');
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'ghost' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('omits role instructions layer when no role is provided', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'Role text');
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('omits role instructions layer when role instruction file is empty', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), '');
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });
  });

  describe('weave() — tool instructions composition', () => {
    afterEach(() => {
      clearGuild();
    });

    it('includes tool instructions formatted with ## Tool: header', async () => {
      const toolA = tool({
        name: 'tool-a',
        description: 'Tool A',
        instructions: 'Guide A',
        params: {},
        handler: async () => ({}),
      });
      const toolB = tool({
        name: 'tool-b',
        description: 'Tool B',
        instructions: 'Guide B',
        params: {},
        handler: async () => ({}),
      });
      const resolved: ResolvedTool[] = [
        { definition: toolA, pluginId: 'test' },
        { definition: toolB, pluginId: 'test' },
      ];
      const { api: instrumentarium } = mockInstrumentarium(resolved);
      setupGuild({
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.ok(weave.systemPrompt?.includes('## Tool: tool-a\n\nGuide A'));
      assert.ok(weave.systemPrompt?.includes('## Tool: tool-b\n\nGuide B'));
    });

    it('omits tool instructions layer when tools have no instructions', async () => {
      const resolved: ResolvedTool[] = [
        { definition: testTool('plain-tool'), pluginId: 'test' },
      ];
      const { api: instrumentarium } = mockInstrumentarium(resolved);
      setupGuild({
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('only includes tool instructions for tools that have them', async () => {
      const toolWithInstructions = tool({
        name: 'tool-a',
        description: 'Tool A',
        instructions: 'Use this carefully.',
        params: {},
        handler: async () => ({}),
      });
      const toolWithout = testTool('tool-b');
      const resolved: ResolvedTool[] = [
        { definition: toolWithInstructions, pluginId: 'test' },
        { definition: toolWithout, pluginId: 'test' },
      ];
      const { api: instrumentarium } = mockInstrumentarium(resolved);
      setupGuild({
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.ok(weave.systemPrompt?.includes('## Tool: tool-a'));
      assert.ok(!weave.systemPrompt?.includes('## Tool: tool-b'));
    });
  });

  describe('weave() — composition order and assembly', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('assembles full composition in order: charter → tool instructions → role instructions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'charter.md'), 'Charter text');
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'Role text');

      const signalTool = tool({
        name: 'signal',
        description: 'Signal tool',
        instructions: 'Signal guide',
        params: {},
        handler: async () => ({}),
      });
      const resolved: ResolvedTool[] = [{ definition: signalTool, pluginId: 'test' }];
      const { api: instrumentarium } = mockInstrumentarium(resolved);

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.equal(
        weave.systemPrompt,
        'Charter text\n\n## Tool: signal\n\nSignal guide\n\nRole text',
      );
    });

    it('charter only (no role) — systemPrompt equals charter content', async () => {
      fs.writeFileSync(path.join(tmpDir, 'charter.md'), 'Charter text');
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.equal(weave.systemPrompt, 'Charter text');
    });

    it('role instructions only (no charter, no tool instructions)', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'Role text');

      const resolved: ResolvedTool[] = [{ definition: testTool('plain'), pluginId: 'test' }];
      const { api: instrumentarium } = mockInstrumentarium(resolved);

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.equal(weave.systemPrompt, 'Role text');
    });

    it('tool instructions only (no charter, no role.md)', async () => {
      const toolA = tool({
        name: 'my-tool',
        description: 'My tool',
        instructions: 'Tool guide',
        params: {},
        handler: async () => ({}),
      });
      const resolved: ResolvedTool[] = [{ definition: toolA, pluginId: 'test' }];
      const { api: instrumentarium } = mockInstrumentarium(resolved);

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.equal(weave.systemPrompt, '## Tool: my-tool\n\nTool guide');
    });

    it('systemPrompt is undefined when all layers are empty', async () => {
      const resolved: ResolvedTool[] = [{ definition: testTool('plain'), pluginId: 'test' }];
      const { api: instrumentarium } = mockInstrumentarium(resolved);
      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });
  });

  describe('weave() — startup caching', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('content is cached at startup — deleting files after start does not affect weave()', async () => {
      const charterPath = path.join(tmpDir, 'charter.md');
      const rolesDir = path.join(tmpDir, 'roles');
      fs.writeFileSync(charterPath, 'Cached charter');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'Cached role');

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();

      // Delete the files after startup
      fs.unlinkSync(charterPath);
      fs.unlinkSync(path.join(rolesDir, 'artificer.md'));

      const weave = await api.weave({ role: 'artificer' });
      assert.ok(weave.systemPrompt?.includes('Cached charter'));
      assert.ok(weave.systemPrompt?.includes('Cached role'));
    });

    it('roles not in config are not pre-read even if file exists on disk', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'phantom.md'), 'Phantom instructions');

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'phantom' });
      assert.strictEqual(weave.systemPrompt, undefined);
    });
  });

  describe('weave() — backward compatibility', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns systemPrompt: undefined, tools: undefined, environment: undefined with no content', async () => {
      setupGuild({ home: tmpDir });
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
      assert.strictEqual(weave.tools, undefined);
      assert.strictEqual(weave.environment, undefined);
    });

    it('tool resolution and git identity are unaffected by composition logic', async () => {
      const rolesDir = path.join(tmpDir, 'roles');
      fs.mkdirSync(rolesDir);
      fs.writeFileSync(path.join(rolesDir, 'artificer.md'), 'Role text');

      const readTool = testTool('stack-query', 'read');
      const resolved: ResolvedTool[] = [{ definition: readTool, pluginId: 'stacks' }];
      const { api: instrumentarium } = mockInstrumentarium(resolved);

      setupGuild({
        home: tmpDir,
        loomConfig: { roles: { artificer: { permissions: ['stacks:read'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.equal(weave.tools?.length, 1);
      assert.equal(weave.tools?.[0]?.definition.name, 'stack-query');
      assert.deepStrictEqual(weave.environment, {
        GIT_AUTHOR_NAME: 'Artificer',
        GIT_AUTHOR_EMAIL: 'artificer@nexus.local',
      });
    });
  });
});
