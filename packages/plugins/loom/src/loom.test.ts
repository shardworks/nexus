/**
 * The Loom — unit tests.
 *
 * Tests the MVP weave: system prompt is undefined (composition not yet
 * implemented), role is accepted but not yet used.
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
      const weave = await api.weave({});

      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('returns undefined systemPrompt even when role is provided', async () => {
      const api = makeLoomApi();
      const weave = await api.weave({ role: 'artificer' });

      assert.strictEqual(weave.systemPrompt, undefined);
    });

    it('accepts role without error', async () => {
      const api = makeLoomApi();
      // Should not throw — role is accepted, just not used at MVP
      await api.weave({ role: 'scribe' });
    });

    it('returns a promise', () => {
      const api = makeLoomApi();
      const result = api.weave({});

      assert.ok(result instanceof Promise, 'weave() should return a Promise');
    });

    it('returns an object without initialPrompt', async () => {
      const api = makeLoomApi();
      const weave = await api.weave({ role: 'artificer' });

      assert.ok(!('initialPrompt' in weave), 'AnimaWeave should not have initialPrompt');
    });
  });
});
