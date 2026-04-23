import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import path from 'node:path';
import { toFlag, isBooleanSchema, isRepeatableSchema, findGroupPrefixes, coerceCliOpts, resolveGuildRoot } from './helpers.ts';
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

describe('isRepeatableSchema', () => {
  it('detects z.array(z.string())', () => {
    assert.ok(isRepeatableSchema(z.array(z.string())));
  });

  it('detects z.array().optional()', () => {
    assert.ok(isRepeatableSchema(z.array(z.string()).optional()));
  });

  it('detects union with array branch', () => {
    const schema = z.union([z.string(), z.array(z.string())]);
    assert.ok(isRepeatableSchema(schema));
  });

  it('detects optional union with array branch (writ-list status shape)', () => {
    const schema = z.union([
      z.enum(['ready', 'active', 'waiting']),
      z.array(z.enum(['ready', 'active', 'waiting'])).min(1),
    ]).optional();
    assert.ok(isRepeatableSchema(schema));
  });

  it('rejects plain z.string()', () => {
    assert.ok(!isRepeatableSchema(z.string()));
  });

  it('rejects z.enum()', () => {
    assert.ok(!isRepeatableSchema(z.enum(['a', 'b'])));
  });

  it('rejects z.number().optional()', () => {
    assert.ok(!isRepeatableSchema(z.number().optional()));
  });

  it('rejects z.boolean()', () => {
    assert.ok(!isRepeatableSchema(z.boolean()));
  });

  it('rejects union without array branch', () => {
    const schema = z.union([z.string(), z.number()]);
    assert.ok(!isRepeatableSchema(schema));
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

  // Repeatable schema coercion
  it('converts empty array to undefined for repeatable schema', () => {
    const shape = {
      status: z.union([z.enum(['a', 'b']), z.array(z.enum(['a', 'b']))]).optional(),
    };
    assert.deepEqual(coerceCliOpts(shape, { status: [] }), { status: undefined });
  });

  it('passes non-empty array through unchanged for repeatable schema', () => {
    const shape = {
      status: z.union([z.enum(['a', 'b']), z.array(z.enum(['a', 'b']))]).optional(),
    };
    assert.deepEqual(coerceCliOpts(shape, { status: ['a', 'b'] }), { status: ['a', 'b'] });
  });

  it('passes single-element array through unchanged for repeatable schema', () => {
    const shape = {
      status: z.union([z.enum(['a', 'b']), z.array(z.enum(['a', 'b']))]).optional(),
    };
    assert.deepEqual(coerceCliOpts(shape, { status: ['a'] }), { status: ['a'] });
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
  it('generates non-mandatory option for sole required string id param (positional convention)', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({ id: z.string().describe('The id') }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const option = cmd.options.find((o) => o.long === '--id');
    assert.ok(option, '--id option should exist');
    // With the positional convention, --id becomes optional since the positional can provide it
    assert.ok(!option.mandatory, '--id should not be mandatory when positional convention applies');
  });

  it('generates mandatory option for required string param that does not match positional convention', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'A test tool',
      params: z.object({ name: z.string().describe('The name') }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    const option = cmd.options.find((o) => o.long === '--name');
    assert.ok(option, '--name option should exist');
    assert.ok(option.mandatory, '--name should be mandatory (not named id or ending in Id)');
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

  it('collects repeated --status flags into an array', async () => {
    let captured: Record<string, unknown> | undefined;

    const statuses = z.enum(['ready', 'active', 'waiting', 'completed']);
    const tool: ToolDefinition = {
      name: 'writ-list',
      description: 'List writs',
      params: z.object({
        status: z.union([statuses, z.array(statuses).min(1)])
          .optional()
          .describe('Filter by status (repeatable)'),
        type: z.string().optional().describe('Filter by type'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('list', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--status', 'ready', '--status', 'active', '--status', 'waiting'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.deepEqual(captured['status'], ['ready', 'active', 'waiting']);
  });

  it('passes single --status as single-element array', async () => {
    let captured: Record<string, unknown> | undefined;

    const statuses = z.enum(['ready', 'active', 'waiting', 'completed']);
    const tool: ToolDefinition = {
      name: 'writ-list',
      description: 'List writs',
      params: z.object({
        status: z.union([statuses, z.array(statuses).min(1)])
          .optional()
          .describe('Filter by status (repeatable)'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('list', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--status', 'ready'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.deepEqual(captured['status'], ['ready']);
  });

  it('omitting repeatable --status passes undefined to handler', async () => {
    let captured: Record<string, unknown> | undefined;

    const statuses = z.enum(['ready', 'active', 'waiting', 'completed']);
    const tool: ToolDefinition = {
      name: 'writ-list',
      description: 'List writs',
      params: z.object({
        status: z.union([statuses, z.array(statuses).min(1)])
          .optional()
          .describe('Filter by status (repeatable)'),
        type: z.string().optional().describe('Filter by type'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('list', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--type', 'epic'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['status'], undefined);
    assert.equal(captured['type'], 'epic');
  });

  it('shows repeatable --status in help text', () => {
    const statuses = z.enum(['ready', 'active', 'waiting']);
    const tool: ToolDefinition = {
      name: 'writ-list',
      description: 'List writs',
      params: z.object({
        status: z.union([statuses, z.array(statuses).min(1)])
          .optional()
          .describe('Filter by status (repeatable)'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('list', tool);
    const helpText = cmd.helpInformation();
    assert.ok(helpText.includes('--status'), 'help should mention --status');
    assert.ok(helpText.includes('repeatable'), 'help should indicate repeatable');
  });

  // ── Positional ID convention ──────────────────────────────────

  it('detects sole required string param named "id" as positional', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-show',
      description: 'Show a click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('show', tool);
    cmd.exitOverride();
    // Positional usage: nsg click show <id>
    await cmd.parseAsync(['c-abc123'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'c-abc123');
  });

  it('positional id works alongside --id flag', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-show',
      description: 'Show a click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('show', tool);
    cmd.exitOverride();
    // Flag usage still works
    await cmd.parseAsync(['--id', 'c-abc123'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'c-abc123');
  });

  it('--id flag takes precedence over positional', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-show',
      description: 'Show a click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('show', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--id', 'c-flag', 'c-positional'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'c-flag');
  });

  it('detects param ending with Id as positional', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'Test',
      params: z.object({
        writId: z.string().describe('Writ ID'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('test', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['w-abc123'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['writId'], 'w-abc123');
  });

  it('does not add positional when tool has multiple id-like required string params', () => {
    // sourceId + targetId both end with "Id" — the positional convention
    // is ambiguous and should be skipped.
    const tool: ToolDefinition = {
      name: 'click-link',
      description: 'Link two clicks',
      params: z.object({
        sourceId: z.string().describe('Source click ID'),
        targetId: z.string().describe('Target click ID'),
        linkType: z.enum(['related', 'commissioned']).describe('Link type'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('link', tool);
    // Should have no positional argument registered
    assert.equal(cmd.registeredArguments.length, 0);
  });

  it('adds positional for id when other required params are not id-like', async () => {
    // `click-amend` / `click-conclude` / `click-drop` shape: a single id-like
    // required param (`id`) plus other required strings (`goal`, `conclusion`).
    // The id should still promote to the positional slot.
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-amend',
      description: 'Amend the goal of a live click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
        goal: z.string().describe('New goal text'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('amend', tool);

    // Both the id option and the positional argument should be registered.
    const idOption = cmd.options.find((o) => o.long === '--id');
    assert.ok(idOption, '--id option should exist');
    assert.ok(!idOption.mandatory, '--id should be non-mandatory when positional is available');
    assert.equal(cmd.registeredArguments.length, 1);

    // Positional form: `click amend c-abc123 --goal "..."`
    cmd.exitOverride();
    await cmd.parseAsync(['c-abc123', '--goal', 'Refined'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'c-abc123');
    assert.equal(captured['goal'], 'Refined');
  });

  it('flag form continues to work for id-plus-extra-required shape', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-amend',
      description: 'Amend the goal of a live click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
        goal: z.string().describe('New goal text'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('amend', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['--id', 'c-abc123', '--goal', 'Refined'], { from: 'user' });

    assert.ok(captured);
    assert.equal(captured['id'], 'c-abc123');
    assert.equal(captured['goal'], 'Refined');
  });

  it('does not add positional when required string param is not named id/Id', () => {
    const tool: ToolDefinition = {
      name: 'test-tool',
      description: 'Test',
      params: z.object({
        name: z.string().describe('Name'),
      }),
      handler: async () => null,
    };

    const cmd = buildToolCommand('test', tool);
    assert.equal(cmd.registeredArguments.length, 0);
  });

  it('positional works for tool with id plus optional params', async () => {
    let captured: Record<string, unknown> | undefined;

    const tool: ToolDefinition = {
      name: 'click-park',
      description: 'Park a click',
      params: z.object({
        id: z.string().describe('Click ID or prefix'),
      }),
      handler: async (params) => { captured = params as Record<string, unknown>; return null; },
    };

    const cmd = buildToolCommand('park', tool);
    cmd.exitOverride();
    await cmd.parseAsync(['c-abc123'], { from: 'user' });

    assert.ok(captured, 'handler should have been called');
    assert.equal(captured['id'], 'c-abc123');
  });
});
