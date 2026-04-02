/**
 * Tests for the `status` framework command.
 *
 * Tests the handler directly — no CLI layer involved.
 * Plugins come from config.plugins. Roles are now Loom-owned plugin config,
 * not framework-level — status shows plugins but not roles.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import statusTool from './status.ts';
import { setupGuildAccessor, makeTmpDir, makeGuild, cleanupTestState } from './test-helpers.ts';

afterEach(() => {
  cleanupTestState();
});

// ── No guild ──────────────────────────────────────────────────────────────

describe('status handler — no guild', () => {
  it('throws a friendly error when guild is not initialized', async () => {
    await assert.rejects(
      async () => statusTool.handler({}),
      /Not inside a guild/,
    );
  });
});

// ── Tool metadata ──────────────────────────────────────────────────────────

describe('status tool definition', () => {
  it('has the correct name', () => {
    assert.equal(statusTool.name, 'status');
  });

  it('is callable from cli only', () => {
    assert.deepEqual(statusTool.callableBy, ['cli']);
  });
});

// ── Text output ────────────────────────────────────────────────────────────

describe('status handler — text mode', () => {
  it('shows guild name', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({});
    assert.ok(typeof result === 'string');
    assert.ok((result as string).includes('test-guild'));
  });

  it('shows guild home path', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({});
    assert.ok((result as string).includes(tmp));
  });

  it('shows model from settings', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp, { settings: { model: 'opus' } });

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({});
    assert.ok((result as string).includes('opus'));
  });

  it('shows "(none)" for plugins when plugins list is empty', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({}) as string;
    const pluginsLine = result.split('\n').find((l) => l.startsWith('Plugins:')) ?? '';
    assert.ok(pluginsLine.includes('(none)'));
  });

  it('shows installed plugin ids from config.plugins', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp, { plugins: ['nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({}) as string;
    assert.ok(result.includes('nexus-stdlib'));
  });

  it('shows multiple installed plugins', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp, { plugins: ['nexus-stdlib', 'nexus-ledger'] });

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({}) as string;
    assert.ok(result.includes('nexus-stdlib'));
    assert.ok(result.includes('nexus-ledger'));
  });
});

// ── JSON output ────────────────────────────────────────────────────────────

describe('status handler — json mode', () => {
  it('returns an object (not a string)', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true });
    assert.ok(typeof result === 'object' && result !== null);
  });

  it('includes guild name', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.equal(result.guild, 'test-guild');
  });

  it('includes home path', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.equal(result.home, tmp);
  });

  it('includes nexus version string', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.ok(typeof result.nexus === 'string');
  });

  it('includes model from settings', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp, { settings: { model: 'haiku' } });

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.equal(result.model, 'haiku');
  });

  it('includes plugins as a sorted array from config.plugins', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp, { plugins: ['nexus-ledger', 'nexus-stdlib'] });

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.ok(Array.isArray(result.plugins));
    const plugins = result.plugins as string[];
    assert.ok(plugins.includes('nexus-stdlib'));
    assert.ok(plugins.includes('nexus-ledger'));
    assert.deepEqual(plugins, [...plugins].sort());
  });

  it('returns empty plugins array when nothing is installed', async () => {
    const tmp = makeTmpDir('status');
    makeGuild(tmp);

    setupGuildAccessor(tmp);
    const result = await statusTool.handler({ json: true }) as Record<string, unknown>;
    assert.deepEqual(result.plugins, []);
  });
});
