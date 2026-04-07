/**
 * Spider Oculus features — unit tests.
 *
 * Tests for:
 * - BlockTypeRegistry.list() / SpiderApi.listBlockTypes()
 * - engine-designs tool
 * - block-types tool
 * - /api/spider/config route handler
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import type { FabricatorApi, EngineDesignInfo } from '@shardworks/fabricator-apparatus';
import type { SpiderApi, BlockTypeInfo, SpiderConfig } from './types.ts';

import engineDesignsTool from './tools/engine-designs.ts';
import blockTypesTool from './tools/block-types.ts';
import { spiderRoutes } from './oculus-routes.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeGuild(opts: {
  fabricatorDesigns?: EngineDesignInfo[];
  spiderBlockTypes?: BlockTypeInfo[];
  spiderConfig?: Partial<SpiderConfig>;
  apparatuses?: LoadedApparatus[];
}): Guild {
  const designs = opts.fabricatorDesigns ?? [];
  const blockTypes = opts.spiderBlockTypes ?? [];
  const spiderConfig = opts.spiderConfig ?? {};

  const mockFabricator: FabricatorApi = {
    getEngineDesign: () => undefined,
    listEngineDesigns: () => designs,
  };

  const mockSpider: SpiderApi = {
    crawl: async () => null,
    show: async () => { throw new Error('not implemented'); },
    list: async () => [],
    forWrit: async () => null,
    resume: async () => {},
    getBlockType: () => undefined,
    listBlockTypes: () => blockTypes,
  };

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
    spider: spiderConfig as SpiderConfig,
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      if (name === 'fabricator') return mockFabricator as unknown as T;
      if (name === 'spider') return mockSpider as unknown as T;
      throw new Error(`Apparatus "${name}" not found`);
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return opts.apparatuses ?? []; },
    startupWarnings() { return []; },
  };

  return fakeGuild;
}

// ── engine-designs tool ────────────────────────────────────────────────

describe('engine-designs tool', () => {
  afterEach(() => clearGuild());

  it('has name "engine-designs"', () => {
    assert.equal(engineDesignsTool.name, 'engine-designs');
  });

  it('has permission "read"', () => {
    assert.equal(engineDesignsTool.permission, 'read');
  });

  it('delegates to fabricator.listEngineDesigns()', async () => {
    const designs: EngineDesignInfo[] = [
      { id: 'draft', pluginId: 'spider', hasCollect: false },
      { id: 'implement', pluginId: 'spider', hasCollect: true },
    ];
    setGuild(makeGuild({ fabricatorDesigns: designs }));
    const result = await engineDesignsTool.handler({});
    assert.deepEqual(result, designs);
  });

  it('returns empty array when no designs are registered', async () => {
    setGuild(makeGuild({}));
    const result = await engineDesignsTool.handler({});
    assert.deepEqual(result, []);
  });
});

// ── block-types tool ───────────────────────────────────────────────────

describe('block-types tool', () => {
  afterEach(() => clearGuild());

  it('has name "block-types"', () => {
    assert.equal(blockTypesTool.name, 'block-types');
  });

  it('has permission "read"', () => {
    assert.equal(blockTypesTool.permission, 'read');
  });

  it('delegates to spider.listBlockTypes()', async () => {
    const types: BlockTypeInfo[] = [
      { id: 'writ-status', pluginId: 'spider' },
      { id: 'scheduled-time', pluginId: 'spider', pollIntervalMs: 60000 },
    ];
    setGuild(makeGuild({ spiderBlockTypes: types }));
    const result = await blockTypesTool.handler({});
    assert.deepEqual(result, types);
  });

  it('returns empty array when no block types are registered', async () => {
    setGuild(makeGuild({}));
    const result = await blockTypesTool.handler({});
    assert.deepEqual(result, []);
  });
});

// ── /api/spider/config route ───────────────────────────────────────────

/** Minimal Hono Context mock for route testing. */
function makeContext(opts: { guild: Guild }): { ctx: unknown; lastJson: () => unknown } {
  let captured: unknown;
  const ctx = {
    json(data: unknown) {
      captured = data;
      return new Response(JSON.stringify(data), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return {
    ctx,
    lastJson: () => captured,
  };
}

describe('GET /api/spider/config route', () => {
  afterEach(() => clearGuild());

  it('spiderRoutes exports an array with one route', () => {
    assert.ok(Array.isArray(spiderRoutes));
    assert.equal(spiderRoutes.length, 1);
  });

  it('route has method GET and path /api/spider/config', () => {
    const route = spiderRoutes[0];
    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/api/spider/config');
    assert.equal(typeof route.handler, 'function');
  });

  it('returns rigTemplates, engineDesigns, blockTypes in response', async () => {
    const designs: EngineDesignInfo[] = [
      { id: 'draft', pluginId: 'spider', hasCollect: false },
    ];
    const types: BlockTypeInfo[] = [
      { id: 'writ-status', pluginId: 'spider' },
    ];
    const rigTemplates = {
      default: {
        engines: [{ id: 'draft', designId: 'draft', upstream: [] }],
      },
    };
    const guild = makeGuild({
      fabricatorDesigns: designs,
      spiderBlockTypes: types,
      spiderConfig: { rigTemplates },
    });
    setGuild(guild);

    const { ctx, lastJson } = makeContext({ guild });
    const route = spiderRoutes[0];
    await route.handler(ctx as Parameters<typeof route.handler>[0]);

    const result = lastJson() as Record<string, unknown>;
    assert.ok(result, 'response should have data');
    assert.deepEqual(result.rigTemplates, rigTemplates);
    assert.deepEqual(result.engineDesigns, designs);
    assert.deepEqual(result.blockTypes, types);
  });

  it('returns empty objects/arrays when nothing is configured', async () => {
    const guild = makeGuild({});
    setGuild(guild);

    const { ctx, lastJson } = makeContext({ guild });
    const route = spiderRoutes[0];
    await route.handler(ctx as Parameters<typeof route.handler>[0]);

    const result = lastJson() as Record<string, unknown>;
    assert.deepEqual(result.rigTemplates, {});
    assert.deepEqual(result.engineDesigns, []);
    assert.deepEqual(result.blockTypes, []);
  });
});
