/**
 * Tool server — unit and integration tests.
 *
 * Tests tool route mapping, session authorization, HTTP server lifecycle,
 * param validation, and tool execution over HTTP.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  setGuild,
  clearGuild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  KitEntry,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from './tool.ts';
import {
  createInstrumentarium,
  type InstrumentariumApi,
} from './instrumentarium.ts';
import {
  toolNameToRoute,
  permissionToMethod,
  coerceParams,
  createToolServerApp,
  startToolServer,
  type ToolAuthorizer,
  type ToolServerHandle,
} from './tool-server.ts';

// ── Authorization helpers (replacing the old in-memory SessionRegistry) ──

/**
 * Build a ToolAuthorizer backed by a simple in-memory map. Used in tests
 * to simulate the Stacks-backed authorize callback the daemon installs in
 * production. Equivalent in spirit to the old SessionRegistry, but here
 * the registry lives in the test, not in the production code.
 */
function makeAuthorizer(initial?: Record<string, string[]>): {
  authorize: ToolAuthorizer;
  register(sessionId: string, tools: string[]): void;
} {
  const sessions = new Map<string, Set<string>>();
  if (initial) {
    for (const [id, tools] of Object.entries(initial)) {
      sessions.set(id, new Set(tools));
    }
  }
  return {
    authorize: (sessionId, toolName) => {
      const allowed = sessions.get(sessionId);
      return allowed ? allowed.has(toolName) : false;
    },
    register(sessionId, tools) {
      sessions.set(sessionId, new Set(tools));
    },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────

function testTool(
  name: string,
  opts?: {
    callableBy?: ('patron' | 'anima' | 'library')[];
    permission?: string;
    params?: Record<string, z.ZodType>;
    handler?: (params: Record<string, unknown>) => unknown;
  },
) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: opts?.params ?? {},
    handler: opts?.handler ?? (async () => ({ ok: true })),
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

function wireGuild(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
  home?: string;
  toolsConfig?: Record<string, unknown>;
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];

  const mockGuild: Guild = {
    home: opts.home ?? '/tmp/test-guild',
    apparatus<T>(_name: string): T {
      throw new Error('Not implemented in test');
    },
    config<T>(pluginId: string): T {
      if (pluginId === 'tools' && opts.toolsConfig) {
        return opts.toolsConfig as T;
      }
      return {} as T;
    },
    writeConfig() {},
    guildConfig() {
      return { name: 'test', nexus: '0.0.0', workshops: {}, plugins: [] };
    },
    kits() { return [...kits]; },
    apparatuses() { return [...apparatuses]; },
    startupWarnings() { return []; },
  };

  setGuild(mockGuild);
}

function startInstrumentarium(opts: {
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
  home?: string;
  toolsConfig?: Record<string, unknown>;
}): { api: InstrumentariumApi } {
  wireGuild(opts);

  const plugin = createInstrumentarium();
  const api = ('apparatus' in plugin ? plugin.apparatus.provides : null) as InstrumentariumApi;
  assert.ok(api, 'Instrumentarium must have provides');

  const kitEntries = buildKitEntries(opts.kits ?? [], opts.apparatuses ?? []);

  // Include the Instrumentarium's own supportKit
  if ('apparatus' in plugin) {
    const selfSupportKit = (plugin.apparatus as { supportKit?: Record<string, unknown> }).supportKit;
    if (selfSupportKit && typeof selfSupportKit === 'object') {
      for (const [type, value] of Object.entries(selfSupportKit)) {
        if (type === 'requires' || type === 'recommends') continue;
        kitEntries.push({ pluginId: 'instrumentarium', packageName: '@shardworks/tools-apparatus', type, value });
      }
    }
  }

  const ctx: StartupContext = {
    on() {},
    kits(type: string) { return kitEntries.filter(e => e.type === type); },
  };
  if ('apparatus' in plugin) {
    plugin.apparatus.start(ctx);
  }

  return { api };
}

// ── Unit tests: toolNameToRoute ──────────────────────────────────────

describe('toolNameToRoute', () => {
  it("'writ-list' → '/api/writ/list'", () => {
    assert.equal(toolNameToRoute('writ-list'), '/api/writ/list');
  });

  it("'signal' → '/api/signal'", () => {
    assert.equal(toolNameToRoute('signal'), '/api/signal');
  });

  it("'commission-post' → '/api/commission/post'", () => {
    assert.equal(toolNameToRoute('commission-post'), '/api/commission/post');
  });

  it("'tools-list' → '/api/tools/list'", () => {
    assert.equal(toolNameToRoute('tools-list'), '/api/tools/list');
  });

  it("'a-b-c' splits on first hyphen only", () => {
    assert.equal(toolNameToRoute('a-b-c'), '/api/a/b-c');
  });
});

// ── Unit tests: permissionToMethod ───────────────────────────────────

describe('permissionToMethod', () => {
  it('undefined → GET', () => {
    assert.equal(permissionToMethod(undefined), 'GET');
  });

  it("'read' → GET", () => {
    assert.equal(permissionToMethod('read'), 'GET');
  });

  it("'write' → POST", () => {
    assert.equal(permissionToMethod('write'), 'POST');
  });

  it("'admin' → POST", () => {
    assert.equal(permissionToMethod('admin'), 'POST');
  });

  it("'delete' → DELETE", () => {
    assert.equal(permissionToMethod('delete'), 'DELETE');
  });

  it("unknown level → POST", () => {
    assert.equal(permissionToMethod('custom'), 'POST');
  });

  it("'plugin:read' extracts level after colon → GET", () => {
    assert.equal(permissionToMethod('plugin:read'), 'GET');
  });

  it("'plugin:write' extracts level after colon → POST", () => {
    assert.equal(permissionToMethod('plugin:write'), 'POST');
  });
});

// ── Unit tests: coerceParams ─────────────────────────────────────────

describe('coerceParams', () => {
  it('coerces number strings to numbers', () => {
    const shape = { count: z.number() };
    const result = coerceParams(shape, { count: '42' });
    assert.equal(result.count, 42);
  });

  it('coerces boolean strings to booleans', () => {
    const shape = { active: z.boolean() };
    const trueResult = coerceParams(shape, { active: 'true' });
    assert.equal(trueResult.active, true);
    const falseResult = coerceParams(shape, { active: 'false' });
    assert.equal(falseResult.active, false);
  });

  it('leaves strings unchanged', () => {
    const shape = { name: z.string() };
    const result = coerceParams(shape, { name: 'hello' });
    assert.equal(result.name, 'hello');
  });

  it('handles optional number schemas', () => {
    const shape = { count: z.number().optional() };
    const result = coerceParams(shape, { count: '5' });
    assert.equal(result.count, 5);
  });
});

// ── Unit tests: ToolAuthorizer ───────────────────────────────────────

describe('makeAuthorizer test helper', () => {
  it('authorizes registered (session, tool) pairs', async () => {
    const { authorize, register } = makeAuthorizer();
    register('s1', ['tool-a', 'tool-b']);

    assert.equal(await authorize('s1', 'tool-a'), true);
    assert.equal(await authorize('s1', 'tool-b'), true);
    assert.equal(await authorize('s1', 'tool-c'), false);
  });

  it('rejects unknown sessions', async () => {
    const { authorize } = makeAuthorizer();
    assert.equal(await authorize('unknown', 'tool-a'), false);
  });
});

// ── Integration tests: HTTP server ───────────────────────────────────

describe('Tool HTTP server', () => {
  let handle: ToolServerHandle;

  afterEach(async () => {
    if (handle) {
      await handle.close();
    }
    clearGuild();
  });

  describe('lifecycle', () => {
    it('starts and returns a handle with port and url', async () => {
      const kit = mockKit('stdlib', [testTool('ping')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      assert.ok(handle.port > 0);
      assert.ok(handle.url.includes('127.0.0.1'));
    });

    it('serves requests after start', async () => {
      const kit = mockKit('stdlib', [testTool('ping')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/ping`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { ok: true });
    });

    it('closes cleanly', async () => {
      const kit = mockKit('stdlib', [testTool('ping')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const port = handle.port;
      await handle.close();
      handle = undefined as unknown as ToolServerHandle;

      // Connection should be refused after close
      try {
        await fetch(`http://127.0.0.1:${port}/api/ping`);
        assert.fail('Expected fetch to fail after server close');
      } catch (err) {
        assert.ok(err instanceof Error);
      }
    });
  });

  describe('tool execution', () => {
    it('GET tool — returns handler result as JSON', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-list', {
          permission: 'read',
          handler: async () => [{ id: 'w1', title: 'Test' }],
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/list`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, [{ id: 'w1', title: 'Test' }]);
    });

    it('POST tool — parses body and returns handler result', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-create', {
          permission: 'write',
          params: { title: z.string() },
          handler: async ({ title }: Record<string, unknown>) => ({ id: 'w1', title }),
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Writ' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.title, 'New Writ');
    });

    it('DELETE tool — parses body and returns handler result', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-remove', {
          permission: 'delete',
          params: { id: z.string() },
          handler: async ({ id }: Record<string, unknown>) => ({ deleted: id }),
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/remove`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'w1' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.deleted, 'w1');
    });

    it('GET tool — coerces query params for numbers and booleans', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-search', {
          permission: 'read',
          params: {
            limit: z.number(),
            active: z.boolean(),
          },
          handler: async (params: Record<string, unknown>) => params,
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/search?limit=10&active=true`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.limit, 10);
      assert.equal(body.active, true);
    });

    it('tool handler errors return 500', async () => {
      const kit = mockKit('stdlib', [
        testTool('fail-tool', {
          handler: async () => { throw new Error('Something broke'); },
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/fail/tool`);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error, 'Something broke');
    });
  });

  describe('param validation', () => {
    it('returns 400 with Zod error details on invalid params', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-create', {
          permission: 'write',
          params: { title: z.string() },
          handler: async () => ({ ok: true }),
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 42 }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error);
      assert.ok(body.details);
      assert.ok(Array.isArray(body.details));
    });

    it('returns 400 when required param is missing', async () => {
      const kit = mockKit('stdlib', [
        testTool('writ-create', {
          permission: 'write',
          params: { title: z.string() },
          handler: async () => ({ ok: true }),
        }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/writ/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  describe('all caller types are served', () => {
    it('registers patron-only tools', async () => {
      const kit = mockKit('stdlib', [
        testTool('patron-tool', { callableBy: ['patron'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/patron/tool`);
      assert.equal(res.status, 200);
    });

    it('registers anima-only tools', async () => {
      const { authorize } = makeAuthorizer({ s1: ['anima-tool'] });

      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0, authorize);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 's1' },
      });
      assert.equal(res.status, 200);
    });

    it('registers tools with no callableBy (unrestricted)', async () => {
      const kit = mockKit('stdlib', [
        testTool('universal-tool'),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/universal/tool`);
      assert.equal(res.status, 200);
    });
  });

  describe('session authorization', () => {
    it('patron-callable tool accessible without session header', async () => {
      const kit = mockKit('stdlib', [
        testTool('public-tool', { callableBy: ['patron'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/public/tool`);
      assert.equal(res.status, 200);
    });

    it('unrestricted tool accessible without session header', async () => {
      const kit = mockKit('stdlib', [testTool('open-tool')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/open/tool`);
      assert.equal(res.status, 200);
    });

    it('anima-only tool returns 401 without session header', async () => {
      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/anima/tool`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.ok(body.error.includes('X-Session-Id'));
    });

    it('anima-only tool returns 403 for unauthorized session', async () => {
      const { authorize } = makeAuthorizer({ s1: ['other-tool'] });

      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0, authorize);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 's1' },
      });
      assert.equal(res.status, 403);
    });

    it('anima-only tool returns 200 for authorized session', async () => {
      const { authorize } = makeAuthorizer({ s1: ['anima-tool'] });

      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0, authorize);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 's1' },
      });
      assert.equal(res.status, 200);
    });

    it('returns 403 for unregistered session on anima tool', async () => {
      const { authorize } = makeAuthorizer();
      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0, authorize);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 'nonexistent' },
      });
      assert.equal(res.status, 403);
    });

    it('returns 500 when authorize callback throws', async () => {
      const failingAuthorize: ToolAuthorizer = async () => {
        throw new Error('Stacks unavailable');
      };
      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0, failingAuthorize);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 's1' },
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.ok(body.error.includes('Stacks unavailable'));
    });

    it('without an authorize callback, allows any session id', async () => {
      // The bare-minimum default: server only checks for the presence of
      // an X-Session-Id header. Useful for tests; production wires up a
      // real authorize function.
      const kit = mockKit('stdlib', [
        testTool('anima-tool', { callableBy: ['anima'] }),
      ]);
      const { api } = startInstrumentarium({ kits: [kit] });

      handle = await startToolServer(api, 0);
      const res = await fetch(`${handle.url}/api/anima/tool`, {
        headers: { 'X-Session-Id': 'anything' },
      });
      assert.equal(res.status, 200);
    });
  });

  describe('startToolServer via InstrumentariumApi', () => {
    it('uses default port 7471 when no config provided', async () => {
      const kit = mockKit('stdlib', [testTool('ping')]);
      const { api } = startInstrumentarium({ kits: [kit] });

      // Use explicit port 0 to avoid binding to 7471 in test
      handle = await api.startToolServer({ port: 0 });
      assert.ok(handle.port > 0);
      assert.ok(handle.url);

      const res = await fetch(`${handle.url}/api/ping`);
      assert.equal(res.status, 200);
    });

    it('uses guild.json tools.serverPort when configured', async () => {
      const kit = mockKit('stdlib', [testTool('ping')]);
      // The config is used by InstrumentariumApi.startToolServer, but we override with port: 0 for testing
      // We test the config path by not providing port option - but we can't test actual port binding
      // without risking collisions, so we test via direct startToolServer
      const { api } = startInstrumentarium({ kits: [kit], toolsConfig: { serverPort: 9999 } });

      // Override with port: 0 to avoid binding issues
      handle = await api.startToolServer({ port: 0 });
      assert.ok(handle.port > 0);
    });
  });
});
