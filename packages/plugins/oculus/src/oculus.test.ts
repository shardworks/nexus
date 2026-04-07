/**
 * Oculus apparatus — unit tests.
 *
 * Tests server lifecycle, page serving, chrome injection, tool route mapping,
 * custom routes, and the API tool index.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  setGuild,
  clearGuild,
  guild,
} from '@shardworks/nexus-core';
import type {
  Guild,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from '@shardworks/tools-apparatus';
import type { InstrumentariumApi, ResolvedTool } from '@shardworks/tools-apparatus';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

import { createOculus, toolNameToRoute, permissionToMethod, coerceParams, injectChrome } from './oculus.ts';
import type { PageContribution, RouteContribution } from './types.ts';

// ── Test helpers ──────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oculus-test-'));
  return tmpDir;
}

function cleanupTmpDir(): void {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    tmpDir = '';
  }
}

function makePageDir(parentDir: string, name: string, html: string): string {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

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

function mockKit(id: string, tools: unknown[], pages?: PageContribution[], routes?: RouteContribution[]): LoadedKit {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    kit: { tools, ...(pages ? { pages } : {}), ...(routes ? { routes } : {}) },
  };
}

/** Build a mock InstrumentariumApi from a flat list of ToolDefinitions. */
function createMockInstrumentarium(tools: ToolDefinition[]): InstrumentariumApi {
  const resolved: ResolvedTool[] = tools.map((def) => ({ definition: def, pluginId: 'test' }));
  return {
    list: () => resolved,
    find: (name: string) => resolved.find((t) => t.definition.name === name) ?? null,
    resolve: () => resolved,
  };
}

function wireGuild(opts: {
  home: string;
  kits?: LoadedKit[];
  apparatuses?: LoadedApparatus[];
  instrumentarium: InstrumentariumApi;
  guildName?: string;
  oculusPort?: number;
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];
  const oculusPort = opts.oculusPort;

  const mockGuild: Guild = {
    home: opts.home,
    apparatus<T>(name: string): T {
      if (name === 'tools') return opts.instrumentarium as T;
      throw new Error(`apparatus not found: ${name}`);
    },
    config<T>(_pluginId: string): T {
      return {} as T;
    },
    writeConfig() {},
    guildConfig() {
      return {
        name: opts.guildName ?? 'test-guild',
        nexus: '0.0.0',
        plugins: [],
        ...(oculusPort !== undefined ? { oculus: { port: oculusPort } } : {}),
      };
    },
    kits() { return [...kits]; },
    apparatuses() { return [...apparatuses]; },
    failedPlugins() { return []; },
  };
  setGuild(mockGuild);
}

// ── Unit tests: toolNameToRoute ───────────────────────────────────────

describe('toolNameToRoute', () => {
  it("'writ-list' → '/api/writ/list'", () => {
    assert.equal(toolNameToRoute('writ-list'), '/api/writ/list');
  });

  it("'commission-post' → '/api/commission/post'", () => {
    assert.equal(toolNameToRoute('commission-post'), '/api/commission/post');
  });

  it("'rig-for-writ' → '/api/rig/for-writ'", () => {
    assert.equal(toolNameToRoute('rig-for-writ'), '/api/rig/for-writ');
  });

  it("'signal' → '/api/signal'", () => {
    assert.equal(toolNameToRoute('signal'), '/api/signal');
  });

  it("'tools-list' → '/api/tools/list'", () => {
    assert.equal(toolNameToRoute('tools-list'), '/api/tools/list');
  });
});

// ── Unit tests: permissionToMethod ───────────────────────────────────

describe('permissionToMethod', () => {
  it("undefined → 'GET'", () => {
    assert.equal(permissionToMethod(undefined), 'GET');
  });

  it("'read' → 'GET'", () => {
    assert.equal(permissionToMethod('read'), 'GET');
  });

  it("'write' → 'POST'", () => {
    assert.equal(permissionToMethod('write'), 'POST');
  });

  it("'admin' → 'POST'", () => {
    assert.equal(permissionToMethod('admin'), 'POST');
  });

  it("'delete' → 'DELETE'", () => {
    assert.equal(permissionToMethod('delete'), 'DELETE');
  });

  it("'clerk:read' → 'GET'", () => {
    assert.equal(permissionToMethod('clerk:read'), 'GET');
  });

  it("'clerk:write' → 'POST'", () => {
    assert.equal(permissionToMethod('clerk:write'), 'POST');
  });

  it("'spider:write' → 'POST'", () => {
    assert.equal(permissionToMethod('spider:write'), 'POST');
  });

  it("'animate' → 'POST' (unknown level)", () => {
    assert.equal(permissionToMethod('animate'), 'POST');
  });
});

// ── Unit tests: coerceParams ──────────────────────────────────────────

describe('coerceParams', () => {
  it('coerces number strings to numbers', () => {
    const shape = { limit: z.number() };
    const result = coerceParams(shape, { limit: '5' });
    assert.equal(result.limit, 5);
    assert.equal(typeof result.limit, 'number');
  });

  it("coerces 'true' to boolean true", () => {
    const shape = { verbose: z.boolean() };
    const result = coerceParams(shape, { verbose: 'true' });
    assert.equal(result.verbose, true);
    assert.equal(typeof result.verbose, 'boolean');
  });

  it("coerces 'false' to boolean false", () => {
    const shape = { verbose: z.boolean() };
    const result = coerceParams(shape, { verbose: 'false' });
    assert.equal(result.verbose, false);
  });

  it('leaves string values untouched', () => {
    const shape = { name: z.string() };
    const result = coerceParams(shape, { name: 'hello' });
    assert.equal(result.name, 'hello');
  });

  it('unwraps optional number schema', () => {
    const shape = { limit: z.number().optional() };
    const result = coerceParams(shape, { limit: '5' });
    assert.equal(result.limit, 5);
  });

  it('unwraps optional boolean schema', () => {
    const shape = { flag: z.boolean().optional() };
    const result = coerceParams(shape, { flag: 'true' });
    assert.equal(result.flag, true);
  });
});

// ── Unit tests: injectChrome ──────────────────────────────────────────

describe('injectChrome', () => {
  it('injects stylesheet link before </head> and nav after <body>', () => {
    const html = '<html><head><title>Test</title></head><body><p>Hi</p></body></html>';
    const result = injectChrome(html, '/static/style.css', '<nav>NAV</nav>');
    assert.ok(result.includes('<link rel="stylesheet" href="/static/style.css">'));
    assert.ok(result.includes('<nav>NAV</nav>'));
    // stylesheet should come before </head>
    const stylesheetIdx = result.indexOf('<link rel="stylesheet"');
    const headCloseIdx = result.indexOf('</head>');
    assert.ok(stylesheetIdx < headCloseIdx);
    // nav should come after <body>
    const navIdx = result.indexOf('<nav>NAV</nav>');
    const bodyIdx = result.indexOf('<body>');
    assert.ok(navIdx > bodyIdx);
  });

  it('works case-insensitively and handles body attributes', () => {
    const html = '<html><HEAD><TITLE>Test</TITLE></HEAD><BODY class="main"><p>Hi</p></BODY></html>';
    const result = injectChrome(html, '/static/style.css', '<nav>NAV</nav>');
    assert.ok(result.includes('<link rel="stylesheet"'));
    assert.ok(result.includes('<nav>NAV</nav>'));
    // nav should appear after the <BODY class="main"> tag
    const navIdx = result.indexOf('<nav>NAV</nav>');
    const bodyCloseIdx = result.indexOf('<BODY class="main">') + '<BODY class="main">'.length;
    assert.ok(navIdx >= bodyCloseIdx);
  });

  it('returns unmodified when neither <head> nor <body> present', () => {
    const html = '<p>No head or body tags</p>';
    const result = injectChrome(html, '/static/style.css', '<nav>NAV</nav>');
    assert.equal(result, html);
  });

  it('injects both when head and body are empty', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectChrome(html, '/static/style.css', '<nav>NAV</nav>');
    assert.ok(result.includes('<link rel="stylesheet"'));
    assert.ok(result.includes('<nav>NAV</nav>'));
  });
});

// ── Integration tests: server lifecycle ──────────────────────────────

describe('Oculus server lifecycle', () => {
  afterEach(() => {
    clearGuild();
    cleanupTmpDir();
  });

  it('starts and stops cleanly', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 17470 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    assert.ok('apparatus' in plugin);

    const { ctx } = buildTestContext();

    if ('apparatus' in plugin) {
      await plugin.apparatus.start(ctx);
    }

    try {
      // Server should be listening
      const res = await fetch(`http://localhost:${port}/`);
      assert.ok(res.status > 0);

      // api.port() should return the port
      const api = plugin.apparatus.provides as { port(): number };
      assert.equal(api.port(), port);
    } finally {
      if ('apparatus' in plugin) {
        await plugin.apparatus.stop?.();
      }
    }
  });
});

// ── Integration tests: page serving ──────────────────────────────────

describe('Oculus page serving', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;
  let guildHome: string;

  before(async () => {
    guildHome = makeTmpDir();
    port = 17570 + Math.floor(Math.random() * 100);

    // Create the fake node_modules structure
    const nmPageDir = path.join(guildHome, 'node_modules', '@test', 'my-kit', 'pages', 'my-page');
    fs.mkdirSync(nmPageDir, { recursive: true });
    fs.writeFileSync(
      path.join(nmPageDir, 'index.html'),
      '<html><head><title>My Page</title></head><body><p>Content</p></body></html>',
    );
    fs.writeFileSync(path.join(nmPageDir, 'app.js'), 'console.log("hello");');

    const pages: PageContribution[] = [
      { id: 'my-page', title: 'My Page', dir: 'pages/my-page' },
    ];

    const kits: LoadedKit[] = [mockKit('my-kit', [], pages)];
    const instrumentarium = createMockInstrumentarium([]);
    wireGuild({ home: guildHome, kits, instrumentarium, oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('serves index.html with chrome injection', async () => {
    const res = await fetch(`http://localhost:${port}/pages/my-page/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<link rel="stylesheet" href="/static/style.css">'));
    assert.ok(text.includes('<nav id="oculus-nav">'));
    assert.ok(text.includes('<a href="/">Guild</a>'));
    assert.ok(text.includes('/pages/my-page/'));
  });

  it('serves index.html at explicit /index.html path with injection', async () => {
    const res = await fetch(`http://localhost:${port}/pages/my-page/index.html`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<link rel="stylesheet" href="/static/style.css">'));
    assert.ok(text.includes('<nav id="oculus-nav">'));
  });

  it('serves non-index files without injection', async () => {
    const res = await fetch(`http://localhost:${port}/pages/my-page/app.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes('<link rel="stylesheet"'));
    assert.ok(!text.includes('<nav id="oculus-nav">'));
  });

  it('returns 404 for nonexistent page', async () => {
    const res = await fetch(`http://localhost:${port}/pages/nonexistent/`);
    assert.equal(res.status, 404);
  });

  it('rejects directory traversal attempts', async () => {
    const res = await fetch(`http://localhost:${port}/pages/my-page/../../../etc/passwd`);
    assert.ok(res.status === 404 || res.status === 400);
  });
});

// ── Integration tests: static assets ─────────────────────────────────

describe('Oculus static assets', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17680 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);
    wireGuild({ home, instrumentarium, oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('serves /static/style.css', async () => {
    const res = await fetch(`http://localhost:${port}/static/style.css`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('--bg: #1a1b26'));
    assert.ok(text.includes('.card'));
    assert.ok(text.includes('.badge'));
    assert.ok(text.includes('.badge--success'));
    assert.ok(text.includes('#oculus-nav'));
    assert.ok(text.includes('monospace'));
  });
});

// ── Integration tests: home page ──────────────────────────────────────

describe('Oculus home page', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17790 + Math.floor(Math.random() * 100);

    const pages: PageContribution[] = [
      { id: 'dash', title: 'Dashboard', dir: 'pages/dash' },
    ];
    const kits: LoadedKit[] = [mockKit('my-kit', [], pages)];
    const instrumentarium = createMockInstrumentarium([]);

    // Create minimal node_modules structure for the page
    const nmDir = path.join(home, 'node_modules', '@test', 'my-kit', 'pages', 'dash');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.html'), '<html><head></head><body>Dash</body></html>');

    wireGuild({ home, kits, instrumentarium, guildName: 'my-guild', oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('returns HTML with guild name and page links', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('my-guild'));
    assert.ok(text.includes('/pages/dash/'));
    assert.ok(text.includes('/static/style.css'));
    assert.ok(text.includes('<nav id="oculus-nav">'));
  });
});

// ── Integration tests: tool routes ────────────────────────────────────

describe('Oculus tool routes', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17890 + Math.floor(Math.random() * 100);

    const tools = [
      tool({
        name: 'writ-list',
        description: 'List writs',
        permission: 'read',
        params: { limit: z.number().optional(), offset: z.number().optional() },
        handler: async (p) => ({ items: [], limit: p.limit, offset: p.offset }),
      }),
      tool({
        name: 'commission-post',
        description: 'Post commission',
        permission: 'clerk:write',
        params: { title: z.string() },
        handler: async (p) => ({ created: true, title: p.title }),
      }),
      tool({
        name: 'codex-remove',
        description: 'Remove codex',
        permission: 'delete',
        params: { id: z.string() },
        handler: async (p) => ({ deleted: p.id }),
      }),
      tool({
        name: 'signal',
        description: 'Send signal',
        params: { message: z.string().optional() },
        handler: async () => ({ ok: true }),
      }),
      tool({
        name: 'anima-only-tool',
        description: 'Anima only',
        callableBy: ['anima'],
        params: {},
        handler: async () => ({}),
      }),
    ];

    const instrumentarium = createMockInstrumentarium(tools);
    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('GET /api/writ/list is registered (read → GET)', async () => {
    const res = await fetch(`http://localhost:${port}/api/writ/list`);
    assert.equal(res.status, 200);
  });

  it('POST /api/commission/post is registered (clerk:write → POST)', async () => {
    const res = await fetch(`http://localhost:${port}/api/commission/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    assert.equal(res.status, 200);
  });

  it('DELETE /api/codex/remove is registered (delete → DELETE)', async () => {
    const res = await fetch(`http://localhost:${port}/api/codex/remove`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '123' }),
    });
    assert.equal(res.status, 200);
  });

  it('GET /api/signal is registered (no permission → GET)', async () => {
    const res = await fetch(`http://localhost:${port}/api/signal`);
    assert.equal(res.status, 200);
  });

  it('anima-only tool has no route', async () => {
    // anima-only-tool → /api/anima/only-tool — not registered
    const res = await fetch(`http://localhost:${port}/api/anima/only-tool`);
    assert.ok(res.status === 404 || res.status === 405);
  });

  it('query params are coerced to numbers', async () => {
    const res = await fetch(`http://localhost:${port}/api/writ/list?limit=5&offset=0`);
    assert.equal(res.status, 200);
    const data = await res.json() as { limit: number; offset: number };
    assert.equal(data.limit, 5);
    assert.equal(data.offset, 0);
    assert.equal(typeof data.limit, 'number');
  });

  it('returns 400 on Zod validation failure', async () => {
    const res = await fetch(`http://localhost:${port}/api/commission/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong_field: 'x' }), // missing required 'title'
    });
    assert.equal(res.status, 400);
    const data = await res.json() as { error: string; details: unknown };
    assert.ok(typeof data.error === 'string');
    assert.ok('details' in data);
  });

  it('returns 200 on successful optional-params GET', async () => {
    const res = await fetch(`http://localhost:${port}/api/writ/list`);
    assert.equal(res.status, 200);
  });
});

// ── Integration tests: /api/_tools ───────────────────────────────────

describe('Oculus /api/_tools', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17990 + Math.floor(Math.random() * 100);

    const tools = [
      tool({
        name: 'writ-list',
        description: 'List writs',
        permission: 'read',
        params: {
          limit: z.number().optional().describe('Max results'),
          status: z.enum(['open', 'closed']).optional(),
        },
        handler: async () => ({ items: [] }),
      }),
    ];

    const instrumentarium = createMockInstrumentarium(tools);
    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('returns JSON array of tool entries', async () => {
    const res = await fetch(`http://localhost:${port}/api/_tools`);
    assert.equal(res.status, 200);
    const data = await res.json() as unknown[];
    assert.ok(Array.isArray(data));
  });

  it('each entry has name, route, method, description, params', async () => {
    const res = await fetch(`http://localhost:${port}/api/_tools`);
    const data = await res.json() as Array<Record<string, unknown>>;
    // Find writ-list entry
    const entry = data.find((e) => e.name === 'writ-list');
    assert.ok(entry, 'writ-list should be in _tools');
    assert.equal(entry.route, '/api/writ/list');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.description, 'List writs');
    assert.ok(typeof entry.params === 'object' && entry.params !== null);
    const params = entry.params as Record<string, { type: string; description: string | null; optional: boolean }>;
    assert.ok('limit' in params);
    assert.equal(params.limit.type, 'number');
    assert.equal(params.limit.optional, true);
  });
});

// ── Integration tests: custom routes ─────────────────────────────────

describe('Oculus custom routes', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 18090 + Math.floor(Math.random() * 100);

    const routes: RouteContribution[] = [
      {
        method: 'GET',
        path: '/api/custom/stream',
        handler: (c: import('hono').Context) => c.json({ custom: true }),
      },
    ];

    const kits: LoadedKit[] = [mockKit('my-kit', [], undefined, routes)];
    const instrumentarium = createMockInstrumentarium([]);
    wireGuild({ home, kits, instrumentarium, oculusPort: port });

    oculusPlugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('custom route at /api/custom/stream is accessible', async () => {
    const res = await fetch(`http://localhost:${port}/api/custom/stream`);
    assert.equal(res.status, 200);
    const data = await res.json() as { custom: boolean };
    assert.equal(data.custom, true);
  });
});

describe('Oculus invalid custom routes', () => {
  it('rejects custom route not starting with /api/', async () => {
    const home = makeTmpDir();
    const port = 18190 + Math.floor(Math.random() * 100);

    const routes: RouteContribution[] = [
      {
        method: 'GET',
        path: '/not-api/foo',
        handler: (c: import('hono').Context) => c.json({ bad: true }),
      },
    ];

    const kits: LoadedKit[] = [mockKit('my-kit', [], undefined, routes)];
    const instrumentarium = createMockInstrumentarium([]);
    wireGuild({ home, kits, instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext();
    if ('apparatus' in plugin) {
      await plugin.apparatus.start(ctx);
    }

    try {
      // /not-api/foo should NOT be accessible (not registered)
      const res = await fetch(`http://localhost:${port}/not-api/foo`);
      assert.ok(res.status === 404, `Expected 404, got ${res.status}`);
    } finally {
      if ('apparatus' in plugin) {
        await plugin.apparatus.stop?.();
      }
      clearGuild();
      cleanupTmpDir();
    }
  });
});
