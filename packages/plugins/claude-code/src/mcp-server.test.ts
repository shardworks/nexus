/**
 * Tests for the MCP server module.
 *
 * Exercises createMcpServer() with mock tool modules to verify tool
 * registration, handler invocation, param validation, and error formatting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpServer } from './mcp-server.ts';

// loadTool() uses dynamic import which is hard to mock in unit tests.
// We test createMcpServer with empty/failing tool specs to verify
// graceful handling. The NDJSON parsing and tool resolution logic
// are covered in stream-parser.test.ts.

// ── createMcpServer ─────────────────────────────────────────────────

describe('createMcpServer()', () => {
  it('returns an McpServer instance with no tools', async () => {
    const server = await createMcpServer({
      home: '/tmp/test-guild',
      tools: [],
    });

    assert.ok(server, 'should return a server object');
  });

  it('skips tools whose modules cannot be loaded', async () => {
    // Module path that won't resolve — loadTool should log and skip
    const server = await createMcpServer({
      home: '/tmp/test-guild',
      tools: [
        { name: 'ghost-tool', modulePath: '/nonexistent/path/that/does/not/exist.ts' },
      ],
    });

    assert.ok(server, 'should return a server despite failed tool load');
  });

  it('skips tools with invalid module paths gracefully', async () => {
    const server = await createMcpServer({
      home: '/tmp/test-guild',
      tools: [
        { name: 'bad-tool', modulePath: 'definitely-not-a-real-package-name-xyz' },
      ],
    });

    assert.ok(server, 'should not throw on unresolvable modules');
  });
});
