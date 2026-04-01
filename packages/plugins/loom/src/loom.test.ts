/**
 * The Loom — unit tests.
 *
 * Tests the MVP weave: system prompt is undefined (composition not yet
 * implemented), caller-provided prompt passed through as initialPrompt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLoom, type LoomApi } from './loom.ts';
import loomDefault from './index.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract the LoomApi from a freshly created loom plugin. */
function makeLoomApi(): LoomApi {
  const plugin = createLoom();
  if (!('apparatus' in plugin)) throw new Error('Expected apparatus plugin');
  return plugin.apparatus.provides as LoomApi;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('The Loom', () => {
  describe('createLoom()', () => {
    it('returns a plugin with apparatus shape', () => {
      const plugin = createLoom();
      assert.ok('apparatus' in plugin, 'should have apparatus key');

      const { apparatus } = plugin as { apparatus: Record<string, unknown> };
      assert.deepStrictEqual(apparatus.requires, []);
      assert.ok(apparatus.provides, 'should have provides');
      assert.ok(typeof apparatus.start === 'function', 'should have start()');
    });

    it('provides a LoomApi with weave()', () => {
      const api = makeLoomApi();
      assert.ok(typeof api.weave === 'function');
    });

    it('start() completes without error', () => {
      const plugin = createLoom();
      const { apparatus } = plugin as { apparatus: { start: (ctx: Record<string, unknown>) => void } };
      apparatus.start({});
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

  describe('weave()', () => {
    it('returns undefined systemPrompt (composition not yet implemented)', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({});

      assert.strictEqual(ctx.systemPrompt, undefined);
    });

    it('passes through prompt as initialPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({ prompt: 'Do the thing.' });

      assert.strictEqual(ctx.initialPrompt, 'Do the thing.');
    });

    it('omits initialPrompt when prompt is not provided', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({});

      assert.strictEqual(ctx.initialPrompt, undefined);
      assert.ok(!('initialPrompt' in ctx), 'initialPrompt key should not be present');
    });

    it('preserves empty string prompt as initialPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({ prompt: '' });

      assert.strictEqual(ctx.initialPrompt, '');
    });

    it('returns a promise', () => {
      const api = makeLoomApi();
      const result = api.weave({});

      assert.ok(result instanceof Promise, 'weave() should return a Promise');
    });

    it('handles multiline prompts', async () => {
      const api = makeLoomApi();
      const multiline = 'Line 1\nLine 2\nLine 3';
      const ctx = await api.weave({ prompt: multiline });

      assert.strictEqual(ctx.initialPrompt, multiline);
    });

    it('handles very long prompts', async () => {
      const api = makeLoomApi();
      const longPrompt = 'x'.repeat(100_000);
      const ctx = await api.weave({ prompt: longPrompt });

      assert.strictEqual(ctx.initialPrompt!.length, 100_000);
    });
  });
});
