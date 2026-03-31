/**
 * Tests for the `status` built-in tool (V2 guild config).
 *
 * Tests the handler directly — no CLI layer involved.
 * V2: rigs come from config.rigs directly, not derived from a tools registry.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import statusTool from './status.ts';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-status-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** Write a minimal V2 guild.json to dir, with optional overrides. */
function makeGuild(dir: string, overrides: Record<string, unknown> = {}): void {
  const config = {
    name: 'test-guild',
    nexus: '0.0.0',
    workshops: {},
    roles: {},
    baseTools: [],
    plugins: [],
    settings: { model: 'sonnet' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'guild.json'), JSON.stringify(config, null, 2) + '\n');
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('status tool definition', () => {
  it('has the correct name', () => {
    assert.equal(statusTool.name, 'status');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(statusTool.callableFrom, ['cli']);
  });
});

// ── Text output ────────────────────────────────────────────────────────────

describe('status handler — text mode', () => {
  it('shows guild name', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok(typeof result === 'string');
    assert.ok((result as string).includes('test-guild'));
  });

  it('shows guild home path', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes(tmp));
  });

  it('shows model from settings', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { settings: { model: 'opus' } });

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('opus'));
  });

  it('shows "(none)" for plugins when plugins list is empty', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    const pluginsLine = result.split('\n').find((l) => l.startsWith('Plugins:')) ?? '';
    assert.ok(pluginsLine.includes('(none)'));
  });

  it('shows "(none)" for roles when no roles are configured', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    const rolesLine = result.split('\n').find((l) => l.startsWith('Roles:')) ?? '';
    assert.ok(rolesLine.includes('(none)'));
  });

  it('shows installed plugin ids from config.plugins', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('shows multiple installed plugins', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
    assert.ok(result.includes('nexus-ledger'));
  });

  it('shows installed role names', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: {
        artificer: { seats: null, tools: [] },
        scribe: { seats: 1, tools: [] },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('artificer'));
    assert.ok(result.includes('scribe'));
  });
});

// ── JSON output ────────────────────────────────────────────────────────────

describe('status handler — json mode', () => {
  it('returns an object (not a string)', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({ json: true }, { home: tmp } as never);
    assert.ok(typeof result === 'object' && result !== null);
  });

  it('includes guild name', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.equal(result.guild, 'test-guild');
  });

  it('includes home path', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.equal(result.home, tmp);
  });

  it('includes nexus version string', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.ok(typeof result.nexus === 'string');
  });

  it('includes model from settings', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { settings: { model: 'haiku' } });

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.equal(result.model, 'haiku');
  });

  it('includes plugins as a sorted array from config.plugins', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, { plugins: ['nexus-ledger', 'nexus-stdlib'] });

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.ok(Array.isArray(result.plugins));
    const plugins = result.plugins as string[];
    assert.ok(plugins.includes('nexus-stdlib'));
    assert.ok(plugins.includes('nexus-ledger'));
    assert.deepEqual(plugins, [...plugins].sort());
  });

  it('includes roles as a sorted array', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: {
        scribe: { seats: 1, tools: [] },
        artificer: { seats: null, tools: [] },
      },
    });

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.ok(Array.isArray(result.roles));
    const roles = result.roles as string[];
    assert.ok(roles.includes('artificer'));
    assert.ok(roles.includes('scribe'));
    assert.deepEqual(roles, [...roles].sort());
  });

  it('returns empty arrays when nothing is installed', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.roles, []);
  });
});
