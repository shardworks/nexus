/**
 * Instrumentarium — unit tests.
 *
 * Tests the tool registry, permission-based resolution, strict mode,
 * and channel filtering. Uses a mock guild() singleton to simulate
 * the plugin environment.
 */

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
  opts?: { callableFrom?: ('cli' | 'mcp')[]; permission?: string },
) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(opts?.callableFrom ? { callableFrom: opts.callableFrom } : {}),
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
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];

  const mockGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
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

// ── Tests ─────────────────────────────────────────────────────────────

describe('Instrumentarium', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('list()', () => {
    it('returns empty when no tools installed', () => {
      const { api } = startInstrumentarium({});
      assert.deepStrictEqual(api.list(), []);
    });

    it('scans tools from kits loaded before startup', () => {
      const t1 = testTool('alpha');
      const t2 = testTool('beta');
      const kit = mockKit('my-kit', [t1, t2]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const tools = api.list();
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

      const tools = api.list();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.definition.name, 'gamma');
      assert.equal(tools[0]!.pluginId, 'my-apparatus');
    });

    it('combines tools from multiple kits and apparatus', async () => {
      const kit = mockKit('kit-a', [testTool('one'), testTool('two')]);
      const app = mockApparatus('app-b', [testTool('three')]);

      const { api, fire } = startInstrumentarium({ kits: [kit] });
      await fire('plugin:initialized', app);

      assert.equal(api.list().length, 3);
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
      assert.equal(api.list().length, 1);
      assert.equal(api.list()[0]!.definition.name, 'valid');
    });

    it('last-write-wins for duplicate tool names', () => {
      const kit1 = mockKit('kit-1', [testTool('dup')]);
      const kit2 = mockKit('kit-2', [testTool('dup')]);

      const { api } = startInstrumentarium({ kits: [kit1, kit2] });

      const tools = api.list();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.pluginId, 'kit-2');
    });

    it('returns all tools regardless of permissions', () => {
      const kit = mockKit('my-kit', [
        testTool('read-tool', { permission: 'read' }),
        testTool('write-tool', { permission: 'write' }),
        testTool('free-tool'),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });
      assert.equal(api.list().length, 3);
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

      const resolved = api.resolve({ permissions: ['*:read'] });
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

      const resolved = api.resolve({ permissions: ['*:*'] });
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

      const resolved = api.resolve({
        permissions: ['*:*'],
        strict: true,
      });
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

      const resolved = api.resolve({
        permissions: ['*:read'],
        strict: true,
      });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'list-writs');
    });
  });

  describe('resolve() — channel filtering with permissions', () => {
    it('includes tools with no callableFrom restriction', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('signal', { permission: 'write' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:write'],
        channel: 'mcp',
      });
      assert.equal(resolved.length, 1);
    });

    it('includes tools that match the requested channel', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('cli-only', { callableFrom: ['cli'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:read'],
        channel: 'cli',
      });
      assert.equal(resolved.length, 1);
    });

    it('excludes tools restricted to a different channel', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('mcp-only', { callableFrom: ['mcp'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({
        permissions: ['nexus-stdlib:read'],
        channel: 'cli',
      });
      assert.equal(resolved.length, 0);
    });

    it('does not filter by channel when channel is omitted', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('cli-only', { callableFrom: ['cli'], permission: 'read' }),
        testTool('mcp-only', { callableFrom: ['mcp'], permission: 'read' }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      const resolved = api.resolve({ permissions: ['nexus-stdlib:read'] });
      assert.equal(resolved.length, 2);
    });

    it('channel filtering works with permissionless tools in default mode', () => {
      const kit = mockKit('nexus-stdlib', [
        testTool('mcp-only-free', { callableFrom: ['mcp'] }),
      ]);

      const { api } = startInstrumentarium({ kits: [kit] });

      assert.equal(
        api.resolve({ permissions: [], channel: 'cli' }).length,
        0,
      );
      assert.equal(
        api.resolve({ permissions: [], channel: 'mcp' }).length,
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
});
