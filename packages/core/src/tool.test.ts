import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { tool, isToolDefinition, resolveToolFromExport, resolveAllToolsFromExport } from './tool.ts';

describe('tool SDK', () => {
  it('creates a definition with name, description, params schema, and handler', () => {
    const def = tool({
      name: 'test-tool',
      description: 'Test tool',
      params: {
        name: z.string().describe('A name'),
      },
      handler: ({ name }, _ctx) => ({ greeting: `hello ${name}` }),
    });

    assert.equal(def.name, 'test-tool');
    assert.equal(def.description, 'Test tool');
    assert.ok(def.params);
    assert.ok(def.handler);
  });

  it('supports inline instructions', () => {
    const def = tool({
      name: 'my-tool',
      description: 'Named tool',
      instructions: 'Use this when you need to greet someone.',
      params: {
        name: z.string(),
      },
      handler: ({ name }) => `hello ${name}`,
    });

    assert.equal(def.instructions, 'Use this when you need to greet someone.');
    assert.equal(def.instructionsFile, undefined);
  });

  it('supports instructionsFile', () => {
    const def = tool({
      name: 'my-tool',
      description: 'Named tool',
      instructionsFile: './instructions.md',
      params: {
        name: z.string(),
      },
      handler: ({ name }) => `hello ${name}`,
    });

    assert.equal(def.instructionsFile, './instructions.md');
    assert.equal(def.instructions, undefined);
  });

  it('omits instructions fields when not provided', () => {
    const def = tool({
      name: 'minimal',
      description: 'Minimal tool',
      params: { x: z.number() },
      handler: ({ x }) => x,
    });

    assert.equal(def.instructions, undefined);
    assert.equal(def.instructionsFile, undefined);
  });

  it('params schema validates input', () => {
    const def = tool({
      name: 'typed',
      description: 'Typed tool',
      params: {
        count: z.number().describe('How many'),
        label: z.string().optional().describe('Optional label'),
      },
      handler: ({ count, label }, _ctx) => ({ count, label }),
    });

    // Valid input
    const parsed = def.params.parse({ count: 5 });
    assert.equal(parsed.count, 5);
    assert.equal(parsed.label, undefined);

    // Valid with optional
    const parsed2 = def.params.parse({ count: 3, label: 'test' });
    assert.equal(parsed2.label, 'test');

    // Invalid input
    assert.throws(() => def.params.parse({ count: 'not a number' }));
    assert.throws(() => def.params.parse({}));
  });

  it('handler receives validated params and context', async () => {
    const def = tool({
      name: 'context-test',
      description: 'Context test',
      params: {
        source: z.string(),
      },
      handler: ({ source }, { home }) => ({ source, home }),
    });

    const result = await def.handler({ source: '/path/to/tool' }, { home: '/nexus' });
    assert.deepEqual(result, { source: '/path/to/tool', home: '/nexus' });
  });

  it('supports async handlers', async () => {
    const def = tool({
      name: 'async-tool',
      description: 'Async tool',
      params: {
        ms: z.number(),
      },
      handler: async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { waited: ms };
      },
    });

    const result = await def.handler({ ms: 1 }, { home: '/tmp' });
    assert.deepEqual(result, { waited: 1 });
  });

  it('exposes param shape for MCP registration', () => {
    const def = tool({
      name: 'shape-test',
      description: 'Shape test',
      params: {
        name: z.string().describe('Tool name'),
        version: z.string().optional().describe('Tool version'),
      },
      handler: () => ({}),
    });

    // The MCP engine uses .params.shape to register tool input schemas
    const shape = def.params.shape;
    assert.ok(shape.name);
    assert.ok(shape.version);
  });
});

describe('isToolDefinition', () => {
  it('returns true for tool() output', () => {
    const def = tool({
      name: 'test',
      description: 'Test',
      params: { x: z.number() },
      handler: () => ({}),
    });
    assert.equal(isToolDefinition(def), true);
  });

  it('returns false for non-tool objects', () => {
    assert.equal(isToolDefinition(null), false);
    assert.equal(isToolDefinition({}), false);
    assert.equal(isToolDefinition({ description: 'hi' }), false);
    assert.equal(isToolDefinition({ name: 'hi', description: 'hi' }), false);
    assert.equal(isToolDefinition('string'), false);
  });
});

describe('resolveToolFromExport', () => {
  const toolA = tool({
    name: 'alpha',
    description: 'Alpha tool',
    params: { x: z.number() },
    handler: ({ x }) => x,
  });

  const toolB = tool({
    name: 'beta',
    description: 'Beta tool',
    params: { y: z.string() },
    handler: ({ y }) => y,
  });

  it('resolves a single tool export by name', () => {
    const result = resolveToolFromExport(toolA, 'alpha');
    assert.equal(result, toolA);
  });

  it('resolves a single tool export without name', () => {
    const result = resolveToolFromExport(toolA);
    assert.equal(result, toolA);
  });

  it('returns null for single tool when name does not match', () => {
    const result = resolveToolFromExport(toolA, 'wrong-name');
    assert.equal(result, null);
  });

  it('resolves a tool from an array by name', () => {
    const result = resolveToolFromExport([toolA, toolB], 'beta');
    assert.equal(result, toolB);
  });

  it('returns null for array when name does not match', () => {
    const result = resolveToolFromExport([toolA, toolB], 'gamma');
    assert.equal(result, null);
  });

  it('returns the only tool from a single-element array without name', () => {
    const result = resolveToolFromExport([toolA]);
    assert.equal(result, toolA);
  });

  it('returns null for multi-element array without name', () => {
    const result = resolveToolFromExport([toolA, toolB]);
    assert.equal(result, null);
  });

  it('returns null for non-tool values', () => {
    assert.equal(resolveToolFromExport(null), null);
    assert.equal(resolveToolFromExport('string'), null);
    assert.equal(resolveToolFromExport(42), null);
  });
});

describe('resolveAllToolsFromExport', () => {
  const toolA = tool({
    name: 'alpha',
    description: 'Alpha',
    params: { x: z.number() },
    handler: () => ({}),
  });

  const toolB = tool({
    name: 'beta',
    description: 'Beta',
    params: { y: z.string() },
    handler: () => ({}),
  });

  it('wraps a single tool in an array', () => {
    const result = resolveAllToolsFromExport(toolA);
    assert.equal(result.length, 1);
    assert.equal(result[0], toolA);
  });

  it('returns all tools from an array export', () => {
    const result = resolveAllToolsFromExport([toolA, toolB]);
    assert.equal(result.length, 2);
    assert.equal(result[0], toolA);
    assert.equal(result[1], toolB);
  });

  it('filters out non-tool items from array', () => {
    const result = resolveAllToolsFromExport([toolA, 'not a tool', 42, toolB]);
    assert.equal(result.length, 2);
  });

  it('returns empty array for non-tool values', () => {
    assert.deepEqual(resolveAllToolsFromExport(null), []);
    assert.deepEqual(resolveAllToolsFromExport('string'), []);
  });
});
