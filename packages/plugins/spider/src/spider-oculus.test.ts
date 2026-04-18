/**
 * Spider Oculus features — unit tests.
 *
 * Tests for:
 * - BlockTypeRegistry.list() / SpiderApi.listBlockTypes()
 * - engine-designs tool
 * - block-types tool
 * - /api/spider/config route handler
 * - /api/spider/session-transcript route handler
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';
import type { FabricatorApi, EngineDesignInfo } from '@shardworks/fabricator-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SpiderApi, BlockTypeInfo, RigTemplateInfo } from './types.ts';

import engineDesignsTool from './tools/engine-designs.ts';
import blockTypesTool from './tools/block-types.ts';
import { spiderRoutes } from './oculus-routes.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeGuild(opts: {
  fabricatorDesigns?: EngineDesignInfo[];
  spiderBlockTypes?: BlockTypeInfo[];
  spiderTemplates?: RigTemplateInfo[];
  spiderTemplateMappings?: Record<string, string>;
  sessions?: Record<string, unknown>;
  transcripts?: Record<string, unknown>;
}): Guild {
  const designs = opts.fabricatorDesigns ?? [];
  const blockTypes = opts.spiderBlockTypes ?? [];
  const templates = opts.spiderTemplates ?? [];
  const templateMappings = opts.spiderTemplateMappings ?? {};
  const sessions = opts.sessions ?? {};
  const transcripts = opts.transcripts ?? {};

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
    cancel: async () => { throw new Error('not implemented'); },
    getBlockType: () => undefined,
    listBlockTypes: () => blockTypes,
    listTemplates: () => templates,
    listTemplateMappings: () => templateMappings,
  };

  const mockStacksBook = (data: Record<string, unknown>) => ({
    get: async (id: string) => data[id] ?? null,
    find: async () => [],
    put: async () => {},
    patch: async () => {},
    delete: async () => {},
  });

  const mockStacks: Partial<StacksApi> = {
    readBook: (appId: string, bookId: string) => {
      if (appId === 'animator' && bookId === 'sessions') {
        return mockStacksBook(sessions) as ReturnType<StacksApi['readBook']>;
      }
      if (appId === 'animator' && bookId === 'transcripts') {
        return mockStacksBook(transcripts) as ReturnType<StacksApi['readBook']>;
      }
      return mockStacksBook({}) as ReturnType<StacksApi['readBook']>;
    },
  } as Partial<StacksApi>;

  const fakeGuildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      if (name === 'fabricator') return mockFabricator as unknown as T;
      if (name === 'spider') return mockSpider as unknown as T;
      if (name === 'stacks') return mockStacks as unknown as T;
      throw new Error(`Apparatus "${name}" not found`);
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return fakeGuildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    startupWarnings() { return []; },
  };

  return fakeGuild;
}

/** Minimal Hono Context mock for route testing. */
function makeContext(): { ctx: unknown; lastJson: () => unknown; lastStatus: () => number } {
  let captured: unknown;
  let capturedStatus = 200;
  const ctx = {
    req: {
      query: (key: string) => {
        void key;
        return undefined as string | undefined;
      },
    },
    json(data: unknown, status?: number) {
      captured = data;
      capturedStatus = status ?? 200;
      return new Response(JSON.stringify(data), {
        status: capturedStatus,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return {
    ctx,
    lastJson: () => captured,
    lastStatus: () => capturedStatus,
  };
}

/** Minimal Hono Context mock with query parameter support. */
function makeContextWithQuery(params: Record<string, string | undefined>): { ctx: unknown; lastJson: () => unknown; lastStatus: () => number } {
  let captured: unknown;
  let capturedStatus = 200;
  const ctx = {
    req: {
      query: (key: string) => params[key],
    },
    json(data: unknown, status?: number) {
      captured = data;
      capturedStatus = status ?? 200;
      return new Response(JSON.stringify(data), {
        status: capturedStatus,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return {
    ctx,
    lastJson: () => captured,
    lastStatus: () => capturedStatus,
  };
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
      { id: 'writ-phase', pluginId: 'spider' },
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

describe('GET /api/spider/config route', () => {
  afterEach(() => clearGuild());

  it('spiderRoutes exports an array with two routes', () => {
    assert.ok(Array.isArray(spiderRoutes));
    assert.equal(spiderRoutes.length, 2);
  });

  it('first route has method GET and path /api/spider/config', () => {
    const route = spiderRoutes[0];
    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/api/spider/config');
    assert.equal(typeof route.handler, 'function');
  });

  it('returns templates, templateMappings, engineDesigns, blockTypes in response', async () => {
    const designs: EngineDesignInfo[] = [
      { id: 'draft', pluginId: 'spider', hasCollect: false },
    ];
    const types: BlockTypeInfo[] = [
      { id: 'writ-phase', pluginId: 'spider' },
    ];
    const templates: RigTemplateInfo[] = [
      {
        name: 'default',
        source: 'config',
        template: { engines: [{ id: 'draft', designId: 'draft', upstream: [] }] },
      },
    ];
    const templateMappings = { mandate: 'default' };
    const guild = makeGuild({
      fabricatorDesigns: designs,
      spiderBlockTypes: types,
      spiderTemplates: templates,
      spiderTemplateMappings: templateMappings,
    });
    setGuild(guild);

    const { ctx, lastJson } = makeContext();
    const route = spiderRoutes[0];
    await route.handler(ctx as Parameters<typeof route.handler>[0]);

    const result = lastJson() as Record<string, unknown>;
    assert.ok(result, 'response should have data');
    assert.deepEqual(result.templates, templates);
    assert.deepEqual(result.templateMappings, templateMappings);
    assert.deepEqual(result.engineDesigns, designs);
    assert.deepEqual(result.blockTypes, types);
    assert.equal(result.rigTemplates, undefined, 'old rigTemplates key must be absent');
  });

  it('returns empty arrays/objects when nothing is configured', async () => {
    const guild = makeGuild({});
    setGuild(guild);

    const { ctx, lastJson } = makeContext();
    const route = spiderRoutes[0];
    await route.handler(ctx as Parameters<typeof route.handler>[0]);

    const result = lastJson() as Record<string, unknown>;
    assert.deepEqual(result.templates, []);
    assert.deepEqual(result.templateMappings, {});
    assert.deepEqual(result.engineDesigns, []);
    assert.deepEqual(result.blockTypes, []);
    assert.equal(result.rigTemplates, undefined);
  });
});

// ── /api/spider/session-transcript route ──────────────────────────────

describe('GET /api/spider/session-transcript route', () => {
  afterEach(() => clearGuild());

  it('second route has method GET and path /api/spider/session-transcript', () => {
    const route = spiderRoutes[1];
    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/api/spider/session-transcript');
    assert.equal(typeof route.handler, 'function');
  });

  it('returns 400 when sessionId is missing', async () => {
    setGuild(makeGuild({}));
    const { ctx, lastJson, lastStatus } = makeContextWithQuery({});
    await spiderRoutes[1].handler(ctx as Parameters<typeof spiderRoutes[1]['handler']>[0]);
    assert.equal(lastStatus(), 400);
    const result = lastJson() as Record<string, unknown>;
    assert.ok(result.error, 'should have error message');
  });

  it('returns 404 when session is not found', async () => {
    setGuild(makeGuild({ sessions: {} }));
    const { ctx, lastJson, lastStatus } = makeContextWithQuery({ sessionId: 'nonexistent' });
    await spiderRoutes[1].handler(ctx as Parameters<typeof spiderRoutes[1]['handler']>[0]);
    assert.equal(lastStatus(), 404);
    const result = lastJson() as Record<string, unknown>;
    assert.ok(result.error, 'should have error message');
  });

  it('returns messages: [] and sessionStatus: running for a running session', async () => {
    setGuild(makeGuild({
      sessions: { 'ses-running': { id: 'ses-running', status: 'running' } },
    }));
    const { ctx, lastJson, lastStatus } = makeContextWithQuery({ sessionId: 'ses-running' });
    await spiderRoutes[1].handler(ctx as Parameters<typeof spiderRoutes[1]['handler']>[0]);
    assert.equal(lastStatus(), 200);
    const result = lastJson() as Record<string, unknown>;
    assert.deepEqual(result.messages, []);
    assert.equal(result.sessionStatus, 'running');
  });

  it('returns messages and sessionStatus for a completed session with transcript', async () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    ];
    setGuild(makeGuild({
      sessions: { 'ses-done': { id: 'ses-done', status: 'completed' } },
      transcripts: { 'ses-done': { id: 'ses-done', messages } },
    }));
    const { ctx, lastJson, lastStatus } = makeContextWithQuery({ sessionId: 'ses-done' });
    await spiderRoutes[1].handler(ctx as Parameters<typeof spiderRoutes[1]['handler']>[0]);
    assert.equal(lastStatus(), 200);
    const result = lastJson() as Record<string, unknown>;
    assert.deepEqual(result.messages, messages);
    assert.equal(result.sessionStatus, 'completed');
  });

  it('returns messages: [] for completed session without transcript', async () => {
    setGuild(makeGuild({
      sessions: { 'ses-notx': { id: 'ses-notx', status: 'completed' } },
      transcripts: {},
    }));
    const { ctx, lastJson, lastStatus } = makeContextWithQuery({ sessionId: 'ses-notx' });
    await spiderRoutes[1].handler(ctx as Parameters<typeof spiderRoutes[1]['handler']>[0]);
    assert.equal(lastStatus(), 200);
    const result = lastJson() as Record<string, unknown>;
    assert.deepEqual(result.messages, []);
    assert.equal(result.sessionStatus, 'completed');
  });
});
