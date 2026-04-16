/**
 * Oculus apparatus — unit tests.
 *
 * Tests server lifecycle, page serving, chrome injection, tool route mapping,
 * custom routes, and the API tool index.
 */

import fs from 'node:fs';
import net from 'node:net';
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
  KitEntry,
  LoadedKit,
  LoadedApparatus,
  StartupContext,
} from '@shardworks/nexus-core';

import { tool } from '@shardworks/tools-apparatus';
import type { InstrumentariumApi, ResolvedTool } from '@shardworks/tools-apparatus';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

import { createOculus, toolNameToRoute, permissionToMethod, coerceParams, injectChrome, isArrayAcceptingSchema, parseQueryParams } from './oculus.ts';
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

function buildTestContext(kitEntries: KitEntry[] = []): {
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
    kits(type: string): KitEntry[] { return [...kitEntries.filter(e => e.type === type)]; },
  };

  async function fire(event: string, ...args: unknown[]): Promise<void> {
    for (const h of handlers.get(event) ?? []) {
      await h(...args);
    }
  }

  return { ctx, fire };
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
  failedPlugins?: import('@shardworks/nexus-core').FailedPlugin[];
  instrumentarium: InstrumentariumApi;
  guildName?: string;
  oculusPort?: number;
  model?: string;
  startupWarnings?: string[];
}): void {
  const kits = opts.kits ?? [];
  const apparatuses = opts.apparatuses ?? [];
  const failedPlugins = opts.failedPlugins ?? [];
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
        ...(opts.model !== undefined ? { settings: { model: opts.model } } : {}),
        ...(oculusPort !== undefined ? { oculus: { port: oculusPort } } : {}),
      };
    },
    kits() { return [...kits]; },
    apparatuses() { return [...apparatuses]; },
    failedPlugins() { return [...failedPlugins]; },
    startupWarnings() { return [...(opts.startupWarnings ?? [])]; },
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

// ── Unit tests: isArrayAcceptingSchema ───────────────────────────────

describe('isArrayAcceptingSchema', () => {
  it('returns true for z.array()', () => {
    assert.ok(isArrayAcceptingSchema(z.array(z.string())));
  });

  it('returns true for z.union containing an array', () => {
    const schema = z.union([z.string(), z.array(z.string()).min(1)]);
    assert.ok(isArrayAcceptingSchema(schema));
  });

  it('returns true for optional union containing an array', () => {
    const schema = z.union([z.string(), z.array(z.string()).min(1)]).optional();
    assert.ok(isArrayAcceptingSchema(schema));
  });

  it('returns false for plain string schema', () => {
    assert.ok(!isArrayAcceptingSchema(z.string()));
  });

  it('returns false for optional string schema', () => {
    assert.ok(!isArrayAcceptingSchema(z.string().optional()));
  });

  it('returns false for number schema', () => {
    assert.ok(!isArrayAcceptingSchema(z.number()));
  });

  it('returns false for union without array', () => {
    const schema = z.union([z.string(), z.number()]);
    assert.ok(!isArrayAcceptingSchema(schema));
  });
});

// ── Unit tests: parseQueryParams ─────────────────────────────────────

describe('parseQueryParams', () => {
  it('repeated params with array schema → parsed as array', () => {
    const shape = {
      type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    };
    const result = parseQueryParams('http://localhost/api/writ/list?type=mandate&type=brief', shape);
    assert.deepEqual(result.type, ['mandate', 'brief']);
  });

  it('single param with array schema → parsed as string', () => {
    const shape = {
      type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    };
    const result = parseQueryParams('http://localhost/api/writ/list?type=mandate', shape);
    assert.equal(result.type, 'mandate');
  });

  it('repeated params without array schema → last value wins', () => {
    const shape = {
      parentId: z.string().optional(),
    };
    const result = parseQueryParams('http://localhost/api/writ/list?parentId=a&parentId=b', shape);
    assert.equal(result.parentId, 'b');
  });

  it('number coercion still works after parseQueryParams', () => {
    const shape = {
      limit: z.number().optional().default(20),
    };
    const parsed = parseQueryParams('http://localhost/api/writ/list?limit=20', shape);
    const coerced = coerceParams(shape, parsed as Record<string, string>);
    assert.equal(coerced.limit, 20);
    assert.equal(typeof coerced.limit, 'number');
  });

  it('array values pass through coerceParams unchanged', () => {
    const shape = {
      type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      limit: z.number().optional().default(20),
    };
    const parsed = parseQueryParams('http://localhost/api?type=a&type=b&limit=10', shape);
    const coerced = coerceParams(shape, parsed as Record<string, string>);
    // Array should pass through unchanged (coerceParams skips non-string values)
    assert.deepEqual(coerced.type, ['a', 'b']);
    // Number should still be coerced
    assert.equal(coerced.limit, 10);
  });

  it('handles URL with no query params', () => {
    const shape = {
      type: z.string().optional(),
    };
    const result = parseQueryParams('http://localhost/api/writ/list', shape);
    assert.deepEqual(result, {});
  });

  it('handles mixed repeated and single params', () => {
    const shape = {
      status: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      type: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      limit: z.number().optional(),
    };
    const result = parseQueryParams(
      'http://localhost/api?status=open&status=new&type=mandate&limit=10',
      shape,
    );
    assert.deepEqual(result.status, ['open', 'new']);
    assert.equal(result.type, 'mandate');
    assert.equal(result.limit, '10');
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

    const { ctx } = buildTestContext([]);

    if ('apparatus' in plugin) {
      await plugin.apparatus.start(ctx);
    }

    const api = plugin.apparatus.provides as { port(): number; startServer(): Promise<void> };
    await api.startServer();

    try {
      // Server should be listening
      const res = await fetch(`http://localhost:${port}/`);
      assert.ok(res.status > 0);

      // api.port() should return the port
      assert.equal(api.port(), port);
    } finally {
      if ('apparatus' in plugin) {
        await plugin.apparatus.stop?.();
      }
    }
  });

  it('does not start server on start() alone', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 17475 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext([]);

    if ('apparatus' in plugin) {
      await plugin.apparatus.start(ctx);
    }

    try {
      // Server should NOT be listening — fetch should fail
      let fetchSucceeded = false;
      try {
        await fetch(`http://localhost:${port}/`);
        fetchSucceeded = true;
      } catch {
        // Expected — connection refused
      }
      assert.ok(!fetchSucceeded, 'Server should not be listening after start() alone');
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
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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

    // Filter button styles: inactive state, hover state, and active state
    assert.ok(text.includes('.filter-btn'), 'shared stylesheet defines .filter-btn base styles');
    assert.ok(text.includes('.filter-btn:hover:not(.active-filter)'), 'shared stylesheet defines .filter-btn hover state');
    assert.ok(text.includes('.filter-btn.active-filter'), 'shared stylesheet defines .filter-btn.active-filter');
  });
});

// ── Integration tests: home page ──────────────────────────────────────

describe('Oculus home page', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;
  let guildHome: string;

  before(async () => {
    guildHome = makeTmpDir();
    port = 17790 + Math.floor(Math.random() * 100);

    const pages: PageContribution[] = [
      { id: 'dash', title: 'Dashboard', dir: 'pages/dash' },
    ];
    const kits: LoadedKit[] = [mockKit('my-kit', [], pages)];
    const instrumentarium = createMockInstrumentarium([]);

    // Create minimal node_modules structure for the page
    const nmDir = path.join(guildHome, 'node_modules', '@test', 'my-kit', 'pages', 'dash');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.html'), '<html><head></head><body>Dash</body></html>');

    // Write guild.json to the home dir for the config display
    fs.writeFileSync(
      path.join(guildHome, 'guild.json'),
      JSON.stringify({ name: 'my-guild', nexus: '0.0.0', plugins: [] }, null, 2),
    );

    wireGuild({ home: guildHome, kits, instrumentarium, guildName: 'my-guild', oculusPort: port });

    oculusPlugin = createOculus();
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.stop?.();
    }
    clearGuild();
    cleanupTmpDir();
  });

  it('returns HTML with guild name and nav page links', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('my-guild'));
    assert.ok(text.includes('/static/style.css'));
    assert.ok(text.includes('<nav id="oculus-nav">'));
    // Nav bar still has page links
    assert.ok(text.includes('/pages/dash/'));
  });

  it('does not contain a Pages widget heading', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    // Old "Pages" card heading must be gone
    assert.ok(!text.includes('<h2>Pages</h2>'));
  });

  it('contains identity card with guild name, nexus, home, model, port', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('my-guild'));
    assert.ok(text.includes('Nexus'));
    assert.ok(text.includes('Home'));
    assert.ok(text.includes('Model'));
    assert.ok(text.includes('Port'));
    assert.ok(text.includes(String(port)));
  });

  it('shows (not set) when model is absent', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('(not set)'));
  });

  it('contains guild.json config block inside details/summary', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('<details'));
    assert.ok(text.includes('<summary'));
    assert.ok(text.includes('guild.json'));
    assert.ok(text.includes('<pre'));
    // Raw JSON content should appear (escaped)
    assert.ok(text.includes('"my-guild"') || text.includes('&quot;my-guild&quot;') || text.includes('my-guild'));
  });

  it('does not contain a script tag (no client-side JS)', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(!text.includes('<script'));
  });

  it('does not show warnings card when there are no warnings', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(!text.includes('<h2>Warnings</h2>'));
  });
});

// ── Integration tests: home page — identity with model ───────────────

describe('Oculus home page — model set', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17830 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);
    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify({ name: 'test-guild', nexus: '0.0.0', plugins: [] }));
    wireGuild({ home, instrumentarium, guildName: 'test-guild', oculusPort: port, model: 'claude-opus-4' });
    oculusPlugin = createOculus();
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('shows model name when set', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('claude-opus-4'));
    assert.ok(!text.includes('(not set)'));
  });
});

// ── Integration tests: home page — warnings ───────────────────────────

describe('Oculus home page — startup warnings', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17840 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);
    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify({ name: 'test-guild', nexus: '0.0.0', plugins: [] }));
    wireGuild({
      home,
      instrumentarium,
      guildName: 'test-guild',
      oculusPort: port,
      startupWarnings: ['[arbor] warn: "x" recommends "y" but it is not installed.'],
    });
    oculusPlugin = createOculus();
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('shows Warnings card when warnings are present', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('Warnings'));
    assert.ok(text.includes('[arbor] warn'));
  });
});

// ── Integration tests: home page — plugins table ──────────────────────

describe('Oculus home page — plugins table', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17850 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);

    const apparatuses: LoadedApparatus[] = [
      {
        packageName: '@test/tools',
        id: 'tools',
        version: '1.0.0',
        apparatus: {
          requires: [],
          provides: {},
          async start() {},
        },
      },
    ];
    const kits: LoadedKit[] = [mockKit('my-kit', [], undefined, undefined)];
    kits[0] = { ...kits[0], version: '2.0.0' };

    const failedPlugins: import('@shardworks/nexus-core').FailedPlugin[] = [
      { id: 'broken', reason: 'missing dependency' },
    ];

    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify({ name: 'test-guild', nexus: '0.0.0', plugins: [] }));
    wireGuild({ home, instrumentarium, guildName: 'test-guild', oculusPort: port, apparatuses, kits, failedPlugins });
    oculusPlugin = createOculus();
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('shows apparatus rows with badge--success', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('badge--success'));
    assert.ok(text.includes('tools'));
  });

  it('shows kit rows with badge--info', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('badge--info'));
    assert.ok(text.includes('my-kit'));
  });

  it('shows failed plugin rows with badge--error and reason', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('badge--error'));
    assert.ok(text.includes('broken'));
    assert.ok(text.includes('missing dependency'));
  });

  it('shows a table with data-table class', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('data-table'));
  });
});

// ── Integration tests: home page — HTML escaping ──────────────────────

describe('Oculus home page — HTML escaping', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17860 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);
    // Write guild.json with content that needs escaping
    fs.writeFileSync(
      path.join(home, 'guild.json'),
      '{"name":"test","nexus":"0.0.0","plugins":[],"evil":"<script>alert(\\"xss\\")</script>"}',
    );
    wireGuild({ home, instrumentarium, guildName: 'test-guild', oculusPort: port });
    oculusPlugin = createOculus();
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('HTML-escapes the guild.json content in config block', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const text = await res.text();
    assert.ok(text.includes('&lt;script&gt;'));
    assert.ok(!text.match(/<script>alert/));
  });
});

// ── Integration tests: /api/_status ───────────────────────────────────

describe('Oculus /api/_status', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17870 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);

    const apparatuses: LoadedApparatus[] = [
      {
        packageName: '@test/tools',
        id: 'tools',
        version: '1.2.3',
        apparatus: {
          requires: [],
          provides: {},
          async start() {},
        },
      },
    ];
    const kits: LoadedKit[] = [{ ...mockKit('my-kit', []), version: '4.5.6' }];

    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify({ name: 'test-guild', nexus: '0.0.0', plugins: [] }));
    wireGuild({
      home,
      instrumentarium,
      guildName: 'status-guild',
      oculusPort: port,
      apparatuses,
      kits,
    });
    oculusPlugin = createOculus();
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('returns 200 with JSON', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    assert.equal(res.status, 200);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(typeof data === 'object');
  });

  it('has all required top-level keys', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    for (const key of ['guild', 'nexus', 'home', 'model', 'port', 'apparatuses', 'kits', 'failedPlugins', 'warnings', 'config']) {
      assert.ok(key in data, `missing key: ${key}`);
    }
  });

  it('guild name is correct', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.guild, 'status-guild');
  });

  it('apparatuses is array with id and version', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(Array.isArray(data.apparatuses));
    const apps = data.apparatuses as Array<{ id: string; version: string }>;
    assert.equal(apps.length, 1);
    assert.equal(apps[0].id, 'tools');
    assert.equal(apps[0].version, '1.2.3');
  });

  it('kits is array with id and version', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(Array.isArray(data.kits));
    const ks = data.kits as Array<{ id: string; version: string }>;
    assert.equal(ks.length, 1);
    assert.equal(ks[0].id, 'my-kit');
    assert.equal(ks[0].version, '4.5.6');
  });

  it('failedPlugins and warnings are empty arrays', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(Array.isArray(data.failedPlugins));
    assert.equal((data.failedPlugins as unknown[]).length, 0);
    assert.ok(Array.isArray(data.warnings));
    assert.equal((data.warnings as unknown[]).length, 0);
  });

  it('config is an object not a string', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(typeof data.config, 'object');
    assert.ok(data.config !== null);
  });

  it('model is (not set) when not configured', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.model, '(not set)');
  });

  it('port matches the configured port', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.port, port);
  });
});

// ── Integration tests: /api/_status with failed plugins and warnings ──

describe('Oculus /api/_status — failed plugins and warnings', () => {
  let port: number;
  let oculusPlugin: ReturnType<typeof createOculus>;

  before(async () => {
    const home = makeTmpDir();
    port = 17880 + Math.floor(Math.random() * 100);
    const instrumentarium = createMockInstrumentarium([]);
    const failedPlugins: import('@shardworks/nexus-core').FailedPlugin[] = [
      { id: 'broken', reason: 'missing dependency' },
    ];
    fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify({ name: 'test-guild', nexus: '0.0.0', plugins: [] }));
    wireGuild({
      home,
      instrumentarium,
      guildName: 'test-guild',
      oculusPort: port,
      failedPlugins,
      startupWarnings: ['warning one', 'warning two'],
    });
    oculusPlugin = createOculus();
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
    }
  });

  after(async () => {
    if (oculusPlugin && 'apparatus' in oculusPlugin) { await oculusPlugin.apparatus.stop?.(); }
    clearGuild();
    cleanupTmpDir();
  });

  it('failedPlugins contains entries with id and reason', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    const fp = data.failedPlugins as Array<{ id: string; reason: string }>;
    assert.equal(fp.length, 1);
    assert.equal(fp[0].id, 'broken');
    assert.equal(fp[0].reason, 'missing dependency');
  });

  it('warnings contains string entries', async () => {
    const res = await fetch(`http://localhost:${port}/api/_status`);
    const data = await res.json() as Record<string, unknown>;
    const w = data.warnings as string[];
    assert.equal(w.length, 2);
    assert.ok(w.includes('warning one'));
    assert.ok(w.includes('warning two'));
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
        permission: 'write',
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
    // Pass tool definitions as kit entries so ctx.kits('tools') registers the routes
    const kitEntries = buildKitEntries([mockKit('test-tools-kit', tools)]);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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

  it('POST /api/commission/post is registered (write → POST)', async () => {
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
    const { ctx } = buildTestContext([]);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in oculusPlugin) {
      await oculusPlugin.apparatus.start(ctx);
      const api = oculusPlugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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
    const kitEntries = buildKitEntries(kits);
    const { ctx } = buildTestContext(kitEntries);
    if ('apparatus' in plugin) {
      await plugin.apparatus.start(ctx);
      const api = plugin.apparatus.provides as { startServer(): Promise<void> };
      await api.startServer();
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

// ── stopServer tests ─────────────────────────────────────────────────

/** Try to bind a TCP server on the given port. Resolves true if successful. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

describe('OculusApi.stopServer()', () => {
  afterEach(() => {
    clearGuild();
    cleanupTmpDir();
  });

  it('closes the listening socket and is idempotent', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 18300 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext([]);
    await plugin.apparatus.start(ctx);

    const api = plugin.apparatus.provides as {
      port(): number;
      startServer(): Promise<void>;
      stopServer(): Promise<void>;
    };
    await api.startServer();

    // Verify server is reachable
    const res = await fetch(`http://localhost:${port}/`);
    assert.ok(res.status > 0);

    // First stop — should succeed
    await api.stopServer();

    // Server should no longer be reachable
    let fetchSucceeded = false;
    try {
      await fetch(`http://localhost:${port}/`);
      fetchSucceeded = true;
    } catch {
      // Expected — connection refused
    }
    assert.ok(!fetchSucceeded, 'Server should not be reachable after stopServer()');

    // Second stop — idempotent, should not throw
    await api.stopServer();
  });

  it('releases the port so it can be rebound', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 18400 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext([]);
    await plugin.apparatus.start(ctx);

    const api = plugin.apparatus.provides as {
      port(): number;
      startServer(): Promise<void>;
      stopServer(): Promise<void>;
    };
    await api.startServer();

    // Port should be in use
    const busyBefore = await isPortFree(port);
    assert.ok(!busyBefore, 'Port should be in use while server is running');

    await api.stopServer();

    // Port should now be free
    const freeAfter = await isPortFree(port);
    assert.ok(freeAfter, 'Port should be free after stopServer()');
  });

  it('is a no-op when server was never started', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 18500 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext([]);
    await plugin.apparatus.start(ctx);

    const api = plugin.apparatus.provides as {
      stopServer(): Promise<void>;
    };

    // Should not throw
    await api.stopServer();
  });
});

describe('nsg oculus tool signal handler wiring', () => {
  afterEach(() => {
    clearGuild();
    cleanupTmpDir();
  });

  it('stopServer is called when the oculus tool resolves via signal', async () => {
    const home = makeTmpDir();
    const instrumentarium = createMockInstrumentarium([]);
    const port = 18600 + Math.floor(Math.random() * 100);

    wireGuild({ home, kits: [], instrumentarium, oculusPort: port });

    const plugin = createOculus();
    const { ctx } = buildTestContext([]);
    await plugin.apparatus.start(ctx);

    // Extract the oculus tool from supportKit
    const supportTools = plugin.apparatus.supportKit?.tools as Array<{
      handler: (params: Record<string, never>) => Promise<string>;
    }>;
    assert.ok(supportTools && supportTools.length > 0, 'supportKit should have tools');
    const oculusTool = supportTools[0];

    // Run the handler — it will block on signal. Send SIGINT shortly after.
    const handlerPromise = oculusTool.handler({});

    // Give the server a moment to start, then signal
    await new Promise((r) => setTimeout(r, 100));

    // Verify server is running before signal
    const res = await fetch(`http://localhost:${port}/`);
    assert.ok(res.status > 0);

    // Emit SIGINT to trigger the handler's cleanup
    process.emit('SIGINT', 'SIGINT');

    const result = await handlerPromise;
    assert.equal(result, 'Oculus stopped.');

    // After the handler resolves, the server should be stopped
    let fetchSucceeded = false;
    try {
      await fetch(`http://localhost:${port}/`);
      fetchSucceeded = true;
    } catch {
      // Expected
    }
    assert.ok(!fetchSucceeded, 'Server should be stopped after signal handler ran');
  });
});
