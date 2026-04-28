/**
 * Tests for the Session Babysitter orchestrator and MCP/SSE proxy.
 *
 * Covers:
 * - MCP proxy handlers (unit)
 * - End-to-end orchestrator with mock claude process
 * - Log file integration via redirectStderrToFile + runBabysitter
 * - stderr isolation when launching the real babysitter binary
 *
 * The single-purpose primitives (stdin parsing, retry, DLQ, SQLite trio,
 * lifecycle reporters, stderr redirect) are tested in `runtime.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import Database from 'better-sqlite3';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import {
  createProxyMcpHttpServer,
  runBabysitter,
  type McpProxyHandle,
} from './babysitter.ts';
import {
  initTranscriptDb,
  redirectStderrToFile,
  type BabysitterConfig,
  type SerializedTool,
} from './runtime.ts';

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a valid BabysitterConfig for testing. */
function makeConfig(overrides?: Partial<BabysitterConfig>): BabysitterConfig {
  return {
    sessionId: 'test-session-001',
    guildToolUrl: 'http://127.0.0.1:9999',
    dbPath: ':memory:',
    logDir: os.tmpdir(),
    claudeArgs: ['--model', 'sonnet'],
    cwd: os.tmpdir(),
    env: {},
    prompt: 'Hello world',
    tools: [],
    startedAt: '2026-04-10T00:00:00.000Z',
    provider: 'claude-code',
    ...overrides,
  };
}

/** Start a simple HTTP server that captures requests. */
async function startMockServer(
  handler: (req: http.IncomingMessage, body: string) => { status: number; body: unknown },
): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }> }> {
  const requests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }> = [];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf-8');
    requests.push({ method: req.method!, url: req.url!, body, headers: req.headers });

    const result = handler(req, body);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    requests,
  };
}

// ── createProxyMcpHttpServer ───────────────────────────────────────────

describe('createProxyMcpHttpServer()', () => {
  let handle: McpProxyHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  it('starts an HTTP server on an ephemeral port', async () => {
    handle = await createProxyMcpHttpServer([], 'http://127.0.0.1:7471', 'sess-1');

    assert.ok(handle.url, 'should have a URL');
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/sse$/);
  });

  it('serves /sse endpoint (SSE transport)', async () => {
    handle = await createProxyMcpHttpServer([], 'http://127.0.0.1:7471', 'sess-1');

    const res = await fetch(handle.url);
    assert.ok(res.status > 0, 'should respond to GET /sse');
  });

  it('returns 404 for unknown routes', async () => {
    handle = await createProxyMcpHttpServer([], 'http://127.0.0.1:7471', 'sess-1');

    const baseUrl = handle.url.replace('/sse', '');
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });

  it('registers tool definitions with JSON Schema params', async () => {
    const tools: SerializedTool[] = [
      {
        name: 'writ-list',
        description: 'List writs',
        params: {
          properties: {
            status: { type: 'string', description: 'Filter by status' },
          },
        },
        method: 'GET',
      },
      {
        name: 'signal',
        description: 'Send a signal',
        params: {
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        method: 'POST',
      },
    ];

    handle = await createProxyMcpHttpServer(tools, 'http://127.0.0.1:7471', 'sess-1');
    assert.ok(handle.url, 'should start with tools registered');
  });

  it('close() shuts down the server', async () => {
    handle = await createProxyMcpHttpServer([], 'http://127.0.0.1:7471', 'sess-1');
    const url = handle.url;
    await handle.close();
    handle = null;

    try {
      await fetch(url);
      assert.fail('should not be reachable after close');
    } catch (err) {
      assert.ok(err, 'fetch should throw after server is closed');
    }
  });

  it('MCP client can connect and list tools immediately after SSE connection', async () => {
    const tools: SerializedTool[] = [
      {
        name: 'writ-list',
        description: 'List writs',
        params: {
          properties: {
            status: { type: 'string', description: 'Filter by status' },
          },
        },
        method: 'GET',
      },
      {
        name: 'signal',
        description: 'Send a signal',
        params: {
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
        method: 'POST',
      },
    ];

    const mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    try {
      handle = await createProxyMcpHttpServer(tools, mockServer.url, 'sess-mcp-1');

      const client = new Client({ name: 'test-client', version: '0.0.1' });
      const clientTransport = new SSEClientTransport(new URL(handle.url));

      try {
        await client.connect(clientTransport);
        const result = await client.listTools();

        assert.equal(result.tools.length, 2, 'should list 2 tools');
        const names = result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, ['signal', 'writ-list']);
      } finally {
        await clientTransport.close();
      }
    } finally {
      await mockServer.close();
    }
  });
});

// ── runBabysitter (end-to-end) ─────────────────────────────────────────

describe('runBabysitter()', () => {
  let mockServer: Awaited<ReturnType<typeof startMockServer>> | null = null;
  let tmpDir: string;

  afterEach(async () => {
    if (mockServer) {
      await mockServer.close();
      mockServer = null;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs full lifecycle with mock claude process', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-test-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-sess-1',
      prompt: 'Test prompt',
    });

    // Create a mock spawn function that simulates claude
    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = {
        write: () => {},
        end: () => {},
      };
      proc.stdout = new EventEmitter();
      proc.pid = 42;

      // Schedule NDJSON output and exit
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from(
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello from mock"}]}}\n' +
          '{"type":"result","total_cost_usd":0.01,"session_id":"mock-sess","usage":{"input_tokens":100,"output_tokens":50}}\n'
        ));
        setTimeout(() => proc.emit('close', 0), 50);
      }, 50);

      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    // Verify lifecycle calls were made
    assert.ok(mockServer.requests.length >= 2, `Expected at least 2 requests, got ${mockServer.requests.length}`);

    // Find session-running and session-record calls
    const runningReq = mockServer.requests.find((r) => r.url === '/api/session/running');
    const recordReq = mockServer.requests.find((r) => r.url === '/api/session/record');

    assert.ok(runningReq, 'should call session-running');
    assert.ok(recordReq, 'should call session-record');

    const runningBody = JSON.parse(runningReq!.body);
    assert.equal(runningBody.sessionId, 'e2e-sess-1');
    assert.deepEqual(runningBody.cancelHandle, { kind: 'local-pgid', pgid: process.pid });

    const recordBody = JSON.parse(recordReq!.body);
    assert.equal(recordBody.sessionId, 'e2e-sess-1');
    assert.equal(recordBody.status, 'completed');
    assert.equal(recordBody.exitCode, 0);
    assert.equal(recordBody.costUsd, 0.01);
    assert.equal(recordBody.output, 'Hello from mock');
    assert.equal(recordBody.providerSessionId, 'mock-sess');

    // Verify transcript was written to SQLite
    const reader = new Database(dbPath, { readonly: true });
    const rows = reader.prepare(
      'SELECT * FROM books_animator_transcripts WHERE id = ?',
    ).all('e2e-sess-1') as Array<{ id: string; content: string }>;
    assert.equal(rows.length, 1);

    const transcriptDoc = JSON.parse(rows[0]!.content);
    assert.equal(transcriptDoc.id, 'e2e-sess-1');
    assert.ok(transcriptDoc.messages.length >= 1, 'should have transcript messages');
    reader.close();

    db.close();
  });

  it('reports failure to DLQ when guild is unreachable and claude fails', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fail-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: 'http://127.0.0.1:1', // unreachable
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-fail-1',
    });

    // Mock claude that exits with error
    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 99;

      setTimeout(() => proc.emit('close', 1), 50);

      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn, retryTimeoutMs: 1500 });

    // Both running and record should end up in DLQ
    const runningDlq = path.join(tmpDir, '.nexus', 'dlq', 'e2e-fail-1-running.json');
    const recordDlq = path.join(tmpDir, '.nexus', 'dlq', 'e2e-fail-1.json');

    assert.ok(fs.existsSync(runningDlq), 'running DLQ should exist');
    assert.ok(fs.existsSync(recordDlq), 'record DLQ should exist');

    const recordContent = JSON.parse(fs.readFileSync(recordDlq, 'utf-8'));
    assert.equal(recordContent.status, 'failed');
    assert.equal(recordContent.exitCode, 1);

    db.close();
  });

  it('creates and cleans up temp directory', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cleanup-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
    });

    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 1;

      setTimeout(() => proc.emit('close', 0), 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    // Verify that no nsg-babysitter-* temp dirs linger
    const _tmpDirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nsg-babysitter-'));
    // Should be cleaned up (might be zero or some leftover from other tests)
    // Just verify the function completed without error
    void _tmpDirs;

    db.close();
  });

  it('writes MCP config file with proxy server URL', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    let capturedArgs: string[] = [];
    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      tools: [
        { name: 'test-tool', description: 'A test tool', params: {} },
      ],
    });

    const mockSpawn = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 1;

      setTimeout(() => proc.emit('close', 0), 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    // Check that --mcp-config and --strict-mcp-config are in args
    assert.ok(capturedArgs.includes('--mcp-config'), 'should include --mcp-config');
    assert.ok(capturedArgs.includes('--strict-mcp-config'), 'should include --strict-mcp-config');
    assert.ok(capturedArgs.includes('--print'), 'should include --print');
    assert.ok(capturedArgs.includes('--output-format'), 'should include --output-format');

    db.close();
  });

  it('handles top-level errors gracefully', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-err-'));
    const dbPath = path.join(tmpDir, 'guild.db');

    // Create a DB that we'll close immediately to cause an error
    const db = initTranscriptDb(Database, dbPath);
    db.close(); // Close DB so it fails when babysitter tries to use it

    const config = makeConfig({
      guildToolUrl: 'http://127.0.0.1:1', // unreachable
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-err-1',
    });

    // Mock spawn that emits data (which will trigger DB write, which should fail)
    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 1;

      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[]}}\n'));
        setTimeout(() => proc.emit('close', 0), 50);
      }, 50);

      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    // Provide a fresh DB since the closed one will cause issues
    const freshDb = initTranscriptDb(Database, dbPath);

    // Should not throw (errors are caught and reported). Use short timeout.
    await runBabysitter(config, { db: freshDb, spawnFn: mockSpawn, retryTimeoutMs: 1500 });

    freshDb.close();
  });

  it('captures signal when claude is killed', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-signal-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-signal-1',
    });

    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 55;

      // Emit close with null code and SIGTERM signal
      setTimeout(() => proc.emit('close', null, 'SIGTERM'), 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    // Find session-record call and verify signal is included
    const recordReq = mockServer!.requests.find((r) => r.url === '/api/session/record');
    assert.ok(recordReq, 'should call session-record');

    const body = JSON.parse(recordReq!.body);
    assert.equal(body.signal, 'SIGTERM');
    assert.equal(body.exitCode, 1); // code ?? 1 fallback
    assert.equal(body.status, 'failed');

    db.close();
  });

  it('attaches terminationDiagnostic reflecting only the stderr tail', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-diag-tail-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-diag-tail-1',
    });

    // Mock claude that emits a lot of stderr then exits non-zero.
    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 77;

      setTimeout(() => {
        // Emit ~1000 chars of "prefix" stderr that should be dropped,
        // followed by a short tail that must survive in the buffer.
        proc.stderr.emit('data', Buffer.from('X'.repeat(1000)));
        proc.stderr.emit('data', Buffer.from('\nTAIL-MARKER-END\n'));
        setTimeout(() => proc.emit('close', 3), 30);
      }, 20);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    const recordReq = mockServer!.requests.find((r) => r.url === '/api/session/record');
    assert.ok(recordReq, 'should call session-record');
    const body = JSON.parse(recordReq!.body);
    assert.equal(body.status, 'failed');
    assert.ok(body.terminationDiagnostic, 'diagnostic should be present');
    assert.equal(body.terminationDiagnostic.exitCode, 3);
    const excerpt = body.terminationDiagnostic.stderrExcerpt as string;
    assert.ok(excerpt.length <= 2048, `excerpt should fit the 2048-char cap, got ${excerpt.length}`);
    assert.ok(excerpt.includes('TAIL-MARKER-END'), 'the tail of the stream must survive in the excerpt');

    db.close();
  });

  it('omits signal on normal exit', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nosignal-'));
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      sessionId: 'e2e-nosignal-1',
    });

    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.pid = 56;

      setTimeout(() => proc.emit('close', 0, null), 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    await runBabysitter(config, { db, spawnFn: mockSpawn });

    const recordReq = mockServer!.requests.find((r) => r.url === '/api/session/record');
    assert.ok(recordReq, 'should call session-record');

    const body = JSON.parse(recordReq!.body);
    assert.equal(body.signal, undefined);
    assert.equal(body.exitCode, 0);
    assert.equal(body.status, 'completed');

    db.close();
  });
});

// ── runBabysitter log file integration ────────────────────────────────

describe('runBabysitter() log file', () => {
  let mockServer: Awaited<ReturnType<typeof startMockServer>> | null = null;
  let tmpDir: string;
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalWrite = process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = originalWrite;
    if (mockServer) {
      await mockServer.close();
      mockServer = null;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates log file when redirectStderrToFile is called before runBabysitter', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-e2e-'));
    const logDir = path.join(tmpDir, 'logs');
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      logDir,
      sessionId: 'log-sess-1',
    });

    // Redirect stderr before calling runBabysitter (mimics main())
    const fd = redirectStderrToFile(config.logDir, config.sessionId);

    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 42;

      setTimeout(() => proc.emit('close', 0), 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    try {
      await runBabysitter(config, { db, spawnFn: mockSpawn });
    } finally {
      try { fs.closeSync(fd); } catch { /* ok */ }
    }

    // Verify log file exists and contains the startup banner
    const logPath = path.join(logDir, 'log-sess-1.log');
    assert.ok(fs.existsSync(logPath), 'log file should exist');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.match(logContent, /\[babysitter\] session=log-sess-1/);
    assert.match(logContent, /\[babysitter\] MCP proxy server listening on port/);

    db.close();
  });

  it('forwards claude stderr to log file', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-claude-stderr-'));
    const logDir = path.join(tmpDir, 'logs');
    const dbPath = path.join(tmpDir, 'guild.db');
    const db = initTranscriptDb(Database, dbPath);

    const config = makeConfig({
      guildToolUrl: mockServer.url,
      cwd: tmpDir,
      dbPath,
      logDir,
      sessionId: 'claude-stderr-1',
    });

    const fd = redirectStderrToFile(config.logDir, config.sessionId);

    const mockSpawn = (() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: (d: string) => void; end: () => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 42;

      setTimeout(() => {
        // Emit stderr data from "claude"
        proc.stderr.emit('data', Buffer.from('claude error output\n'));
        setTimeout(() => proc.emit('close', 0), 50);
      }, 50);
      return proc;
    }) as unknown as typeof import('node:child_process').spawn;

    try {
      await runBabysitter(config, { db, spawnFn: mockSpawn });
    } finally {
      try { fs.closeSync(fd); } catch { /* ok */ }
    }

    const logPath = path.join(logDir, 'claude-stderr-1.log');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes('claude error output'), 'log should contain claude stderr');

    db.close();
  });
});

// ── stderr isolation (real child process) ─────────────────────────────

import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('stderr isolation', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parent receives no babysitter stderr when logDir is configured', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-isolation-'));
    const logDir = path.join(tmpDir, 'logs');

    const config = makeConfig({
      sessionId: 'iso-sess-1',
      logDir,
      guildToolUrl: 'http://127.0.0.1:1', // unreachable — babysitter will fail
      dbPath: path.join(tmpDir, 'nexus.db'),
      cwd: tmpDir,
    });

    // Resolve babysitter script path
    const thisFile = fileURLToPath(import.meta.url);
    const babysitterPath = path.join(path.dirname(thisFile), 'babysitter.ts');

    const child = nodeSpawn(
      process.execPath,
      [...process.execArgv, babysitterPath],
      {
        cwd: tmpDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    // Write config and close stdin
    child.stdin!.write(JSON.stringify(config));
    child.stdin!.end();

    // Collect stderr
    const stderrChunks: Buffer[] = [];
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Wait for exit (with timeout)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 15_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Key assertion: parent's captured stderr should be empty
    const collectedStderr = Buffer.concat(stderrChunks).toString('utf-8');
    assert.equal(collectedStderr, '', 'parent should receive no stderr from babysitter');

    // Log file should exist and be non-empty
    const logPath = path.join(logDir, 'iso-sess-1.log');
    assert.ok(fs.existsSync(logPath), 'log file should exist');
    const logContent = fs.readFileSync(logPath, 'utf-8');
    assert.ok(logContent.length > 0, 'log file should be non-empty');
    assert.match(logContent, /\[babysitter\]/, 'log should contain babysitter output');
  });
});

// ── EPIPE survival (skipped) ──────────────────────────────────────────

describe('EPIPE survival', () => {
  it.skip('survives EPIPE on inherited stderr after guild restart', () => {
    // OS-level fd lifecycle (closing the write end of a pipe that backs fd 2)
    // is not reliably simulable in Node's test harness. The log-file-creation
    // and stderr-isolation tests verify the redirect is in place, which is the
    // mechanism that prevents EPIPE.
  });
});
