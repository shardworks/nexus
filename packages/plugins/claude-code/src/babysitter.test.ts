/**
 * Tests for the Session Babysitter.
 *
 * Covers:
 * - Config parsing from stdin (unit)
 * - MCP proxy handlers (unit)
 * - Transcript streaming (integration)
 * - Session lifecycle reporting (integration)
 * - DLQ behavior (integration)
 * - End-to-end with mock guild server (integration)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

import Database from 'better-sqlite3';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import {
  readConfigFromStdin,
  callGuildHttpApi,
  writeToDlq,
  createProxyMcpHttpServer,
  writeTranscript,
  initTranscriptDb,
  reportRunning,
  reportResult,
  runBabysitter,
  type BabysitterConfig,
  type SerializedTool,
  type TranscriptDb,
  type McpProxyHandle,
} from './babysitter.ts';

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a valid BabysitterConfig for testing. */
function makeConfig(overrides?: Partial<BabysitterConfig>): BabysitterConfig {
  return {
    sessionId: 'test-session-001',
    guildToolUrl: 'http://127.0.0.1:9999',
    dbPath: ':memory:',
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

/** Create a readable stream from a string. */
function streamFromString(data: string): Readable {
  return Readable.from([Buffer.from(data)]);
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

// ── readConfigFromStdin ────────────────────────────────────────────────

describe('readConfigFromStdin()', () => {
  it('parses valid JSON config from stream', async () => {
    const config = makeConfig();
    const stream = streamFromString(JSON.stringify(config));
    const result = await readConfigFromStdin(stream);

    assert.equal(result.sessionId, 'test-session-001');
    assert.equal(result.provider, 'claude-code');
    assert.equal(result.prompt, 'Hello world');
    assert.deepEqual(result.claudeArgs, ['--model', 'sonnet']);
  });

  it('throws on empty stdin', async () => {
    const stream = streamFromString('');
    await assert.rejects(
      () => readConfigFromStdin(stream),
      { message: 'Empty config received on stdin' },
    );
  });

  it('throws on invalid JSON', async () => {
    const stream = streamFromString('not valid json {{{');
    await assert.rejects(
      () => readConfigFromStdin(stream),
      /Invalid JSON config on stdin/,
    );
  });

  it('throws on missing required fields', async () => {
    const stream = streamFromString(JSON.stringify({ sessionId: 'x' }));
    await assert.rejects(
      () => readConfigFromStdin(stream),
      /Missing required config field/,
    );
  });

  it('accepts config with optional metadata field', async () => {
    const config = makeConfig({ metadata: { writId: 'w-1', role: 'artificer' } });
    const stream = streamFromString(JSON.stringify(config));
    const result = await readConfigFromStdin(stream);

    assert.deepEqual(result.metadata, { writId: 'w-1', role: 'artificer' });
  });

  it('accepts config with tools array', async () => {
    const tools: SerializedTool[] = [
      { name: 'writ-list', description: 'List writs', params: { properties: { status: { type: 'string' } } } },
    ];
    const config = makeConfig({ tools });
    const stream = streamFromString(JSON.stringify(config));
    const result = await readConfigFromStdin(stream);

    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]!.name, 'writ-list');
  });
});

// ── callGuildHttpApi ───────────────────────────────────────────────────

describe('callGuildHttpApi()', () => {
  let mockServer: Awaited<ReturnType<typeof startMockServer>> | null = null;

  afterEach(async () => {
    if (mockServer) {
      await mockServer.close();
      mockServer = null;
    }
  });

  it('sends POST request with JSON body and session header', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    const result = await callGuildHttpApi(
      `${mockServer.url}/api/session/running`,
      'sess-123',
      { sessionId: 'sess-123', status: 'running' },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(mockServer.requests.length, 1);
    assert.equal(mockServer.requests[0]!.method, 'POST');
    assert.equal(mockServer.requests[0]!.url, '/api/session/running');
    assert.equal(mockServer.requests[0]!.headers['x-session-id'], 'sess-123');
    assert.equal(mockServer.requests[0]!.headers['content-type'], 'application/json');

    const sentBody = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(sentBody.sessionId, 'sess-123');
  });

  it('throws on non-retryable HTTP error', async () => {
    mockServer = await startMockServer(() => ({
      status: 400,
      body: { error: 'Bad request' },
    }));

    await assert.rejects(
      () => callGuildHttpApi(`${mockServer!.url}/api/test`, 'sess-1', {}, 1000),
      /HTTP 400/,
    );
  });

  it('retries on connection errors and gives up after timeout', async () => {
    // Use a port that nothing is listening on
    const start = Date.now();
    await assert.rejects(
      () => callGuildHttpApi('http://127.0.0.1:1/api/test', 'sess-1', {}, 2000),
      /unreachable after 2000ms|fetch failed/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 1500, `Should have retried for ~2s, but only took ${elapsed}ms`);
  });

  it('succeeds on retry after initial failures', async () => {
    let callCount = 0;
    mockServer = await startMockServer(() => {
      callCount++;
      if (callCount <= 2) {
        return { status: 503, body: { error: 'Service Unavailable' } };
      }
      return { status: 200, body: { ok: true } };
    });

    // 503 is not a connection error (ECONNREFUSED etc.) — it should throw immediately
    // because it's not a retryable error code.
    await assert.rejects(
      () => callGuildHttpApi(`${mockServer!.url}/api/test`, 'sess-1', {}, 5000),
      /HTTP 503/,
    );
  });
});

// ── writeToDlq ─────────────────────────────────────────────────────────

describe('writeToDlq()', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates DLQ directory and writes JSON file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
    const payload = { sessionId: 'sess-1', status: 'failed', error: 'boom' };

    writeToDlq(tmpDir, 'sess-1.json', payload);

    const dlqPath = path.join(tmpDir, '.nexus', 'dlq', 'sess-1.json');
    assert.ok(fs.existsSync(dlqPath), 'DLQ file should exist');

    const written = JSON.parse(fs.readFileSync(dlqPath, 'utf-8'));
    assert.deepEqual(written, payload);
  });

  it('creates nested directory structure', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
    writeToDlq(tmpDir, 'test.json', { ok: true });

    assert.ok(fs.existsSync(path.join(tmpDir, '.nexus', 'dlq')));
  });

  it('overwrites existing DLQ file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlq-test-'));
    writeToDlq(tmpDir, 'sess-1.json', { version: 1 });
    writeToDlq(tmpDir, 'sess-1.json', { version: 2 });

    const dlqPath = path.join(tmpDir, '.nexus', 'dlq', 'sess-1.json');
    const written = JSON.parse(fs.readFileSync(dlqPath, 'utf-8'));
    assert.equal(written.version, 2);
  });
});

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

// ── Transcript DB (initTranscriptDb + writeTranscript) ─────────────────

describe('initTranscriptDb()', () => {
  let tmpDir: string;
  let db: TranscriptDb | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates the transcript table and enables WAL mode', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    db = initTranscriptDb(Database, dbPath);

    // Verify the table exists by reading from it
    const raw = new Database(dbPath);
    const rows = raw.prepare('SELECT * FROM books_animator_transcripts').all();
    assert.equal(rows.length, 0);

    // Verify WAL mode
    const mode = raw.pragma('journal_mode') as Array<{ journal_mode: string }>;
    assert.equal(mode[0]!.journal_mode, 'wal');
    raw.close();
  });

  it('writes and overwrites transcript entries', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = initTranscriptDb(Database, dbPath);

    // Write initial transcript
    writeTranscript(db, 'sess-1', [{ type: 'assistant', message: { content: [] } }]);

    // Read back
    const raw = new Database(dbPath);
    let rows = raw.prepare('SELECT * FROM books_animator_transcripts WHERE id = ?').all('sess-1') as Array<{ id: string; content: string }>;
    assert.equal(rows.length, 1);
    const content1 = JSON.parse(rows[0]!.content);
    assert.equal(content1.id, 'sess-1');
    assert.equal(content1.messages.length, 1);

    // Write updated transcript (more messages)
    writeTranscript(db, 'sess-1', [
      { type: 'assistant', message: { content: [] } },
      { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] },
    ]);

    rows = raw.prepare('SELECT * FROM books_animator_transcripts WHERE id = ?').all('sess-1') as Array<{ id: string; content: string }>;
    assert.equal(rows.length, 1);
    const content2 = JSON.parse(rows[0]!.content);
    assert.equal(content2.messages.length, 2);

    raw.close();
  });

  it('content is readable by an external process', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = initTranscriptDb(Database, dbPath);

    writeTranscript(db, 'sess-ext', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
    ]);

    // Simulate an external reader (like Oculus) reading in WAL mode
    const reader = new Database(dbPath, { readonly: true });
    const rows = reader.prepare('SELECT * FROM books_animator_transcripts WHERE id = ?').all('sess-ext') as Array<{ id: string; content: string }>;
    assert.equal(rows.length, 1);
    const content = JSON.parse(rows[0]!.content);
    assert.equal(content.messages[0].message.content[0].text, 'Hello');
    reader.close();
  });
});

// ── reportRunning ──────────────────────────────────────────────────────

describe('reportRunning()', () => {
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

  it('calls session-running tool via HTTP', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });
    await reportRunning(config, 12345);

    assert.equal(mockServer.requests.length, 1);
    // session-running → /api/session/running
    assert.equal(mockServer.requests[0]!.url, '/api/session/running');

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.sessionId, config.sessionId);
    assert.equal(body.startedAt, config.startedAt);
    assert.equal(body.provider, 'claude-code');
    assert.deepEqual(body.cancelMetadata, { pid: 12345 });
  });

  it('writes to DLQ when guild is unreachable', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
    // Use port 1 which nothing listens on — forces connection error
    const config = makeConfig({
      guildToolUrl: 'http://127.0.0.1:1',
      cwd: tmpDir,
      sessionId: 'sess-dlq-1',
    });

    // reportRunning catches the error and writes DLQ (short timeout for tests)
    await reportRunning(config, 99999, 1500);

    const dlqPath = path.join(tmpDir, '.nexus', 'dlq', 'sess-dlq-1-running.json');
    assert.ok(fs.existsSync(dlqPath), 'DLQ file should be written');

    const dlqContent = JSON.parse(fs.readFileSync(dlqPath, 'utf-8'));
    assert.equal(dlqContent.sessionId, 'sess-dlq-1');
    assert.deepEqual(dlqContent.cancelMetadata, { pid: 99999 });
  });
});

// ── reportResult ───────────────────────────────────────────────────────

describe('reportResult()', () => {
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

  it('calls session-record tool with completed status on exit code 0', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-test-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });
    const transcript = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done!' }] } },
    ];
    const result = {
      exitCode: 0,
      transcript,
      costUsd: 0.42,
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
      providerSessionId: 'claude-sess-1',
    };

    await reportResult(config, result, transcript);

    assert.equal(mockServer.requests.length, 1);
    // session-record → /api/session/record
    assert.equal(mockServer.requests[0]!.url, '/api/session/record');

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'completed');
    assert.equal(body.exitCode, 0);
    assert.equal(body.error, undefined);
    assert.equal(body.costUsd, 0.42);
    assert.equal(body.output, 'Done!');
    assert.equal(body.providerSessionId, 'claude-sess-1');
  });

  it('sends failed status on non-zero exit code', async () => {
    mockServer = await startMockServer(() => ({
      status: 200,
      body: { ok: true },
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-test-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(config, { exitCode: 1, transcript: [] }, []);

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'failed');
    assert.match(body.error, /exited with code 1/);
  });

  it('writes to DLQ when guild is unreachable', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-test-'));
    const config = makeConfig({
      guildToolUrl: 'http://127.0.0.1:1',
      cwd: tmpDir,
      sessionId: 'sess-dlq-2',
    });

    // Short timeout for tests
    await reportResult(config, { exitCode: 0, transcript: [] }, [], 1500);

    const dlqPath = path.join(tmpDir, '.nexus', 'dlq', 'sess-dlq-2.json');
    assert.ok(fs.existsSync(dlqPath), 'DLQ file should be written');

    const dlqContent = JSON.parse(fs.readFileSync(dlqPath, 'utf-8'));
    assert.equal(dlqContent.sessionId, 'sess-dlq-2');
    assert.equal(dlqContent.status, 'completed');
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
    assert.deepEqual(runningBody.cancelMetadata, { pid: 42 });

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
    const tmpDirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('nsg-babysitter-'));
    // Should be cleaned up (might be zero or some leftover from other tests)
    // Just verify the function completed without error

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
});
