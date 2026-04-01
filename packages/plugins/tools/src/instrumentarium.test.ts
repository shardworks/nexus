/**
 * Instrumentarium — unit tests.
 *
 * Tests the tool registry, permission-based resolution, strict mode,
 * and channel filtering. Uses a mock guild() singleton to simulate
 * the plugin environment.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from './tool.ts';
import {
  createInstrumentarium,
  type InstrumentariumApi,
} from './instrumentarium.ts';

// ── Test helpers ──────────────────────────────────────────────────────

/** Create a minimal tool definition for testing. */
function testTool(
  name: string,
  opts?: { callableBy?: ('cli' | 'anima' | 'library')[]; permission?: string },
) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(opts?.callableBy ? { callableBy: opts.callableBy } : {}),
    ...(opts?.permission !== undefined ? { permission: opts.permission } : {}),
  });
}

/** Build a mock LoadedKit. */
function mockKit(id: string, tools: unknown[]): LoadedKit {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    kit: { tools },
  };
}

/** Build a mock LoadedApparatus with supportKit tools. */
function mockApparatus(
  id: string,
  supportKitTools: unknown[],
): LoadedApparatus {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    apparatus: {
      start() {},
      supportKit: { tools: supportKitTools },
    },
  };
}

/** Build a mock Guild and wire it into the singleton. */
function wireGuild(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
  home?: string;
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];

  const mockGuild: Guild = {
    home: opts.home ?? '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() { /* noop in test */ },
    guildConfig() {
      return {
        name: 'test',
        nexus: '0.0.0',
        workshops: {},
        plugins: [],
      };
    },
    kits() { return [...kits]; },
    apparatuses() { return [...apparatuses]; },
  };

  setGuild(mockGuild);
}

/**
 * Build a StartupContext that captures event subscriptions.
 * Returns both the context and a fire() function to trigger events.
 */
function buildTestContext(): {
  ctx: StartupContext;
  fire: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();

  const ctx: StartupContext = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }

  return { ctx, fire };
}

/** Start the Instrumentarium and return its API. */
function startInstrumentarium(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
  home?: string;
}): { api: InstrumentariumApi; fire: (event: string, ...args: unknown[]) => Promise<void> } {
  wireGuild(opts);

  const plugin = createInstrumentarium();
  const api = ('apparatus' in plugin ? plugin.apparatus.provides : null) as InstrumentariumApi;
  assert.ok(api, 'Instrumentarium must have provides');

  const { ctx, fire } = buildTestContext();
  if ('apparatus' in plugin) {
    plugin.apparatus.start(ctx);
  }

  return { api, fire };
}

// ── Constants ────────────────────────────────────────────────────────

/** Names of the Instrumentarium's self-registered introspection tools. */
const SELF_TOOLS = new Set(['tools-list', 'tools-show']);

/** Filter out the Instrumentarium's own tools for tests that count external tools. */
function externalOnly(tools: { definition: { name: string } }[]) {
  return tools.filter((t) => !SELF_TOOLS.has(t.definition.name));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Instrumentarium', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('list()', () => {
    it('returns only self-registered tools when no external tools installed', () => {
      const { api } = startInstrumentarium({});
      const external = externalOnly(api.list());
      assert.equal(external.length, 0);
      // Self-registered introspection tools are always present
      assert.ok(api.find('tools-list'));
      assert.ok(api.find('tools-show'));
    });

    it('scans tools from kits loaded before startup', () => {
      const t1 = testTool('alpha');
      const t2 = testTool('beta');
      const kit = mockKit('my-kit', [t1, t2]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const tools = externalOnly(api.list());
      assert.equal(tools.length, 2);
      assert.deepStrictEqual(
        tools.map((t) => t.definition.name).sort(),
        ['alpha', 'beta'],
      );
      assert.ok(tools.every((t) => t.pluginId === 'my-kit'));
    });

    it('scans tools from apparatus supportKits via plugin:initialized', async () => {
      const t1 = testTool('gamma');
      const app = mockApparatus('my-apparatus', [t1]);

      const { api, fire } = startInstrumentarium({});

      // Simulate apparatus loading after Instrumentarium started
      await fire('plugin:initialized', app);

      const tools = externalOnly(api.list());
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.definition.name, 'gamma');
      assert.equal(tools[0]!.pluginId, 'my-apparatus');
    });

    it('combines tools from multiple kits and apparatus', async () => {
      const kit = mockKit('kit-a', [testTool('one'), testTool('two')]);
      const app = mockApparatus('app-b', [testTool('three')]);

      const { api, fire } = startInstrumentarium({ kits: [kit] });
      await fire('plugin:initialized', app);

      assert.equal(externalOnly(api.list()).length, 3);
    });

    it('ignores non-tool entries in kit contributions', () => {
      const kit = mockKit('messy-kit', [
        testTool('valid'),
        'not a tool',
        42,
        null,
        { name: 'incomplete' },
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });
      const external = externalOnly(api.list());
      assert.equal(external.length, 1);
      assert.equal(external[0]!.definition.name, 'valid');
    });

    it('last-write-wins for duplicate tool names', () => {
      const kit1 = mockKit('kit-1', [testTool('dup')]);
      const kit2 = mockKit('kit-2', [testTool('dup')]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const dups = externalOnly(api.list()).filter(
        (t) => t.definition.name === 'dup',
      );
      assert.equal(dups.length, 1);
      assert.equal(dups[0]!.pluginId, 'kit-2');
    });

    it('returns all tools regardless of permissions', () => {
      const kit = mockKit('my-kit', [
        testTool('read-tool', { permission: 'read' }),
        testTool('write-tool', { permission: 'write' }),
        testTool('free-tool'),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });
      assert.equal(externalOnly(api.list()).length, 3);
    });
  });

  describe('find()', () => {
    it('returns null for unknown tool', () => {
      const { api } = startInstrumentarium({});
      assert.equal(api.find('nonexistent'), null);
    });

    it('finds a tool by name', () => {
      const kit = mockKit('my-kit', [testTool('target')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      const result = api.find('target');
      assert.ok(result);
      assert.equal(result.definition.name, 'target');
      assert.equal(result.pluginId, 'my-kit');
    });
  });

  describe('resolve() — permission matching', () => {
    it('exact match: plugin:level', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
        testTool('list-writs', { permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:write'] });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'create-writ');
    });

    it('plugin wildcard: plugin:* matches any level', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
        testTool('list-writs', { permission: 'read' }),
        testTool('delete-writ', { permission: 'delete' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:*'] });
      assert.equal(resolved.length, 3);
    });

    it('level wildcard: *:level matches any plugin', () => {
      const kit1 = mockKit('nexus-stdlib', [
        testTool('list-writs', { permission: 'read' }),
        testTool('create-writ', { permission: 'write' }),
      ]);
      const kit2 = mockKit('clockworks', [
        testTool('clock-status', { permission: 'read' }),
        testTool('clock-start', { permission: 'admin' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const resolved = externalOnly(api.resolve({ permissions: ['*:read'] }));
      assert.equal(resolved.length, 2);
      const names = resolved.map((t) => t.definition.name).sort();
      assert.deepStrictEqual(names, ['clock-status', 'list-writs']);
    });

    it('superuser: *:* matches everything', () => {
      const kit1 = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
        testTool('list-writs', { permission: 'read' }),
      ]);
      const kit2 = mockKit('clockworks', [
        testTool('clock-start', { permission: 'admin' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const resolved = externalOnly(api.resolve({ permissions: ['*:*'] }));
      assert.equal(resolved.length, 3);
    });

    it('non-matching grants correctly exclude', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      // Wrong level
      assert.equal(
        api.resolve({ permissions: ['nexus-stdlib:read'] }).length,
        0,
      );

      // Wrong plugin
      assert.equal(
        api.resolve({ permissions: ['other:write'] }).length,
        0,
      );

      // Wrong plugin wildcard
      assert.equal(
        api.resolve({ permissions: ['other:*'] }).length,
        0,
      );
    });

    it('multiple grants are unioned', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
        testTool('list-writs', { permission: 'read' }),
        testTool('delete-writ', { permission: 'delete' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:read', 'nexus-stdlib:write'],
      });
      assert.equal(resolved.length, 2);
      const names = resolved.map((t) => t.definition.name).sort();
      assert.deepStrictEqual(names, ['create-writ', 'list-writs']);
    });

    it('no hierarchy — write does not imply read', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('list-writs', { permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:write'] });
      assert.equal(resolved.length, 0);
    });

    it('ignores malformed grants (no colon)', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('list-writs', { permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib-read', 'nexus-stdlib:read'] });
      assert.equal(resolved.length, 1);
    });
  });

  describe('resolve() — permissionless tools', () => {
    it('default mode: permissionless tools always included', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      // Even with no matching grants for 'write', 'signal' is included
      const resolved = api.resolve({ permissions: [] });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'signal');
    });

    it('default mode: permissionless tools included alongside permission-matched tools', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:write'] });
      assert.equal(resolved.length, 2);
    });

    it('strict mode: permissionless tools excluded', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:write'],
        strict: true,
      });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'create-writ');
    });

    it('strict mode: plugin:* includes permissionless tools from that plugin', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:*'],
        strict: true,
      });
      assert.equal(resolved.length, 2);
    });

    it('strict mode: *:* includes all permissionless tools', () => {
      const kit1 = mockKit('nexus-stdlib', [testTool('signal')]);
      const kit2 = mockKit('clockworks', [testTool('emit')]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const resolved = externalOnly(api.resolve({
        permissions: ['*:*'],
        strict: true,
      }));
      assert.equal(resolved.length, 2);
    });

    it('strict mode: specific plugin:level does NOT include permissionless tools', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:write'],
        strict: true,
      });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'create-writ');
    });

    it('strict mode: *:level does NOT include permissionless tools', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('list-writs', { permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = externalOnly(api.resolve({
        permissions: ['*:read'],
        strict: true,
      }));
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'list-writs');
    });
  });

  describe('resolve() — caller filtering with permissions', () => {
    it('includes tools with no callableBy restriction', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:write'],
        caller: 'anima',
      });
      assert.equal(resolved.length, 1);
    });

    it('includes tools that match the requested caller', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('cli-only', { callableBy: ['cli'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:read'],
        caller: 'cli',
      });
      assert.equal(resolved.length, 1);
    });

    it('excludes tools restricted to a different caller', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('anima-only', { callableBy: ['anima'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:read'],
        caller: 'cli',
      });
      assert.equal(resolved.length, 0);
    });

    it('does not filter by caller when caller is omitted', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('cli-only', { callableBy: ['cli'], permission: 'read' }),
        testTool('anima-only', { callableBy: ['anima'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:read'] });
      assert.equal(resolved.length, 2);
    });

    it('caller filtering works with permissionless tools in default mode', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('anima-only-free', { callableBy: ['anima'] }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      assert.equal(
        api.resolve({ permissions: [], caller: 'cli' }).length,
        0,
      );
      assert.equal(
        api.resolve({ permissions: [], caller: 'anima' }).length,
        1,
      );
    });
  });

  describe('resolve() — cross-plugin scenarios', () => {
    it('grants from different plugins resolve independently', () => {
      const kit1 = mockKit('nexus-stdlib', [
        testTool('create-writ', { permission: 'write' }),
        testTool('list-writs', { permission: 'read' }),
      ]);
      const kit2 = mockKit('clockworks', [
        testTool('clock-start', { permission: 'write' }),
        testTool('clock-status', { permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:*', 'clockworks:read'],
      });
      assert.equal(resolved.length, 3);
      const names = resolved.map((t) => t.definition.name).sort();
      assert.deepStrictEqual(names, ['clock-status', 'create-writ', 'list-writs']);
    });

    it('empty permissions returns only permissionless tools in default mode', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: [] });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'signal');
    });

    it('empty permissions in strict mode returns nothing', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal'), // no permission
        testTool('create-writ', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: [], strict: true });
      assert.equal(resolved.length, 0);
    });
  });

  describe('instruction pre-loading', () => {
    let tmpDir: string;

    /** Create a temp guild root with a package directory and optional instructions file. */
    function setupTmpGuild(packageName: string, instructionsContent?: string): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instrumentarium-test-'));
      const pkgDir = path.join(tmpDir, 'node_modules', packageName);
      fs.mkdirSync(pkgDir, { recursive: true });
      if (instructionsContent !== undefined) {
        fs.writeFileSync(path.join(pkgDir, 'instructions.md'), instructionsContent);
      }
      return tmpDir;
    }

    afterEach(() => {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('pre-loads instructionsFile into instructions text', () => {
      const guildHome = setupTmpGuild('@test/nexus-stdlib', 'Use this tool carefully.');

      const fileTool = tool({
        name: 'careful-tool',
        description: 'A tool with file instructions',
        params: {},
        handler: async () => ({}),
        instructionsFile: './instructions.md',
        permission: 'read',
      });
      const kit = mockKit('nexus-stdlib', [fileTool]);

      const { api } = startInstrumentarium({ kits: [kit], home: guildHome });

      const found = api.find('careful-tool');
      assert.ok(found);
      assert.equal(found.definition.instructions, 'Use this tool carefully.');
      assert.equal(found.definition.instructionsFile, undefined);
    });

    it('preserves inline instructions without change', () => {
      const guildHome = setupTmpGuild('@test/nexus-stdlib');

      const inlineTool = tool({
        name: 'inline-tool',
        description: 'A tool with inline instructions',
        params: {},
        handler: async () => ({}),
        instructions: 'Inline guidance here.',
      });
      const kit = mockKit('nexus-stdlib', [inlineTool]);

      const { api } = startInstrumentarium({ kits: [kit], home: guildHome });

      const found = api.find('inline-tool');
      assert.ok(found);
      assert.equal(found.definition.instructions, 'Inline guidance here.');
    });

    it('warns and registers tool when instructionsFile is missing', () => {
      const guildHome = setupTmpGuild('@test/nexus-stdlib'); // no file created

      const missingTool = tool({
        name: 'missing-instructions',
        description: 'Instructions file does not exist',
        params: {},
        handler: async () => ({}),
        instructionsFile: './instructions.md',
      });
      const kit = mockKit('nexus-stdlib', [missingTool]);

      // Should not throw — tool is registered without instructions
      const { api } = startInstrumentarium({ kits: [kit], home: guildHome });

      const found = api.find('missing-instructions');
      assert.ok(found, 'tool should still be registered');
      assert.equal(found.definition.instructions, undefined);
      assert.equal(found.definition.instructionsFile, undefined);
    });

    it('tools without instructions or instructionsFile are unchanged', () => {
      const guildHome = setupTmpGuild('@test/nexus-stdlib');

      const plainTool = tool({
        name: 'plain-tool',
        description: 'No instructions at all',
        params: {},
        handler: async () => ({}),
      });
      const kit = mockKit('nexus-stdlib', [plainTool]);

      const { api } = startInstrumentarium({ kits: [kit], home: guildHome });

      const found = api.find('plain-tool');
      assert.ok(found);
      assert.equal(found.definition.instructions, undefined);
      assert.equal(found.definition.instructionsFile, undefined);
    });
  });
});
