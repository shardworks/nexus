/**
 * tool.ts — unit tests.
 *
 * Tests the tool() factory and isToolDefinition() public functions directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { tool, isToolDefinition } from './tool.ts';

// ── tool() factory ───────────────────────────────────────────────────

describe('tool()', () => {
  it('returns a ToolDefinition with params as a ZodObject', () => {
    const t = tool({
      name: 'lookup',
      description: 'Look up something',
      params: { name: z.string() },
      handler: async () => ({ ok: true }),
    });

    assert.equal(t.name, 'lookup');
    assert.equal(t.description, 'Look up something');
    assert.ok(t.params instanceof z.ZodObject, 'params should be a ZodObject');
    assert.ok(t.params.shape.name instanceof z.ZodString);
    assert.equal(typeof t.handler, 'function');
  });

  it('normalizes callableBy single string to array', () => {
    const t = tool({
      name: 'cli-tool',
      description: 'CLI only',
      params: {},
      handler: async () => ({}),
      callableBy: 'cli',
    });

    assert.deepStrictEqual(t.callableBy, ['cli']);
  });

  it('preserves callableBy when already an array', () => {
    const t = tool({
      name: 'dual-tool',
      description: 'Both callers',
      params: {},
      handler: async () => ({}),
      callableBy: ['cli', 'anima'],
    });

    assert.deepStrictEqual(t.callableBy, ['cli', 'anima']);
  });

  it('omits callableBy when not provided', () => {
    const t = tool({
      name: 'open-tool',
      description: 'No caller restriction',
      params: {},
      handler: async () => ({}),
    });

    assert.equal('callableBy' in t, false);
  });

  it('omits permission when not provided', () => {
    const t = tool({
      name: 'free-tool',
      description: 'No permission',
      params: {},
      handler: async () => ({}),
    });

    assert.equal('permission' in t, false);
  });

  it('includes permission when provided', () => {
    const t = tool({
      name: 'guarded-tool',
      description: 'Needs write',
      params: {},
      handler: async () => ({}),
      permission: 'write',
    });

    assert.equal(t.permission, 'write');
  });

  it('omits instructions and instructionsFile when neither provided', () => {
    const t = tool({
      name: 'bare-tool',
      description: 'No instructions',
      params: {},
      handler: async () => ({}),
    });

    assert.equal('instructions' in t, false);
    assert.equal('instructionsFile' in t, false);
  });

  it('includes inline instructions when provided', () => {
    const t = tool({
      name: 'instructed-tool',
      description: 'Has instructions',
      params: {},
      handler: async () => ({}),
      instructions: 'Use this tool when you need to look things up.',
    });

    assert.equal(t.instructions, 'Use this tool when you need to look things up.');
    assert.equal('instructionsFile' in t, false);
  });

  it('includes instructionsFile when provided', () => {
    const t = tool({
      name: 'file-instructed-tool',
      description: 'Has instructions file',
      params: {},
      handler: async () => ({}),
      instructionsFile: './instructions.md',
    });

    assert.equal(t.instructionsFile, './instructions.md');
    assert.equal('instructions' in t, false);
  });
});

// ── isToolDefinition() ───────────────────────────────────────────────

describe('isToolDefinition()', () => {
  it('returns true for a valid tool definition', () => {
    const t = tool({
      name: 'valid',
      description: 'A valid tool',
      params: {},
      handler: async () => ({}),
    });
    assert.equal(isToolDefinition(t), true);
  });

  it('returns true for a manually constructed tool-like object', () => {
    const obj = {
      name: 'manual',
      description: 'Manually built',
      params: z.object({}),
      handler: () => ({}),
    };
    assert.equal(isToolDefinition(obj), true);
  });

  it('returns false for null', () => {
    assert.equal(isToolDefinition(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isToolDefinition(undefined), false);
  });

  it('returns false for primitives', () => {
    assert.equal(isToolDefinition('string'), false);
    assert.equal(isToolDefinition(42), false);
    assert.equal(isToolDefinition(true), false);
  });

  it('returns false when name is missing', () => {
    assert.equal(
      isToolDefinition({ description: 'x', params: {}, handler: () => {} }),
      false,
    );
  });

  it('returns false when description is missing', () => {
    assert.equal(
      isToolDefinition({ name: 'x', params: {}, handler: () => {} }),
      false,
    );
  });

  it('returns false when params is missing', () => {
    assert.equal(
      isToolDefinition({ name: 'x', description: 'x', handler: () => {} }),
      false,
    );
  });

  it('returns false when handler is missing', () => {
    assert.equal(
      isToolDefinition({ name: 'x', description: 'x', params: {} }),
      false,
    );
  });

  it('returns false when name is not a string', () => {
    assert.equal(
      isToolDefinition({ name: 42, description: 'x', params: {}, handler: () => {} }),
      false,
    );
  });

  it('returns false when description is not a string', () => {
    assert.equal(
      isToolDefinition({ name: 'x', description: 42, params: {}, handler: () => {} }),
      false,
    );
  });

  it('returns false when handler is not a function', () => {
    assert.equal(
      isToolDefinition({ name: 'x', description: 'x', params: {}, handler: 'not-fn' }),
      false,
    );
  });
});
