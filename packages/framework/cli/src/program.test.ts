import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toFlag, isBooleanSchema, findGroupPrefixes, coerceCliOpts } from './helpers.ts';
import type { ToolDefinition } from '@shardworks/tools-apparatus';

// Helper to create a minimal ToolDefinition for testing
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    params: z.object({}),
    handler: async () => null,
  };
}

describe('toFlag', () => {
  it('converts camelCase to kebab-case flag', () => {
    assert.equal(toFlag('writId'), '--writ-id');
    assert.equal(toFlag('guildRoot'), '--guild-root');
  });

  it('handles single-word keys', () => {
    assert.equal(toFlag('name'), '--name');
    assert.equal(toFlag('json'), '--json');
  });

  it('handles multiple capital letters', () => {
    assert.equal(toFlag('myLongOptionName'), '--my-long-option-name');
  });
});

describe('isBooleanSchema', () => {
  it('detects z.boolean()', () => {
    assert.ok(isBooleanSchema(z.boolean()));
  });

  it('detects z.boolean().optional()', () => {
    assert.ok(isBooleanSchema(z.boolean().optional()));
  });

  it('rejects z.string()', () => {
    assert.ok(!isBooleanSchema(z.string()));
  });

  it('rejects z.string().optional()', () => {
    assert.ok(!isBooleanSchema(z.string().optional()));
  });

  it('rejects z.number()', () => {
    assert.ok(!isBooleanSchema(z.number()));
  });

  it('rejects z.enum()', () => {
    assert.ok(!isBooleanSchema(z.enum(['a', 'b'])));
  });
});

describe('findGroupPrefixes', () => {
  it('groups prefixes with 2+ tools', () => {
    const tools = [
      fakeTool('plugin-list'),
      fakeTool('plugin-install'),
      fakeTool('plugin-remove'),
    ];
    const groups = findGroupPrefixes(tools);
    assert.ok(groups.has('plugin'));
    assert.equal(groups.size, 1);
  });

  it('does not group singleton prefixes', () => {
    const tools = [
      fakeTool('show-writ'),
      fakeTool('list-writs'),
      fakeTool('post-writ'),
    ];
    const groups = findGroupPrefixes(tools);
    // Each prefix (show, list, post) has only 1 tool
    assert.ok(!groups.has('show'));
    assert.ok(!groups.has('list'));
    assert.ok(!groups.has('post'));
  });

  it('ignores tools without hyphens', () => {
    const tools = [
      fakeTool('version'),
      fakeTool('status'),
      fakeTool('signal'),
    ];
    const groups = findGroupPrefixes(tools);
    assert.equal(groups.size, 0);
  });

  it('handles mixed grouped and ungrouped', () => {
    const tools = [
      fakeTool('plugin-list'),
      fakeTool('plugin-install'),
      fakeTool('version'),
      fakeTool('show-writ'),
      fakeTool('anima-create'),
      fakeTool('anima-list'),
    ];
    const groups = findGroupPrefixes(tools);
    assert.ok(groups.has('plugin'));
    assert.ok(groups.has('anima'));
    assert.ok(!groups.has('show'));
    assert.equal(groups.size, 2);
  });
});

describe('coerceCliOpts', () => {
  // Number coercion — happy path
  it('converts integer string to number', () => {
    const shape = { limit: z.number() };
    assert.deepEqual(coerceCliOpts(shape, { limit: '5' }), { limit: 5 });
  });

  it('converts float string to number', () => {
    const shape = { ratio: z.number() };
    assert.deepEqual(coerceCliOpts(shape, { ratio: '1.5' }), { ratio: 1.5 });
  });

  it('converts negative number string', () => {
    const shape = { offset: z.number() };
    assert.deepEqual(coerceCliOpts(shape, { offset: '-3' }), { offset: -3 });
  });

  it('coerces optional number', () => {
    const shape = { limit: z.number().optional() };
    assert.deepEqual(coerceCliOpts(shape, { limit: '10' }), { limit: 10 });
  });

  it('coerces optional number with default', () => {
    const shape = { limit: z.number().optional().default(20) };
    assert.deepEqual(coerceCliOpts(shape, { limit: '5' }), { limit: 5 });
  });

  it('coerces number with default (no optional)', () => {
    const shape = { limit: z.number().default(20) };
    assert.deepEqual(coerceCliOpts(shape, { limit: '5' }), { limit: 5 });
  });

  // Pass-through — values that must not be coerced
  it('leaves string param unchanged', () => {
    const shape = { name: z.string() };
    assert.deepEqual(coerceCliOpts(shape, { name: 'hello' }), { name: 'hello' });
  });

  it('leaves enum param unchanged', () => {
    const shape = { status: z.enum(['ready', 'active']) };
    assert.deepEqual(coerceCliOpts(shape, { status: 'ready' }), { status: 'ready' });
  });

  it('passes undefined through unchanged', () => {
    const shape = { limit: z.number().optional() };
    assert.deepEqual(coerceCliOpts(shape, { limit: undefined }), { limit: undefined });
  });

  it('passes missing key through unchanged', () => {
    const shape = { limit: z.number().optional() };
    assert.deepEqual(coerceCliOpts(shape, {}), {});
  });

  it('leaves boolean value (true) unchanged', () => {
    const shape = { force: z.boolean().optional() };
    assert.deepEqual(coerceCliOpts(shape, { force: true }), { force: true });
  });

  // Mixed shapes
  it('only coerces number fields in mixed shape', () => {
    const shape = {
      name: z.string(),
      limit: z.number().optional(),
      status: z.enum(['a', 'b']).optional(),
    };
    const opts = { name: 'test', limit: '5', status: 'a' };
    assert.deepEqual(coerceCliOpts(shape, opts), { name: 'test', limit: 5, status: 'a' });
  });

  // Edge / error cases
  it('non-numeric string becomes NaN', () => {
    const shape = { limit: z.number() };
    const result = coerceCliOpts(shape, { limit: 'abc' });
    assert.ok(Number.isNaN(result['limit'] as number));
  });

  it('empty string becomes 0 (Number("") === 0)', () => {
    const shape = { limit: z.number() };
    assert.deepEqual(coerceCliOpts(shape, { limit: '' }), { limit: 0 });
  });

  it('empty shape leaves extra keys unchanged', () => {
    const shape = {};
    assert.deepEqual(coerceCliOpts(shape, { anything: 'value' }), { anything: 'value' });
  });
});
