/**
 * tools-show — unit tests.
 *
 * Tests the tool detail view including parameter schema extraction
 * and instructions display.
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
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from '../tool.ts';
import {
  createInstrumentarium,
  type InstrumentariumApi,
} from '../instrumentarium.ts';

// ── Test helpers ──────────────────────────────────────────────────────

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

describe('tools-show', () => {
  afterEach(() => {
    clearGuild();
  });

  it('returns null for unknown tool', async () => {
    const api = startInstrumentarium([]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'nonexistent' });
    assert.equal(result, null);
  });

  it('returns full detail for a known tool', async () => {
    const target = tool({
      name: 'writ-create',
      description: 'Create a new writ',
      permission: 'write',
      callableBy: ['patron', 'anima'],
      params: {
        title: z.string().describe('The writ title'),
        priority: z.number().optional().describe('Priority level'),
      },
      handler: async () => ({ ok: true }),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'writ-create' }) as Record<string, unknown>;
    assert.equal(result.name, 'writ-create');
    assert.equal(result.description, 'Create a new writ');
    assert.equal(result.pluginId, 'stdlib');
    assert.equal(result.permission, 'write');
    assert.deepStrictEqual(result.callableBy, ['patron', 'anima']);
  });

  it('extracts parameter schema with types and descriptions', async () => {
    const target = tool({
      name: 'paramful',
      description: 'Tool with various param types',
      params: {
        name: z.string().describe('A name'),
        count: z.number().describe('A count'),
        active: z.boolean().describe('Is active'),
        tags: z.array(z.string()).describe('Tag list'),
      },
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'paramful' }) as Record<string, unknown>;
    const params = result.params as Record<string, Record<string, unknown>>;

    assert.equal(params.name.type, 'string');
    assert.equal(params.name.description, 'A name');
    assert.equal(params.name.optional, false);

    assert.equal(params.count.type, 'number');
    assert.equal(params.active.type, 'boolean');
    assert.equal(params.tags.type, 'array');
  });

  it('marks optional parameters correctly', async () => {
    const target = tool({
      name: 'optional-params',
      description: 'Tool with optional params',
      params: {
        required: z.string().describe('Required field'),
        optional: z.string().optional().describe('Optional field'),
        defaulted: z.string().default('foo').describe('Defaulted field'),
      },
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'optional-params' }) as Record<string, unknown>;
    const params = result.params as Record<string, Record<string, unknown>>;

    assert.equal(params.required.optional, false);
    assert.equal(params.optional.optional, true);
    assert.equal(params.defaulted.optional, true);
  });

  it('handles enum parameters', async () => {
    const target = tool({
      name: 'enum-tool',
      description: 'Tool with enum param',
      params: {
        status: z.enum(['active', 'inactive']).describe('Status filter'),
      },
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'enum-tool' }) as Record<string, unknown>;
    const params = result.params as Record<string, Record<string, unknown>>;

    assert.equal(params.status.type, 'string');
  });

  it('includes instructions when present', async () => {
    const target = tool({
      name: 'documented-tool',
      description: 'A well-documented tool',
      instructions: 'Use this tool when you need to do the thing. Do not use it for the other thing.',
      params: {},
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'documented-tool' }) as Record<string, unknown>;
    assert.equal(result.instructions, 'Use this tool when you need to do the thing. Do not use it for the other thing.');
  });

  it('returns null instructions when tool has none', async () => {
    const target = tool({
      name: 'undocumented',
      description: 'No instructions',
      params: {},
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'undocumented' }) as Record<string, unknown>;
    assert.equal(result.instructions, null);
  });

  it('returns null permission and callableBy for unrestricted permissionless tools', async () => {
    const target = tool({
      name: 'free-tool',
      description: 'No restrictions',
      params: {},
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'free-tool' }) as Record<string, unknown>;
    assert.equal(result.permission, null);
    assert.equal(result.callableBy, null);
  });

  it('handles tool with empty params', async () => {
    const target = tool({
      name: 'no-params',
      description: 'No parameters',
      params: {},
      handler: async () => ({}),
    });
    const kit = mockKit('stdlib', [target]);

    const api = startInstrumentarium([kit]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);

    const result = await toolsShow.definition.handler({ name: 'no-params' }) as Record<string, unknown>;
    assert.deepStrictEqual(result.params, {});
  });

  it('has read permission', () => {
    const api = startInstrumentarium([]);
    const toolsShow = api.find('tools-show');
    assert.ok(toolsShow);
    assert.equal(toolsShow.definition.permission, 'read');
  });
});
