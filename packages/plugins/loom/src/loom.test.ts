/**
 * The Loom — unit tests.
 *
 * Tests weave() with role → permissions → tool resolution via a mock
 * Instrumentarium, and the basic structural contract.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import { tool, type InstrumentariumApi, type ResolvedTool, type ResolveOptions } from '@shardworks/tools-apparatus';

import { createLoom, type LoomApi, type LoomConfig } from './loom.ts';
import loomDefault from './index.ts';

// ── Test fixtures ───────────────────────────────────────────────────

/** A minimal tool for testing. */
function testTool(name: string, permission?: string) {
  return tool({
    name,
    description: `Test tool: ${name}`,
    params: {},
    handler: async () => ({ ok: true }),
    ...(permission !== undefined ? { permission } : {}),
  });
}

/** A mock Instrumentarium that records calls and returns configured tools. */
function mockInstrumentarium(resolvedTools: ResolvedTool[] = []) {
  const calls: ResolveOptions[] = [];
  const api: InstrumentariumApi = {
    resolve(options: ResolveOptions): ResolvedTool[] {
      calls.push(options);
      return resolvedTools;
    },
    find: () => null,
    list: () => resolvedTools,
  };
  return { api, calls };
}

/** Set up a fake guild with the given loom config and apparatus map. */
function setupGuild(opts: {
  loomConfig?: LoomConfig;
  apparatuses?: Record<string, unknown>;
}) {
  const apparatuses = opts.apparatuses ?? {};
  setGuild({
    home: '/tmp/test-guild',
    apparatus: <T>(id: string): T => {
      const a = apparatuses[id];
      if (!a) throw new Error(`Apparatus '${id}' not installed`);
      return a as T;
    },
    guildConfig: () => ({
      name: 'test-guild',
      nexus: '0.0.0',
      workshops: {},
      plugins: [],
      loom: opts.loomConfig,
    }),
    kits: () => [],
    apparatuses: () => [],
  } as never);
}

/** Create a started Loom and return its API. */
function startLoom(): LoomApi {
  const plugin = createLoom();
  const apparatus = (plugin as { apparatus: { start: (ctx: unknown) => void; provides: unknown } }).apparatus;
  apparatus.start({ on: () => {} });
  return apparatus.provides as LoomApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('The Loom', () => {
  afterEach(() => {
    clearGuild();
  });

  describe('createLoom()', () => {
    it('returns a plugin with apparatus shape', () => {
      const plugin = createLoom();
      assert.ok('apparatus' in plugin, 'should have apparatus key');

      const { apparatus } = plugin as { apparatus: Record<string, unknown> };
      assert.deepStrictEqual(apparatus.requires, ['tools']);
      assert.ok(apparatus.provides, 'should have provides');
      assert.ok(typeof apparatus.start === 'function', 'should have start()');
    });

    it('provides a LoomApi with weave()', () => {
      const plugin = createLoom();
      const api = (plugin as { apparatus: { provides: LoomApi } }).apparatus.provides;
      assert.ok(typeof api.weave === 'function');
    });
  });

  describe('default export', () => {
    it('is a plugin with apparatus shape', () => {
      assert.ok('apparatus' in loomDefault, 'default export should have apparatus key');
      const { apparatus } = loomDefault as { apparatus: Record<string, unknown> };
      assert.ok(apparatus.provides, 'should have provides');
      assert.ok(typeof (apparatus.provides as LoomApi).weave === 'function', 'provides should have weave()');
    });
  });

  describe('weave() — no role', () => {
    it('returns undefined systemPrompt', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('returns undefined tools when no role is provided', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.tools, undefined);
    });

    it('returns a promise', () => {
      setupGuild({});
      const api = startLoom();
      const result = api.weave({});
      assert.ok(result instanceof Promise, 'weave() should return a Promise');
    });

    it('returns an object without initialPrompt', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });
      assert.ok(!('initialPrompt' in weave), 'AnimaWeave should not have initialPrompt');
    });

    it('returns undefined environment when no role is provided', async () => {
      setupGuild({});
      const api = startLoom();
      const weave = await api.weave({});
      assert.strictEqual(weave.environment, undefined);
    });
  });

  describe('weave() — role with tool resolution', () => {
    it('resolves tools for a configured role', async () => {
      const readTool = testTool('stack-query', 'read');
      const resolved: ResolvedTool[] = [
        { definition: readTool, pluginId: 'stacks' },
      ];
      const { api: instrumentarium, calls } = mockInstrumentarium(resolved);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: {
              permissions: ['stacks:read'],
            },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'scribe' });

      assert.equal(weave.tools?.length, 1);
      assert.equal(weave.tools![0]!.definition.name, 'stack-query');

      // Verify the Instrumentarium was called with correct args
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.permissions, ['stacks:read']);
      assert.equal(calls[0]!.caller, 'anima');
    });

    it('passes strict flag from role definition', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: {
              permissions: ['stacks:read'],
              strict: true,
            },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      await api.weave({ role: 'scribe' });

      assert.equal(calls[0]!.strict, true);
    });

    it('returns undefined tools for an unknown role', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'unknown-role' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0, 'should not call instrumentarium for unknown role');
    });

    it('returns undefined tools when no roles configured', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {},
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0);
    });

    it('returns undefined tools when loom config is absent', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.strictEqual(weave.tools, undefined);
      assert.equal(calls.length, 0);
    });

    it('always passes caller: anima to the Instrumentarium', async () => {
      const { api: instrumentarium, calls } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            admin: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      await api.weave({ role: 'admin' });

      assert.equal(calls[0]!.caller, 'anima');
    });

    it('derives git identity environment from role name', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'artificer' });

      assert.deepStrictEqual(weave.environment, {
        GIT_AUTHOR_NAME: 'Artificer',
        GIT_AUTHOR_EMAIL: 'artificer@nexus.local',
      });
    });

    it('capitalizes first letter of role name for display name', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            scribe: { permissions: ['stacks:read'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'scribe' });

      assert.equal(weave.environment?.GIT_AUTHOR_NAME, 'Scribe');
    });

    it('derives environment even for unknown roles', async () => {
      const { api: instrumentarium } = mockInstrumentarium([]);

      setupGuild({
        loomConfig: {
          roles: {
            artificer: { permissions: ['*:*'] },
          },
        },
        apparatuses: { tools: instrumentarium },
      });

      const api = startLoom();
      const weave = await api.weave({ role: 'unknown-role' });

      assert.ok(weave.environment, 'environment should be defined for any role string');
      assert.equal(weave.environment?.GIT_AUTHOR_NAME, 'Unknown-role');
      assert.equal(weave.environment?.GIT_AUTHOR_EMAIL, 'unknown-role@nexus.local');
    });
  });
});
