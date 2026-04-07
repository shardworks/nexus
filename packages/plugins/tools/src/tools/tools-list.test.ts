/**
 * tools-list — unit tests.
 *
 * Tests the administrative tool listing with various filter combinations.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  LoadedKit,
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from '../tool.ts';
import {
  createInstrumentarium,
  type InstrumentariumApi,
} from '../instrumentarium.ts';

// ── Test helpers ──────────────────────────────────────────────────────

function testTool(
  name: string,
  opts?: {
    callableBy?: ('patron' | 'anima' | 'library')[];
    permission?: string;
    description?: string;
  },
) {
  return tool({
    name,
    description: opts?.description ?? `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(opts?.callableBy ? { callableBy: opts.callableBy } : {}),
    ...(opts?.permission !== undefined ? { permission: opts.permission } : {}),
  });
}

function mockKit(id: string, tools: unknown[]): LoadedKit {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    kit: { tools },
  };
}

function wireGuild(kits: LoadedKit[]): void {
  const mockGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() {},
    guildConfig() {
      return { name: 'test', nexus: '0.0.0', workshops: {}, plugins: [] };
    },
    kits() { return [...kits]; },
    apparatuses() { return []; },
  };
  setGuild(mockGuild);
}

function startInstrumentarium(kits: LoadedKit[]): InstrumentariumApi {
  wireGuild(kits);
  const plugin = createInstrumentarium();
  const api = ('apparatus' in plugin ? plugin.apparatus.provides : null) as InstrumentariumApi;
  assert.ok(api);

  const ctx: StartupContext = { on() {} };
  if ('apparatus' in plugin) {
    plugin.apparatus.start(ctx);
  }

  return api;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('tools-list', () => {
  afterEach(() => {
    clearGuild();
  });

  it('lists all tools with summary fields', async () => {
    const kit = mockKit('stdlib', [
      testTool('writ-create', { permission: 'write', description: 'Create a writ' }),
      testTool('writ-list', { permission: 'read', description: 'List writs' }),
    ]);

    const api = startInstrumentarium([kit]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({}) as Array<Record<string, unknown>>;
    // Should include kit tools + the two introspection tools (tools-list, tools-show)
    const kitTools = result.filter((t) => t.pluginId === 'stdlib');
    assert.equal(kitTools.length, 2);

    const writCreate = kitTools.find((t) => t.name === 'writ-create');
    assert.ok(writCreate);
    assert.equal(writCreate.description, 'Create a writ');
    assert.equal(writCreate.permission, 'write');
    assert.equal(writCreate.callableBy, null);
  });

  it('filters by plugin', async () => {
    const kit1 = mockKit('stdlib', [testTool('alpha', { permission: 'read' })]);
    const kit2 = mockKit('clockworks', [testTool('beta', { permission: 'read' })]);

    const api = startInstrumentarium([kit1, kit2]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({ plugin: 'clockworks' }) as Array<Record<string, unknown>>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'beta');
  });

  it('filters by permission level', async () => {
    const kit = mockKit('stdlib', [
      testTool('reader', { permission: 'read' }),
      testTool('writer', { permission: 'write' }),
      testTool('free'), // permissionless
    ]);

    const api = startInstrumentarium([kit]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({ permission: 'write' }) as Array<Record<string, unknown>>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'writer');
  });

  it('filters by caller type', async () => {
    const kit = mockKit('stdlib', [
      testTool('cli-only', { callableBy: ['patron'], permission: 'read' }),
      testTool('anima-only', { callableBy: ['anima'], permission: 'read' }),
      testTool('unrestricted', { permission: 'read' }),
    ]);

    const api = startInstrumentarium([kit]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({ caller: 'anima' }) as Array<Record<string, unknown>>;
    const names = result.map((t) => t.name);
    assert.ok(names.includes('anima-only'));
    assert.ok(names.includes('unrestricted'));
    assert.ok(!names.includes('cli-only'));
  });

  it('combines filters with AND logic', async () => {
    const kit1 = mockKit('stdlib', [
      testTool('read-std', { permission: 'read' }),
      testTool('write-std', { permission: 'write' }),
    ]);
    const kit2 = mockKit('clockworks', [
      testTool('read-clock', { permission: 'read' }),
    ]);

    const api = startInstrumentarium([kit1, kit2]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({
      plugin: 'stdlib',
      permission: 'read',
    }) as Array<Record<string, unknown>>;
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, 'read-std');
  });

  it('returns empty array when no tools match filters', async () => {
    const kit = mockKit('stdlib', [testTool('alpha', { permission: 'read' })]);

    const api = startInstrumentarium([kit]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);

    const result = await toolsList.definition.handler({ plugin: 'nonexistent' }) as Array<Record<string, unknown>>;
    assert.equal(result.length, 0);
  });

  it('has read permission', () => {
    const api = startInstrumentarium([]);
    const toolsList = api.find('tools-list');
    assert.ok(toolsList);
    assert.equal(toolsList.definition.permission, 'read');
  });
});
