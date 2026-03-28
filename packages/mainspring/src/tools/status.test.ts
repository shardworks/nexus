/**
 * Tests for the `status` built-in tool.
 *
 * Tests the handler directly — no CLI layer involved.
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

/** Write a minimal guild.json to dir, with optional overrides. */
function makeGuild(dir: string, overrides: Record<string, unknown> = {}): void {
  const config = {
    name: 'test-guild',
    nexus: '0.0.0',
    model: 'sonnet',
    workshops: {},
    roles: {},
    baseTools: [],
    tools: {},
    engines: {},
    curricula: {},
    temperaments: {},
    rigs: [],
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

  it('shows "(none)" for rigs when no tools have package entries', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('(none)'));
  });

  it('shows "(none)" for roles when no roles are configured', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp);

    const result = await statusTool.handler({}, { home: tmp } as never);
    const lines = (result as string).split('\n');
    const rolesLine = lines.find((l) => l.startsWith('Roles:'));
    assert.ok(rolesLine?.includes('(none)'));
  });

  it('derives rig keys from tool package entries', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        commission: {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('nexus-stdlib'));
  });

  it('strips @shardworks scope from rig key', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'my-tool': {
          upstream: '@shardworks/nexus-ledger@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-ledger',
        },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('nexus-ledger'));
    assert.ok(!(result as string).includes('@shardworks'));
  });

  it('shows installed role names', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      roles: {
        artificer: { seats: null, tools: [] },
        scribe: { seats: 1, tools: [] },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('artificer'));
    assert.ok((result as string).includes('scribe'));
  });

  it('deduplicates rigs when multiple tools share a package', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'tool-a': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'tool-b': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    const rigsLine = result.split('\n').find((l) => l.startsWith('Rigs:')) ?? '';
    // Only one occurrence of nexus-stdlib in the rigs line
    const matches = rigsLine.match(/nexus-stdlib/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it('shows multiple rigs from different packages', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'commission': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'create-writ': {
          upstream: '@shardworks/nexus-ledger@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-ledger',
        },
      },
    });

    const result = await statusTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('nexus-stdlib'));
    assert.ok(result.includes('nexus-ledger'));
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
    assert.ok((result.nexus as string).length > 0);
  });

  it('includes rigs as a sorted array', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'commission': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'create-writ': {
          upstream: '@shardworks/nexus-ledger@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-ledger',
        },
      },
    });

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    assert.ok(Array.isArray(result.rigs));
    const rigs = result.rigs as string[];
    assert.ok(rigs.includes('nexus-stdlib'));
    assert.ok(rigs.includes('nexus-ledger'));
    // sorted
    assert.deepEqual(rigs, [...rigs].sort());
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
    assert.deepEqual(result.rigs, []);
    assert.deepEqual(result.roles, []);
  });

  it('deduplicates rigs in json output', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'tool-a': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
        'tool-b': {
          upstream: '@shardworks/nexus-stdlib@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: '@shardworks/nexus-stdlib',
        },
      },
    });

    const result = await statusTool.handler({ json: true }, { home: tmp } as never) as Record<string, unknown>;
    const rigs = result.rigs as string[];
    assert.equal(rigs.length, 1);
    assert.equal(rigs[0], 'nexus-stdlib');
  });
});
