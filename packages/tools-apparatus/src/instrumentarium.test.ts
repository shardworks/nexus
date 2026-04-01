/**
 * Instrumentarium — unit tests.
 *
 * Tests the tool registry, role-gated resolution, and channel filtering.
 * Uses a mock guild() singleton to simulate the plugin environment.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  tool,
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import {
  createInstrumentarium,
  type InstrumentariumApi,
  type InstrumentariumConfig,
} from './instrumentarium.ts';

// ── Test helpers ──────────────────────────────────────────────────────

/** Create a minimal tool definition for testing. */
function testTool(name: string, opts?: { callableFrom?: ('cli' | 'mcp')[] }) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(opts?.callableFrom ? { callableFrom: opts.callableFrom } : {}),
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
  config?: InstrumentariumConfig;
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];
  const toolsConfig = opts.config ?? {};

  const mockGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(pluginId: string): T {
      if (pluginId === 'tools') return toolsConfig as T;
      return {} as T;
    },
    guildConfig() {
      return {
        name: 'test',
        nexus: '0.0.0',
        workshops: {},
        roles: {},
        baseTools: [],
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
  config?: InstrumentariumConfig;
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

  describe('resolve()', () => {
    it('returns baseTools for empty roles', () => {
      const kit = mockKit('my-kit', [testTool('base-1'), testTool('base-2'), testTool('other')]);

      const { api } = startInstrumentarium({
        kits: [kit],
        config: { baseTools: ['base-1', 'base-2'] },
      });

      const resolved = api.resolve({ roles: [] });
      assert.equal(resolved.length, 2);
      assert.deepStrictEqual(
        resolved.map((t) => t.definition.name).sort(),
        ['base-1', 'base-2'],
      );
    });

    it('unions baseTools with role tools', () => {
      const kit = mockKit('my-kit', [
        testTool('base'),
        testTool('role-a'),
        testTool('role-b'),
        testTool('excluded'),
      ]);

      const { api } = startInstrumentarium({
        kits: [kit],
        config: {
          baseTools: ['base'],
          roles: {
            builder: ['role-a'],
            reviewer: ['role-b'],
          },
        },
      });

      const resolved = api.resolve({ roles: ['builder', 'reviewer'] });
      assert.equal(resolved.length, 3);
      assert.deepStrictEqual(
        resolved.map((t) => t.definition.name).sort(),
        ['base', 'role-a', 'role-b'],
      );
    });

    it('deduplicates tools shared across roles', () => {
      const kit = mockKit('my-kit', [testTool('shared'), testTool('unique')]);

      const { api } = startInstrumentarium({
        kits: [kit],
        config: {
          baseTools: ['shared'],
          roles: {
            a: ['shared', 'unique'],
          },
        },
      });

      const resolved = api.resolve({ roles: ['a'] });
      assert.equal(resolved.length, 2);
    });

    it('skips tool names that are not installed', () => {
      const kit = mockKit('my-kit', [testTool('exists')]);

      const { api } = startInstrumentarium({
        kits: [kit],
        config: { baseTools: ['exists', 'ghost'] },
      });

      const resolved = api.resolve({ roles: [] });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.definition.name, 'exists');
    });

    it('ignores unknown roles gracefully', () => {
      const kit = mockKit('my-kit', [testTool('base')]);

      const { api } = startInstrumentarium({
        kits: [kit],
        config: { baseTools: ['base'] },
      });

      const resolved = api.resolve({ roles: ['nonexistent-role'] });
      assert.equal(resolved.length, 1);
    });

    describe('channel filtering', () => {
      it('includes tools with no callableFrom restriction', () => {
        const kit = mockKit('my-kit', [testTool('unrestricted')]);

        const { api } = startInstrumentarium({
          kits: [kit],
          config: { baseTools: ['unrestricted'] },
        });

        const resolved = api.resolve({ roles: [], channel: 'cli' });
        assert.equal(resolved.length, 1);
      });

      it('includes tools that match the requested channel', () => {
        const kit = mockKit('my-kit', [
          testTool('cli-only', { callableFrom: ['cli'] }),
        ]);

        const { api } = startInstrumentarium({
          kits: [kit],
          config: { baseTools: ['cli-only'] },
        });

        const resolved = api.resolve({ roles: [], channel: 'cli' });
        assert.equal(resolved.length, 1);
      });

      it('excludes tools restricted to a different channel', () => {
        const kit = mockKit('my-kit', [
          testTool('mcp-only', { callableFrom: ['mcp'] }),
        ]);

        const { api } = startInstrumentarium({
          kits: [kit],
          config: { baseTools: ['mcp-only'] },
        });

        const resolved = api.resolve({ roles: [], channel: 'cli' });
        assert.equal(resolved.length, 0);
      });

      it('does not filter by channel when channel is omitted', () => {
        const kit = mockKit('my-kit', [
          testTool('cli-only', { callableFrom: ['cli'] }),
          testTool('mcp-only', { callableFrom: ['mcp'] }),
        ]);

        const { api } = startInstrumentarium({
          kits: [kit],
          config: { baseTools: ['cli-only', 'mcp-only'] },
        });

        const resolved = api.resolve({ roles: [] });
        assert.equal(resolved.length, 2);
      });
    });
  });
});
