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

import { setGuild, clearGuild, type LoadedKit, type LoadedApparatus, type KitEntry } from '@shardworks/nexus-core';
import { tool, type InstrumentariumApi, type ResolvedTool, type ResolveOptions } from '@shardworks/tools-apparatus';

import { createLoom, type LoomApi, type LoomConfig, type KitRoleDefinition, type LoomKit } from './loom.ts';
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
  kits?: LoadedKit[];
  loadedApparatuses?: LoadedApparatus[];
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
    kits: () => opts.kits ?? [],
    apparatuses: () => opts.loadedApparatuses ?? [],
  } as never);
}

/** Build a LoadedKit for testing. */
function makeLoadedKit(id: string, packageName: string, kit: Record<string, unknown>): LoadedKit {
  return { id, packageName, version: '0.0.0', kit };
}

/** Build a LoadedApparatus for testing. */
function makeLoadedApparatus(
  id: string,
  packageName: string,
  supportKit?: Record<string, unknown>,
): LoadedApparatus {
  return {
    id,
    packageName,
    version: '0.0.0',
    apparatus: {
      start: () => {},
      ...(supportKit !== undefined ? { supportKit } : {}),
    },
  };
}

const FRAMEWORK_KIT_FIELDS = new Set(['requires', 'recommends']);

function buildKitEntries(kits: LoadedKit[], apparatuses: LoadedApparatus[] = []): KitEntry[] {
  const entries: KitEntry[] = [];
  for (const kit of kits) {
    for (const [type, value] of Object.entries(kit.kit)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: kit.id, packageName: kit.packageName, type, value });
    }
  }
  for (const app of apparatuses) {
    const bag = app.apparatus.supportKit;
    if (!bag || typeof bag !== 'object') continue;
    for (const [type, value] of Object.entries(bag)) {
      if (FRAMEWORK_KIT_FIELDS.has(type)) continue;
      entries.push({ pluginId: app.id, packageName: app.packageName, type, value });
    }
  }
  return entries;
}

/** Create a started Loom and return its API for testing. */
function startLoom(kitEntries: KitEntry[] = []): LoomApi {
  const plugin = createLoom();
  const apparatus = (plugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  apparatus.start({
    on(_event: string, _handler: (...args: unknown[]) => void) {},
    kits(type: string): KitEntry[] {
      return [...kitEntries.filter(e => e.type === type)];
    },
  });
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

  // ── Kit role contributions ────────────────────────────────────────────

  describe('apparatus declaration', () => {
    it('has consumes: ["roles"]', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      assert.deepStrictEqual(apparatus.consumes, ['roles']);
    });

    it('has requires: ["tools"]', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      assert.deepStrictEqual(apparatus.requires, ['tools']);
    });
  });

  describe('kit role contributions — happy path', () => {
    afterEach(() => {
      clearGuild();
    });

    it('V1: standalone kit contributes a role, weave resolves it (R1, R2)', async () => {
      const readTool = testTool('spider-query', 'read');
      const resolved: ResolvedTool[] = [{ definition: readTool, pluginId: 'spider' }];
      const { api: instrumentarium, calls } = mockInstrumentarium(resolved);

      const loomKits = [makeLoadedKit('spider', '@test/spider-kit', { roles: { crawler: { permissions: ['spider:read'] } } })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'spider.crawler' });

      assert.ok(weave.tools, 'tools should be resolved');
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['spider:read']);
      assert.equal(calls[0]!.caller, 'anima');
    });

    it('kit role is qualified as {pluginId}.{roleName} (R2)', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('my-plugin', '@test/my-plugin-kit', { roles: { helper: { permissions: ['my-plugin:read'] } } })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));

      // Unqualified name should not resolve
      const weave1 = await api.weave({ role: 'helper' });
      assert.strictEqual(weave1.tools, undefined);

      // Qualified name should resolve
      await api.weave({ role: 'my-plugin.helper' });
      assert.equal(calls.length, 1);
    });

    it('two kits with same short role name register as separate qualified names (namespacing)', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [
        makeLoadedKit('kit-a', '@test/kit-a', { roles: { helper: { permissions: ['kit-a:read'] } } }),
        makeLoadedKit('kit-b', '@test/kit-b', { roles: { helper: { permissions: ['kit-b:read'] } } }),
      ];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));

      await api.weave({ role: 'kit-a.helper' });
      await api.weave({ role: 'kit-b.helper' });

      assert.equal(calls.length, 2);
      assert.deepStrictEqual(calls[0]!.permissions, ['kit-a:read']);
      assert.deepStrictEqual(calls[1]!.permissions, ['kit-b:read']);
    });

    it('apparatus supportKit contributes roles (R9, Phase 1b)', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomApparatuses = [
        makeLoadedApparatus('tools', '@shardworks/tools-apparatus', { roles: { helper: { permissions: ['tools:read'] } } }),
      ];
      setupGuild({
        loadedApparatuses: loomApparatuses,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries([], loomApparatuses));
      await api.weave({ role: 'tools.helper' });

      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['tools:read']);
    });

    it('weave() with unknown role returns no tools (existing behavior preserved)', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('spider', '@test/spider-kit', { roles: { crawler: { permissions: ['spider:read'] } } })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'nonexistent' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0);
    });

    it('no kit roles — existing guild behavior unchanged', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: { roles: { artificer: { permissions: ['*:*'] } } },
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom();
      await api.weave({ role: 'artificer' });

      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['*:*']);
    });
  });

  describe('kit role contributions — Wire phase apparatus supportKit (R9)', () => {
    afterEach(() => {
      clearGuild();
    });

    it('apparatus supportKit roles are available via Wire-phase ctx.kits()', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomApparatuses: LoadedApparatus[] = [{
        id: 'late',
        packageName: '@test/late-apparatus',
        version: '0.0.0',
        apparatus: {
          start: () => {},
          supportKit: { roles: { late: { permissions: ['late:read'] } } },
        },
      }];
      setupGuild({ loadedApparatuses: loomApparatuses, apparatuses: { tools: instrumentarium } });
      const api = startLoom(buildKitEntries([], loomApparatuses));

      const weave = await api.weave({ role: 'late.late' });
      assert.ok(weave.tools !== undefined || calls.length === 1, 'should have called instrumentarium');
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['late:read']);
    });

    it('apparatus without supportKit contributes no roles', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomApparatuses: LoadedApparatus[] = [{
        id: 'plain',
        packageName: '@test/plain',
        version: '0.0.0',
        apparatus: { start: () => {} },
      }];
      setupGuild({ loadedApparatuses: loomApparatuses, apparatuses: { tools: instrumentarium } });
      const api = startLoom(buildKitEntries([], loomApparatuses));

      await api.weave({ role: 'plain.something' });
      assert.equal(calls.length, 0);
    });

    it('kit without roles field — no crash', () => {
      const loomKits = [makeLoadedKit('plain-kit', '@test/plain-kit', { engines: [] })];
      setupGuild({ kits: loomKits });
      assert.doesNotThrow(() => startLoom(buildKitEntries(loomKits)));
    });
  });

  describe('kit role contributions — instructions (R3, R4, R5, R14)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('V2: inline instructions appear in systemPrompt', async () => {
      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { worker: { permissions: ['mykit:read'], instructions: 'You are a worker.' } },
      })];
      setupGuild({
        home: tmpDir,
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'mykit.worker' });
      assert.ok(weave.systemPrompt?.includes('You are a worker.'));
    });

    it('V2: instructionsFile content appears in systemPrompt', async () => {
      const packageDir = path.join(tmpDir, 'node_modules', '@test', 'mykit');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'role.md'), 'File instructions.');

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { worker: { permissions: ['mykit:read'], instructionsFile: 'role.md' } },
      })];
      setupGuild({
        home: tmpDir,
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'mykit.worker' });
      assert.ok(weave.systemPrompt?.includes('File instructions.'));
    });

    it('V2/R4: instructions takes precedence over instructionsFile', async () => {
      // Create the file so we can verify it's NOT read (instructions wins)
      const packageDir = path.join(tmpDir, 'node_modules', '@test', 'mykit');
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'role.md'), 'File instructions (should not appear).');

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: {
          worker: {
            permissions: ['mykit:read'],
            instructions: 'Inline wins.',
            instructionsFile: 'role.md',
          },
        },
      })];
      setupGuild({
        home: tmpDir,
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'mykit.worker' });
      assert.ok(weave.systemPrompt?.includes('Inline wins.'));
      assert.ok(!weave.systemPrompt?.includes('File instructions'));
    });

    it('V3/R5: missing instructionsFile — role registered, warning emitted, no instructions', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
          roles: { worker: { permissions: ['mykit:read'], instructionsFile: './missing.md' } },
        })];
        setupGuild({
          home: tmpDir,
          kits: loomKits,
        });
        const api = startLoom(buildKitEntries(loomKits));

        // Role should be registered (tool resolution works)
        // We verify this by checking that weave doesn't throw and there are no instructions
        const weave = await api.weave({ role: 'mykit.worker' });
        // Role IS registered (kitRoles has it) — no tools because no instrumentarium, but no error
        assert.strictEqual(weave.systemPrompt, undefined, 'no instructions when file missing');

        // Warning should be emitted
        const warnMatch = warnings.some(w => w.includes('Could not read instructions file') && w.includes('mykit'));
        assert.ok(warnMatch, `expected warning about missing file, got: ${JSON.stringify(warnings)}`);
      } finally {
        console.warn = origWarn;
      }
    });

    it('R14: kit role instructions cached at registration — deleting file after startup preserves instructions', async () => {
      const packageDir = path.join(tmpDir, 'node_modules', '@test', 'mykit');
      fs.mkdirSync(packageDir, { recursive: true });
      const rolePath = path.join(packageDir, 'role.md');
      fs.writeFileSync(rolePath, 'Cached kit instructions.');

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { worker: { permissions: ['mykit:read'], instructionsFile: 'role.md' } },
      })];
      setupGuild({
        home: tmpDir,
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));

      // Delete the file after startup
      fs.unlinkSync(rolePath);

      const weave = await api.weave({ role: 'mykit.worker' });
      assert.ok(weave.systemPrompt?.includes('Cached kit instructions.'));
    });
  });

  describe('kit role contributions — permission scoping (R6, R7)', () => {
    afterEach(() => {
      clearGuild();
    });

    it('V4: valid permissions from own plugin and declared deps are kept', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('foo', '@test/foo', {
        requires: ['bar'],
        recommends: ['baz'],
        roles: {
          worker: {
            permissions: ['foo:read', 'bar:write', 'baz:admin'],
          },
        },
      })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      await api.weave({ role: 'foo.worker' });

      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['foo:read', 'bar:write', 'baz:admin']);
    });

    it('V4: undeclared plugin permissions are dropped with warning', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const { api: instrumentarium, calls } = mockInstrumentarium([]);

        const loomKits = [makeLoadedKit('foo', '@test/foo', {
          roles: {
            worker: {
              permissions: ['foo:read', 'unknown:write'],
            },
          },
        })];
        setupGuild({
          kits: loomKits,
          apparatuses: { tools: instrumentarium },
        });
        const api = startLoom(buildKitEntries(loomKits));
        await api.weave({ role: 'foo.worker' });

        assert.equal(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.permissions, ['foo:read']);
        assert.ok(warnings.some(w => w.includes('unknown:write')));
      } finally {
        console.warn = origWarn;
      }
    });

    it('V4: wildcard * prefix is blocked with warning', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const { api: instrumentarium, calls } = mockInstrumentarium([]);

        const loomKits = [makeLoadedKit('foo', '@test/foo', {
          roles: {
            worker: {
              permissions: ['foo:read', '*:*', '*:level'],
            },
          },
        })];
        setupGuild({
          kits: loomKits,
          apparatuses: { tools: instrumentarium },
        });
        const api = startLoom(buildKitEntries(loomKits));
        await api.weave({ role: 'foo.worker' });

        assert.equal(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.permissions, ['foo:read']);
        assert.ok(warnings.some(w => w.includes('*:*')));
        assert.ok(warnings.some(w => w.includes('*:level')));
      } finally {
        console.warn = origWarn;
      }
    });

    it('V4/R7: permissions without colon are dropped with warning', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const { api: instrumentarium, calls } = mockInstrumentarium([]);

        const loomKits = [makeLoadedKit('foo', '@test/foo', {
          roles: {
            worker: {
              permissions: ['foo:read', 'nocolon'],
            },
          },
        })];
        setupGuild({
          kits: loomKits,
          apparatuses: { tools: instrumentarium },
        });
        const api = startLoom(buildKitEntries(loomKits));
        await api.weave({ role: 'foo.worker' });

        assert.equal(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.permissions, ['foo:read']);
        assert.ok(warnings.some(w => w.includes('nocolon') && w.includes('no colon')));
      } finally {
        console.warn = origWarn;
      }
    });

    it('all three warning types emitted for full set from spec V4', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const { api: instrumentarium, calls } = mockInstrumentarium([]);

        const loomKits = [makeLoadedKit('foo', '@test/foo', {
          requires: ['bar'],
          recommends: ['baz'],
          roles: {
            worker: {
              permissions: ['foo:read', 'bar:write', 'baz:admin', 'unknown:read', '*:*', 'nocolon'],
            },
          },
        })];
        setupGuild({
          kits: loomKits,
          apparatuses: { tools: instrumentarium },
        });
        const api = startLoom(buildKitEntries(loomKits));
        await api.weave({ role: 'foo.worker' });

        assert.deepStrictEqual(calls[0]!.permissions, ['foo:read', 'bar:write', 'baz:admin']);
        // Three warnings: unknown:read, *:*, nocolon
        assert.ok(warnings.some(w => w.includes('unknown:read')), 'warn for unknown:read');
        assert.ok(warnings.some(w => w.includes('*:*')), 'warn for *:*');
        assert.ok(warnings.some(w => w.includes('nocolon')), 'warn for nocolon');
        assert.equal(warnings.length, 3);
      } finally {
        console.warn = origWarn;
      }
    });
  });

  describe('kit role contributions — guild override (R8)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
    });

    afterEach(() => {
      clearGuild();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('V5: guild-defined role takes precedence over kit-contributed role at weave time', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('my-kit', '@test/my-kit', {
        roles: { artificer: { permissions: ['my-kit:read'] } },
      })];
      setupGuild({
        home: tmpDir,
        loomConfig: {
          roles: {
            'my-kit.artificer': { permissions: ['*:*'] }, // guild override
          },
        },
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      await api.weave({ role: 'my-kit.artificer' });

      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['*:*'], 'should use guild permissions');
    });

    it('V5: guild override at registration time — kit instructionsFile is never read', async () => {
      // Create the file so we can track if it would have been read
      const packageDir = path.join(tmpDir, 'node_modules', '@test', 'my-kit');
      fs.mkdirSync(packageDir, { recursive: true });
      const filePath = path.join(packageDir, 'role.md');
      fs.writeFileSync(filePath, 'Kit role instructions (should not appear).');

      const { api: instrumentarium } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('my-kit', '@test/my-kit', {
        roles: {
          artificer: {
            permissions: ['my-kit:read'],
            instructionsFile: 'role.md',
          },
        },
      })];
      setupGuild({
        home: tmpDir,
        loomConfig: {
          roles: {
            'my-kit.artificer': { permissions: ['*:*'] },
          },
        },
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'my-kit.artificer' });

      // Kit instructions should not appear (registration was skipped)
      assert.ok(!weave.systemPrompt?.includes('Kit role instructions'), 'kit instructions should not appear');
    });
  });

  describe('kit role contributions — malformed inputs (R11)', () => {
    afterEach(() => {
      clearGuild();
    });

    it('V8: roles field is a string — silently skipped, no crash', () => {
      const loomKits = [makeLoadedKit('bad-kit', '@test/bad-kit', { roles: 'not-an-object' })];
      setupGuild({ kits: loomKits });
      assert.doesNotThrow(() => startLoom(buildKitEntries(loomKits)));
    });

    it('V8: roles field is an array — silently skipped, no crash', () => {
      const loomKits = [makeLoadedKit('bad-kit', '@test/bad-kit', { roles: [] })];
      setupGuild({ kits: loomKits });
      assert.doesNotThrow(() => startLoom(buildKitEntries(loomKits)));
    });

    it('V8: roles field is null — silently skipped, no crash', () => {
      const loomKits = [makeLoadedKit('bad-kit', '@test/bad-kit', { roles: null })];
      setupGuild({ kits: loomKits });
      assert.doesNotThrow(() => startLoom(buildKitEntries(loomKits)));
    });

    it('V8: role entry missing permissions — warning emitted and skipped', async () => {
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

      try {
        const { api: instrumentarium, calls } = mockInstrumentarium([]);

        const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
          roles: { bad: { strict: true } }, // missing permissions
        })];
        setupGuild({
          kits: loomKits,
          apparatuses: { tools: instrumentarium },
        });
        const api = startLoom(buildKitEntries(loomKits));
        await api.weave({ role: 'mykit.bad' });

        // Role should be skipped — no calls to instrumentarium
        assert.equal(calls.length, 0);
        // Warning should mention missing permissions
        assert.ok(warnings.some(w => w.includes('missing required "permissions"') && w.includes('bad')));
      } finally {
        console.warn = origWarn;
      }
    });

    it('non-object role entry (number) skipped silently', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { bad: 42 },
      })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      await api.weave({ role: 'mykit.bad' });
      assert.equal(calls.length, 0);
    });

    it('kit without roles field — no crash', () => {
      const loomKits = [makeLoadedKit('plain-kit', '@test/plain-kit', { engines: [] })];
      setupGuild({ kits: loomKits });
      assert.doesNotThrow(() => startLoom(buildKitEntries(loomKits)));
    });
  });

  describe('kit role contributions — type exports (R12)', () => {
    it('V9: KitRoleDefinition is importable from loom.ts', () => {
      // Type is used in test imports — this test confirms it compiles
      const def: KitRoleDefinition = { permissions: ['foo:read'], strict: false };
      assert.ok(Array.isArray(def.permissions));
    });

    it('V9: LoomKit is importable from loom.ts', () => {
      // Type is used in test imports — this test confirms it compiles
      const kit: LoomKit = { roles: { worker: { permissions: ['foo:read'] } } };
      assert.ok(typeof kit.roles === 'object');
    });
  });

  describe('kit role contributions — git identity (R13)', () => {
    afterEach(() => {
      clearGuild();
    });

    it('V10: qualified role name gets standard git identity treatment', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('my-kit', '@test/my-kit', {
        roles: { artificer: { permissions: ['my-kit:read'] } },
      })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      const weave = await api.weave({ role: 'my-kit.artificer' });

      assert.deepStrictEqual(weave.environment, {
        GIT_AUTHOR_NAME: 'My-kit.artificer',
        GIT_AUTHOR_EMAIL: 'my-kit.artificer@nexus.local',
      });
    });
  });

  describe('kit role contributions — strict mode', () => {
    afterEach(() => {
      clearGuild();
    });

    it('strict flag is passed to instrumentarium when set on kit role', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { 'strict-worker': { permissions: ['mykit:read'], strict: true } },
      })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      await api.weave({ role: 'mykit.strict-worker' });

      assert.equal(calls[0]!.strict, true);
    });

    it('strict flag defaults to undefined (not set) when omitted', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      const loomKits = [makeLoadedKit('mykit', '@test/mykit', {
        roles: { worker: { permissions: ['mykit:read'] } },
      })];
      setupGuild({
        kits: loomKits,
        apparatuses: { tools: instrumentarium },
      });
      const api = startLoom(buildKitEntries(loomKits));
      await api.weave({ role: 'mykit.worker' });

      assert.ok(!calls[0]!.strict, 'strict should not be set when not declared');
    });
  });

  // ── listRoles() ───────────────────────────────────────────────────────

  describe('listRoles() — guild roles only', () => {
    afterEach(() => clearGuild());

    it('returns guild roles with source: guild', () => {
      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
            scribe: { permissions: ['stdlib:read'], strict: true },
          },
        },
      });
      const api = startLoom();
      const roles = api.listRoles();

      assert.equal(roles.length, 2);

      const artificer = roles.find(r => r.name === 'artificer');
      assert.ok(artificer, 'should have artificer role');
      assert.deepStrictEqual(artificer!.permissions, ['*:*']);
      assert.strictEqual(artificer!.source, 'guild');
      assert.strictEqual(artificer!.strict, undefined);

      const scribe = roles.find(r => r.name === 'scribe');
      assert.ok(scribe, 'should have scribe role');
      assert.deepStrictEqual(scribe!.permissions, ['stdlib:read']);
      assert.strictEqual(scribe!.strict, true);
      assert.strictEqual(scribe!.source, 'guild');
    });

    it('returns empty array when no roles configured', () => {
      setupGuild({ loomConfig: {} });
      const api = startLoom();
      assert.deepStrictEqual(api.listRoles(), []);
    });

    it('returns empty array when loomConfig is undefined', () => {
      setupGuild({});
      const api = startLoom();
      assert.deepStrictEqual(api.listRoles(), []);
    });
  });

  describe('listRoles() — kit roles only', () => {
    afterEach(() => clearGuild());

    it('returns kit roles with source equal to plugin ID', () => {
      const loomKits = [makeLoadedKit('spider', '@test/spider', {
        roles: { crawler: { permissions: ['spider:read'] } },
      })];
      setupGuild({ kits: loomKits });
      const api = startLoom(buildKitEntries(loomKits));
      const roles = api.listRoles();

      assert.equal(roles.length, 1);
      const crawler = roles[0]!;
      assert.strictEqual(crawler.name, 'spider.crawler');
      assert.deepStrictEqual(crawler.permissions, ['spider:read']);
      assert.strictEqual(crawler.source, 'spider');
      assert.strictEqual(crawler.strict, undefined);
    });
  });

  describe('listRoles() — mixed guild and kit roles', () => {
    afterEach(() => clearGuild());

    it('returns guild roles first, then kit roles', () => {
      const loomKits = [makeLoadedKit('spider', '@test/spider', {
        roles: { crawler: { permissions: ['spider:read'] } },
      })];
      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));
      const roles = api.listRoles();

      assert.equal(roles.length, 2);
      assert.strictEqual(roles[0]!.name, 'artificer');
      assert.strictEqual(roles[0]!.source, 'guild');
      assert.strictEqual(roles[1]!.name, 'spider.crawler');
      assert.strictEqual(roles[1]!.source, 'spider');
    });
  });

  describe('listRoles() — guild override of kit role', () => {
    afterEach(() => clearGuild());

    it('guild override wins; kit version is not registered', () => {
      const loomKits = [makeLoadedKit('spider', '@test/spider', {
        roles: { crawler: { permissions: ['spider:read'] } },
      })];
      setupGuild({
        loomConfig: {
          roles: {
            'spider.crawler': { permissions: ['*:*'] },
          },
        },
        kits: loomKits,
      });
      const api = startLoom(buildKitEntries(loomKits));
      const roles = api.listRoles();

      assert.equal(roles.length, 1);
      const role = roles[0]!;
      assert.strictEqual(role.name, 'spider.crawler');
      assert.strictEqual(role.source, 'guild');
      assert.deepStrictEqual(role.permissions, ['*:*']);
    });
  });

  // ── apparatus shape (recommends, supportKit) ──────────────────────────

  describe('apparatus shape — recommends and supportKit', () => {
    it('includes recommends: [oculus]', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      assert.deepStrictEqual(apparatus.recommends, ['oculus']);
    });

    it('includes supportKit with pages contribution', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      const supportKit = apparatus.supportKit as Record<string, unknown>;
      assert.ok(supportKit, 'should have supportKit');
      assert.deepStrictEqual(supportKit.pages, [{ id: 'loom', title: 'Roles', dir: 'pages/loom' }]);
    });

    it('includes supportKit with two tools', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as unknown[];
      assert.ok(Array.isArray(tools), 'supportKit.tools should be an array');
      assert.equal(tools.length, 2);
    });

    it('loom-roles tool has correct name and no callableBy/permission', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as Array<Record<string, unknown>>;
      const loomRoles = tools.find(t => t.name === 'loom-roles');
      assert.ok(loomRoles, 'should have loom-roles tool');
      assert.strictEqual(loomRoles!.callableBy, undefined);
      assert.strictEqual(loomRoles!.permission, undefined);
    });

    it('loom-weave tool has correct name, role param, no callableBy/permission', () => {
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> }).apparatus;
      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as Array<Record<string, unknown>>;
      const loomWeave = tools.find(t => t.name === 'loom-weave');
      assert.ok(loomWeave, 'should have loom-weave tool');
      assert.strictEqual(loomWeave!.callableBy, undefined);
      assert.strictEqual(loomWeave!.permission, undefined);
      // params is a ZodObject with role key
      const params = loomWeave!.params as { shape: Record<string, unknown> };
      assert.ok(params && params.shape && params.shape.role, 'should have role param');
    });
  });

  // ── loom-roles tool handler ───────────────────────────────────────────

  describe('loom-roles tool handler', () => {
    afterEach(() => clearGuild());

    it('returns the same result as api.listRoles()', async () => {
      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
      });
      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> & { start: (ctx: unknown) => void; provides: LoomApi } }).apparatus;
      apparatus.start({ on: () => {}, kits: () => [] });
      const api = apparatus.provides;

      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as Array<{ name: string; handler: (p: Record<string, unknown>) => unknown }>;
      const loomRoles = tools.find(t => t.name === 'loom-roles');
      assert.ok(loomRoles);

      const result = await loomRoles!.handler({});
      assert.deepStrictEqual(result, api.listRoles());
    });
  });

  // ── loom-weave tool handler ───────────────────────────────────────────

  describe('loom-weave tool handler', () => {
    afterEach(() => clearGuild());

    it('returns JSON-serializable result with tools mapped to plain objects', async () => {
      const readTool = testTool('stack-query', 'read');
      const resolved: ResolvedTool[] = [
        { definition: readTool, pluginId: 'stacks' },
      ];
      const { api: instrumentarium } = mockInstrumentarium(resolved);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['stacks:read'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> & { start: (ctx: unknown) => void } }).apparatus;
      apparatus.start({ on: () => {}, kits: () => [] });

      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as Array<{ name: string; handler: (p: Record<string, unknown>) => unknown }>;
      const loomWeave = tools.find(t => t.name === 'loom-weave');
      assert.ok(loomWeave);

      const result = await loomWeave!.handler({ role: 'artificer' }) as Record<string, unknown>;

      // Verify tools array contains plain objects (JSON-serializable)
      assert.ok(Array.isArray(result.tools), 'tools should be an array');
      const toolEntry = (result.tools as Array<Record<string, unknown>>)[0]!;
      assert.strictEqual(toolEntry.name, 'stack-query');
      assert.strictEqual(toolEntry.permission, 'read');
      assert.strictEqual(toolEntry.pluginId, 'stacks');
      // Should not have handler or params (Zod) on the plain object
      assert.ok(!('handler' in toolEntry), 'should not have handler');
      assert.ok(!('params' in toolEntry), 'should not have params/Zod schema');

      // Verify environment is present
      assert.ok(result.environment, 'should have environment');

      // Verify JSON serializable
      assert.doesNotThrow(() => JSON.stringify(result), 'result should be JSON serializable');
    });

    it('returns result for unknown role (no tools, has environment)', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        apparatuses: { tools: instrumentarium },
      });

      const plugin = createLoom();
      const apparatus = (plugin as { apparatus: Record<string, unknown> & { start: (ctx: unknown) => void } }).apparatus;
      apparatus.start({ on: () => {}, kits: () => [] });

      const supportKit = apparatus.supportKit as Record<string, unknown>;
      const tools = supportKit.tools as Array<{ name: string; handler: (p: Record<string, unknown>) => unknown }>;
      const loomWeave = tools.find(t => t.name === 'loom-weave');
      assert.ok(loomWeave);

      const result = await loomWeave!.handler({ role: 'nonexistent' }) as Record<string, unknown>;

      assert.strictEqual(result.systemPrompt, undefined);
      assert.strictEqual(result.tools, undefined);
      // environment is derived from role name even for unknown roles
      assert.ok(result.environment, 'should have environment derived from role name');
    });
  });
});
