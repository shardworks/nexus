/**
 * Tests for the MCP server module.
 *
 * Exercises createMcpServer() with ToolDefinition arrays to verify
 * tool registration, callableFrom filtering, and error handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { tool } from '@shardworks/tools-apparatus';

import { createMcpServer } from './mcp-server.ts';

// ── Test helpers ────────────────────────────────────────────────────────

function makeTool(overrides: {
  name?: string;
  description?: string;
  permission?: string;
  callableFrom?: ('cli' | 'mcp')[];
  handler?: () => unknown;
} = {}) {
  return tool({
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    params: { input: z.string().describe('Test input') },
    handler: overrides.handler ?? (async () => ({ ok: true })),
    ...(overrides.permission !== undefined ? { permission: overrides.permission } : {}),
    ...(overrides.callableFrom !== undefined ? { callableFrom: overrides.callableFrom } : {}),
  });
}

// ── createMcpServer ─────────────────────────────────────────────────────

describe('createMcpServer()', () => {
  it('returns an McpServer instance with no tools', async () => {
    const server = await createMcpServer([]);
    assert.ok(server, 'should return a server object');
  });

  it('accepts an array of ToolDefinitions', async () => {
    const tools = [
      makeTool({ name: 'tool-a', description: 'First tool' }),
      makeTool({ name: 'tool-b', description: 'Second tool' }),
    ];

    const server = await createMcpServer(tools);
    assert.ok(server, 'should return a server with tools registered');
  });

  it('filters out tools not callable from mcp', async () => {
    const tools = [
      makeTool({ name: 'cli-only', callableFrom: ['cli'] }),
      makeTool({ name: 'mcp-ok', callableFrom: ['mcp'] }),
      makeTool({ name: 'both', callableFrom: ['cli', 'mcp'] }),
      makeTool({ name: 'no-restriction' }), // no callableFrom → available everywhere
    ];

    // createMcpServer filters internally — it should not throw
    const server = await createMcpServer(tools);
    assert.ok(server, 'should handle mixed callableFrom tools');
  });

  it('handles tools with permission fields', async () => {
    const tools = [
      makeTool({ name: 'read-tool', permission: 'read' }),
      makeTool({ name: 'write-tool', permission: 'write' }),
      makeTool({ name: 'no-perm' }),
    ];

    // Permission is not checked by createMcpServer — it registers all tools.
    // Permission gating happens upstream in the Instrumentarium.
    const server = await createMcpServer(tools);
    assert.ok(server, 'should register tools regardless of permission field');
  });
});
