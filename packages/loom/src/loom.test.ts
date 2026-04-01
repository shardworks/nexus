/**
 * The Loom — unit tests.
 *
 * Tests the MVP pass-through weave: system prompt packaging,
 * optional initial prompt handling, and async contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLoom, type LoomApi } from './loom.ts';

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
  });

  describe('weave()', () => {
    it('passes through systemPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({
        systemPrompt: 'You are a helpful assistant.',
      });

      assert.strictEqual(ctx.systemPrompt, 'You are a helpful assistant.');
    });

    it('passes through prompt as initialPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({
        systemPrompt: 'System prompt here.',
        prompt: 'Do the thing.',
      });

      assert.strictEqual(ctx.systemPrompt, 'System prompt here.');
      assert.strictEqual(ctx.initialPrompt, 'Do the thing.');
    });

    it('omits initialPrompt when prompt is not provided', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({
        systemPrompt: 'System prompt here.',
      });

      assert.strictEqual(ctx.initialPrompt, undefined);
      assert.ok(!('initialPrompt' in ctx), 'initialPrompt key should not be present');
    });

    it('preserves empty string systemPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({ systemPrompt: '' });

      assert.strictEqual(ctx.systemPrompt, '');
    });

    it('preserves empty string prompt as initialPrompt', async () => {
      const api = makeLoomApi();
      const ctx = await api.weave({
        systemPrompt: 'System.',
        prompt: '',
      });

      assert.strictEqual(ctx.initialPrompt, '');
    });

    it('returns a promise', () => {
      const api = makeLoomApi();
      const result = api.weave({ systemPrompt: 'test' });

      assert.ok(result instanceof Promise, 'weave() should return a Promise');
    });

    it('handles multiline system prompts', async () => {
      const api = makeLoomApi();
      const multiline = 'Line 1\nLine 2\nLine 3';
      const ctx = await api.weave({ systemPrompt: multiline });

      assert.strictEqual(ctx.systemPrompt, multiline);
    });

    it('handles very long prompts', async () => {
      const api = makeLoomApi();
      const longPrompt = 'x'.repeat(100_000);
      const ctx = await api.weave({
        systemPrompt: longPrompt,
        prompt: longPrompt,
      });

      assert.strictEqual(ctx.systemPrompt.length, 100_000);
      assert.strictEqual(ctx.initialPrompt!.length, 100_000);
    });
  });
});
