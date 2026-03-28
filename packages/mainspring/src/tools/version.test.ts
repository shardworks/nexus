/**
 * Tests for the `version` built-in tool.
 *
 * Tests the handler directly — no CLI layer involved.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import versionTool from './version.ts';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsg-version-test-'));
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

describe('version tool definition', () => {
  it('has the correct name', () => {
    assert.equal(versionTool.name, 'version');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(versionTool.callableFrom, ['cli']);
  });
});

// ── Text output ────────────────────────────────────────────────────────────

describe('version handler — text mode', () => {
  it('always includes "nexus:" even with no guild', async () => {
    const tmp = makeTmpDir(); // empty dir — no guild.json

    const result = await versionTool.handler({}, { home: tmp } as never);
    assert.ok(typeof result === 'string');
    assert.ok((result as string).includes('nexus:'));
  });

  it('always includes "node:" even with no guild', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes('node:'));
  });

  it('reports the current node version', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({}, { home: tmp } as never);
    assert.ok((result as string).includes(process.version));
  });

  it('uses "key: value" format for all lines', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({}, { home: tmp } as never) as string;
    for (const line of result.split('\n')) {
      if (line.trim() === '') continue;
      assert.ok(line.includes(': '), `Expected "key: value" format, got: "${line}"`);
    }
  });

  it('shows package as "not installed" when not resolvable from mainspring', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'some-tool': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
      },
    });

    const result = await versionTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('some-nonexistent-pkg'));
    assert.ok(result.includes('not installed'));
  });

  it('does not duplicate a package when multiple tools share it', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'tool-a': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
        'tool-b': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
      },
    });

    const result = await versionTool.handler({}, { home: tmp } as never) as string;
    const lines = result.split('\n').filter((l) => l.startsWith('some-nonexistent-pkg'));
    assert.equal(lines.length, 1);
  });

  it('shows packages for multiple distinct rigs', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'tool-a': {
          upstream: 'pkg-alpha@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'pkg-alpha',
        },
        'tool-b': {
          upstream: 'pkg-beta@2.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'pkg-beta',
        },
      },
    });

    const result = await versionTool.handler({}, { home: tmp } as never) as string;
    assert.ok(result.includes('pkg-alpha'));
    assert.ok(result.includes('pkg-beta'));
  });
});

// ── JSON output ────────────────────────────────────────────────────────────

describe('version handler — json mode', () => {
  it('returns an object (not a string)', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({ json: true }, { home: tmp } as never);
    assert.ok(typeof result === 'object' && result !== null);
  });

  it('includes nexus version string', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({ json: true }, { home: tmp } as never) as Record<string, string>;
    assert.ok(typeof result.nexus === 'string');
    assert.ok(result.nexus.length > 0);
  });

  it('includes node version matching process.version', async () => {
    const tmp = makeTmpDir();

    const result = await versionTool.handler({ json: true }, { home: tmp } as never) as Record<string, string>;
    assert.equal(result.node, process.version);
  });

  it('marks unknown packages as "not installed"', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'some-tool': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
      },
    });

    const result = await versionTool.handler({ json: true }, { home: tmp } as never) as Record<string, string>;
    assert.equal(result['some-nonexistent-pkg'], 'not installed');
  });

  it('deduplicates packages in json output', async () => {
    const tmp = makeTmpDir();
    makeGuild(tmp, {
      tools: {
        'tool-a': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
        'tool-b': {
          upstream: 'some-nonexistent-pkg@1.0.0',
          installedAt: '2026-01-01T00:00:00Z',
          package: 'some-nonexistent-pkg',
        },
      },
    });

    const result = await versionTool.handler({ json: true }, { home: tmp } as never) as Record<string, string>;
    const pkgEntries = Object.keys(result).filter((k) => k === 'some-nonexistent-pkg');
    assert.equal(pkgEntries.length, 1);
  });

  it('succeeds gracefully when guild.json is missing (no tools section)', async () => {
    const tmp = makeTmpDir(); // no guild.json

    const result = await versionTool.handler({ json: true }, { home: tmp } as never) as Record<string, string>;
    // Should still have nexus and node
    assert.ok('nexus' in result);
    assert.ok('node' in result);
    // No package entries
    assert.equal(Object.keys(result).length, 2);
  });
});
