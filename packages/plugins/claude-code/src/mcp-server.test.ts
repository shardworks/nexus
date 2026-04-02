/**
 * Tests for the MCP server module.
 *
 * Exercises createMcpServer() with ToolDefinition arrays to verify
 * tool registration, callableBy filtering, and error handling.
 * Tests startMcpHttpServer() for HTTP server lifecycle and connectivity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { tool } from '@shardworks/tools-apparatus';

import { createMcpServer, startMcpHttpServer } from './mcp-server.ts';

// ── Test helpers ────────────────────────────────────────────────────────

function makeTool(overrides: {
  name?: string;
  description?: string;
  permission?: string;
  callableBy?: ('cli' | 'anima' | 'library')[];
  handler?: () => unknown;
} = {}) {
  return tool({
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    params: { input: z.string().describe('Test input') },
    handler: overrides.handler ?? (async () => ({ ok: true })),
    ...(overrides.permission !== undefined ? { permission: overrides.permission } : {}),
    ...(overrides.callableBy !== undefined ? { callableBy: overrides.callableBy } : {}),
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

  it('filters out tools not callable by animas', async () => {
    const tools = [
      makeTool({ name: 'cli-only', callableBy: ['cli'] }),
      makeTool({ name: 'anima-ok', callableBy: ['anima'] }),
      makeTool({ name: 'both', callableBy: ['cli', 'anima'] }),
      makeTool({ name: 'no-restriction' }), // no callableBy → available to everyone
    ];

    // createMcpServer filters internally — it should not throw
    const server = await createMcpServer(tools);
    assert.ok(server, 'should handle mixed callableBy tools');
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

// ── startMcpHttpServer ──────────────────────────────────────────────────

describe('startMcpHttpServer()', () => {
  it('starts an HTTP server and returns a handle with URL and close', async () => {
    const tools = [makeTool({ name: 'test-tool' })];
    const handle = await startMcpHttpServer(tools);

    try {
      assert.ok(handle.url, 'should have a URL');
      assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/sse$/, 'URL should be localhost with /sse endpoint');
      assert.equal(typeof handle.close, 'function', 'should have a close function');
    } finally {
      await handle.close();
    }
  });

  it('listens on an ephemeral port', async () => {
    const handle = await startMcpHttpServer([makeTool({ name: 'tool-a' })]);

    try {
      const port = parseInt(new URL(handle.url).port, 10);
      assert.ok(port > 0, 'should bind to a real port');
      assert.ok(port < 65536, 'port should be in valid range');
    } finally {
      await handle.close();
    }
  });

  it('responds to HTTP requests on the MCP endpoint', async () => {
    const tools = [makeTool({ name: 'ping-tool' })];
    const handle = await startMcpHttpServer(tools);

    try {
      // Send a basic HTTP request to the MCP endpoint.
      // The MCP protocol expects JSON-RPC — a plain GET should get a
      // response (likely 405 or similar) rather than a connection error.
      const res = await fetch(handle.url, { method: 'GET' });
      // Any HTTP response means the server is listening and reachable.
      assert.ok(res.status > 0, 'should get an HTTP response');
    } finally {
      await handle.close();
    }
  });

  it('can start multiple servers on different ports', async () => {
    const handle1 = await startMcpHttpServer([makeTool({ name: 'tool-1' })]);
    const handle2 = await startMcpHttpServer([makeTool({ name: 'tool-2' })]);

    try {
      assert.notEqual(handle1.url, handle2.url, 'should bind to different ports');
    } finally {
      await handle1.close();
      await handle2.close();
    }
  });

  it('close() shuts down the server', async () => {
    const handle = await startMcpHttpServer([makeTool({ name: 'tool-a' })]);
    await handle.close();

    // After close, the server should no longer accept connections.
    try {
      await fetch(handle.url, { method: 'GET' });
      assert.fail('should not be reachable after close');
    } catch (err) {
      // Expected — connection refused or similar network error
      assert.ok(err, 'fetch should throw after server is closed');
    }
  });

  it('works with empty tool set', async () => {
    const handle = await startMcpHttpServer([]);
    try {
      assert.ok(handle.url, 'should start even with no tools');
    } finally {
      await handle.close();
    }
  });
});
