import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import path from 'node:path';
import { toFlag, isBooleanSchema, findGroupPrefixes, coerceCliOpts, resolveGuildRoot } from './helpers.ts';
import { buildToolCommand } from './program.ts';
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

// ── resolveGuildRoot ──────────────────────────────────────────────────

describe('resolveGuildRoot', () => {
  const autoDetect = () => '/auto/detected';
  const autoDetectThrows = () => { throw new Error('no guild found'); };

  it('prefers --guild-root CLI flag over everything else', () => {
    const result = resolveGuildRoot('/cli/path', '/env/path', autoDetect);
    assert.equal(result, path.resolve('/cli/path'));
  });

  it('falls back to GUILD_ROOT env var when CLI flag is undefined', () => {
    const result = resolveGuildRoot(undefined, '/env/path', autoDetect);
    assert.equal(result, path.resolve('/env/path'));
  });

  it('falls back to auto-detect when both CLI flag and env var are undefined', () => {
    const result = resolveGuildRoot(undefined, undefined, autoDetect);
    assert.equal(result, '/auto/detected');
  });

  it('resolves relative CLI flag path to absolute', () => {
    const result = resolveGuildRoot('relative/guild', undefined, autoDetect);
    assert.equal(result, path.resolve('relative/guild'));
  });

  it('resolves relative GUILD_ROOT env var path to absolute', () => {
    const result = resolveGuildRoot(undefined, 'relative/guild', autoDetect);
    assert.equal(result, path.resolve('relative/guild'));
  });

  it('returns undefined when auto-detect throws and no explicit root given', () => {
    const result = resolveGuildRoot(undefined, undefined, autoDetectThrows);
    assert.equal(result, undefined);
  });

  it('CLI flag takes precedence even when env var is set', () => {
    const result = resolveGuildRoot('/cli', '/env', autoDetectThrows);
    assert.equal(result, path.resolve('/cli'));
  });

  it('env var is used even when auto-detect would throw', () => {
    const result = resolveGuildRoot(undefined, '/env', autoDetectThrows);
    assert.equal(result, path.resolve('/env'));
  });
});

// ── buildToolCommand ────────────────────────────────────────────────

describe('buildToolCommand', () => {
  it('generates mandatory option for non-optional string param', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({ id: z.string().describe('The id') }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const option = cmd.options.find((o) => o.long === '--id');
    assert.ok(option, '--id option should exist');
    assert.ok(option.mandatory, '--id should be mandatory');
  });

  it('generates non-mandatory flags for optional string params', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({
        id: z.string().describe('Writ id'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const titleOpt = cmd.options.find((o) => o.long === '--title');
    const bodyOpt = cmd.options.find((o) => o.long === '--body');

    assert.ok(titleOpt, '--title option should exist');
    assert.ok(bodyOpt, '--body option should exist');
    assert.ok(!titleOpt.mandatory, '--title should not be mandatory');
    assert.ok(!bodyOpt.mandatory, '--body should not be mandatory');
  });

  it('generates all flags for a writ-edit-shaped tool (id, title, body, type, codex)', () => {
    const tool: ToolDefinition = {
      name: 'writ-edit',
      description: 'Edit a writ',
      params: z.object({
        id: z.string().describe('Writ id'),
        title: z.string().optional().describe('New title for the writ'),
        body: z.string().optional().describe('New body text for the writ'),
        type: z.string().optional().describe('New writ type'),
        codex: z.string().optional().describe('New target codex name'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('edit', tool);
    const optionNames = cmd.options.map((o) => o.long);

    assert.ok(optionNames.includes('--id'), 'should have --id');
    assert.ok(optionNames.includes('--title'), 'should have --title');
    assert.ok(optionNames.includes('--body'), 'should have --body');
    assert.ok(optionNames.includes('--type'), 'should have --type');
    assert.ok(optionNames.includes('--codex'), 'should have --codex');
    assert.equal(cmd.options.length, 5, 'should have exactly 5 options');
  });

  it('generates boolean flags without <value> placeholder', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({
        verbose: z.boolean().optional().describe('Verbose output'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const opt = cmd.options.find((o) => o.long === '--verbose');
    assert.ok(opt, '--verbose option should exist');
    // Boolean flags don't have a mandatory argument
    assert.ok(!opt.required, '--verbose should not be required');
  });

  it('converts camelCase params to kebab-case flags', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({
        writId: z.string().describe('The writ id'),
        guildRoot: z.string().optional().describe('Guild root directory'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const optionNames = cmd.options.map((o) => o.long);

    assert.ok(optionNames.includes('--writ-id'), 'writId should become --writ-id');
    assert.ok(optionNames.includes('--guild-root'), 'guildRoot should become --guild-root');
  });

  it('uses Zod description as option description', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({
        title: z.string().optional().describe('New title for the writ'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const opt = cmd.options.find((o) => o.long === '--title');
    assert.ok(opt, '--title option should exist');
    assert.equal(opt.description, 'New title for the writ');
  });

  it('parses --title from argv and passes it to the handler', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'writ-edit',
      description: 'Edit a writ',
      params: z.object({
        id: z.string().describe('Writ id'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('edit', tool);
    cmd.exitOverride(); // prevent process.exit
    await cmd.parseAsync(['--id', 'w-123', '--title', 'Hello world'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'w-123');
    assert.equal(captured['title'], 'Hello world');
    assert.equal(captured['body'], undefined);
  });

  it('parses --body without --title', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'writ-edit',
      description: 'Edit a writ',
      params: z.object({
        id: z.string().describe('Writ id'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('edit', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--id', 'w-456', '--body', 'Some body text'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'w-456');
    assert.equal(captured['title'], undefined);
    assert.equal(captured['body'], 'Some body text');
  });

  it('parses both --title and --body together', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'writ-edit',
      description: 'Edit a writ',
      params: z.object({
        id: z.string().describe('Writ id'),
        title: z.string().optional().describe('New title'),
        body: z.string().optional().describe('New body'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('edit', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--id', 'w-789', '--title', 'My Title', '--body', 'My Body'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'w-789');
    assert.equal(captured['title'], 'My Title');
    assert.equal(captured['body'], 'My Body');
  });
});
