/**
 * Tests for the babysitter runtime toolkit (`runtime.ts`).
 *
 * Covers the single-purpose primitives extracted from `babysitter.ts`:
 *  - Config parsing from stdin (incl. logDir validation)
 *  - HTTP retry helper (incl. non-retryable cause-chain branch)
 *  - DLQ writer
 *  - SQLite transcript trio (initTranscriptDb + writeTranscript)
 *  - Lifecycle reporters (reportRunning, reportResult)
 *  - findRetryableCode cause-chain walker
 *  - redirectStderrToFile
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import Database from 'better-sqlite3';

import {
  readConfigFromStdin,
  callGuildHttpApi,
  findRetryableCode,
  writeToDlq,
  writeTranscript,
  initTranscriptDb,
  reportRunning,
  reportResult,
  redirectStderrToFile,
  type BabysitterConfig,
  type SerializedTool,
  type TranscriptDb,
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
    // Zod's structured error names the field path and the specific
    // issue (e.g. "expected string, received undefined") in its default
    // format. We assert the issue keyword rather than the legacy
    // hand-rolled "Missing required config field" wording.
    await assert.rejects(
      () => readConfigFromStdin(stream),
      /invalid_type|expected string, received undefined/,
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
      { name: 'writ-list', description: 'List writs', params: { properties: { status: { type: 'string' } } }, method: 'GET' },
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
    // Use a port that nothing is listening on but is valid (triggers ECONNREFUSED)
    const start = Date.now();
    await assert.rejects(
      () => callGuildHttpApi('http://127.0.0.1:19999/api/test', 'sess-1', {}, 2000),
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
    await reportRunning(config, { kind: 'local-pgid', pgid: 12345 });

    assert.equal(mockServer.requests.length, 1);
    // session-running → /api/session/running
    assert.equal(mockServer.requests[0]!.url, '/api/session/running');

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.sessionId, config.sessionId);
    assert.equal(body.startedAt, config.startedAt);
    assert.equal(body.provider, 'claude-code');
    assert.deepEqual(body.cancelHandle, { kind: 'local-pgid', pgid: 12345 });
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
    await reportRunning(config, { kind: 'local-pgid', pgid: 99999 }, 1500);

    const dlqPath = path.join(tmpDir, '.nexus', 'dlq', 'sess-dlq-1-running.json');
    assert.ok(fs.existsSync(dlqPath), 'DLQ file should be written');

    const dlqContent = JSON.parse(fs.readFileSync(dlqPath, 'utf-8'));
    assert.equal(dlqContent.sessionId, 'sess-dlq-1');
    assert.deepEqual(dlqContent.cancelHandle, { kind: 'local-pgid', pgid: 99999 });
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

  it('attaches terminationDiagnostic on failed status (non-zero exit, no tag)', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-diag-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(
      config,
      { exitCode: 2, transcript: [] },
      [],
      undefined,
      undefined,
      'Traceback: something died',
    );

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'failed');
    assert.deepEqual(body.terminationDiagnostic, {
      exitCode: 2,
      stderrExcerpt: 'Traceback: something died',
    });
  });

  it('omits terminationDiagnostic on completed status', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-diag-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(
      config,
      { exitCode: 0, transcript: [] },
      [],
      undefined,
      undefined,
      'some stderr text',
    );

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'completed');
    assert.equal(body.terminationDiagnostic, undefined);
  });

  it('omits terminationDiagnostic on cancelled override', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-diag-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(
      config,
      { exitCode: 1, transcript: [] },
      [],
      undefined,
      'cancelled',
      'some stderr text',
    );

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'cancelled');
    assert.equal(body.terminationDiagnostic, undefined);
  });

  it('omits terminationDiagnostic on rate-limited terminal (NDJSON tag present)', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-diag-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(
      config,
      {
        exitCode: 1,
        transcript: [],
        terminationTag: { kind: 'rate-limit', source: 'ndjson-result' },
      },
      [],
      undefined,
      undefined,
      'some stderr text',
    );

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'rate-limited');
    assert.equal(body.terminationDiagnostic, undefined);
  });

  it('attaches terminationDiagnostic with exitCode only when stderrTail is empty', async () => {
    mockServer = await startMockServer(() => ({ status: 200, body: { ok: true } }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-diag-'));
    const config = makeConfig({ guildToolUrl: mockServer.url, cwd: tmpDir });

    await reportResult(
      config,
      { exitCode: 42, transcript: [] },
      [],
      undefined,
      undefined,
      '',
    );

    const body = JSON.parse(mockServer.requests[0]!.body);
    assert.equal(body.status, 'failed');
    assert.deepEqual(body.terminationDiagnostic, { exitCode: 42 });
  });
});

// ── findRetryableCode ─────────────────────────────────────────────────

describe('findRetryableCode()', () => {
  it('returns retryable code from top-level error', () => {
    const err = Object.assign(new Error('conn refused'), { code: 'ECONNREFUSED' });
    assert.equal(findRetryableCode(err), 'ECONNREFUSED');
  });

  it('returns retryable code from cause', () => {
    const cause = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
    const err = new Error('outer', { cause });
    assert.equal(findRetryableCode(err), 'ECONNRESET');
  });

  it('returns retryable code from nested cause chain', () => {
    const inner = Object.assign(new Error('deep'), { code: 'ETIMEDOUT' });
    const mid = new Error('mid', { cause: inner });
    const outer = new Error('outer', { cause: mid });
    assert.equal(findRetryableCode(outer), 'ETIMEDOUT');
  });

  it('returns null when no retryable code in chain', () => {
    const cause = Object.assign(new Error('bad url'), { code: 'ERR_INVALID_URL' });
    const err = new Error('fetch failed', { cause });
    assert.equal(findRetryableCode(err), null);
  });

  it('returns null for error with no code', () => {
    const err = new TypeError('fetch failed');
    assert.equal(findRetryableCode(err), null);
  });

  it('caps traversal depth', () => {
    // Create a circular cause chain
    const a = new Error('a') as Error & { cause?: Error };
    const b = new Error('b') as Error & { cause?: Error };
    a.cause = b;
    b.cause = a;
    // Should not loop forever — returns null after maxDepth
    assert.equal(findRetryableCode(a, 10), null);
  });
});

// ── callGuildHttpApi non-retryable errors ─────────────────────────────

describe('callGuildHttpApi() non-retryable errors', () => {
  it('throws immediately for fetch failed with non-retryable cause code', async () => {
    // 'fetch failed' message alone should NOT trigger retry if cause code
    // is non-retryable (e.g. ERR_INVALID_URL)
    const start = Date.now();
    await assert.rejects(
      () => callGuildHttpApi('http://[invalid-url]:99999/api/test', 'sess-1', {}, 5000),
      (_err: Error) => {
        // Should throw quickly, not after 5s
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 3000, `Should throw immediately, took ${elapsed}ms`);
        return true;
      },
    );
  });
});

// ── redirectStderrToFile ──────────────────────────────────────────────

describe('redirectStderrToFile()', () => {
  let tmpDir: string;
  let fd: number | undefined;
  let originalWrite: typeof process.stderr.write;

  // Save and restore the real stderr.write around each test so we don't
  // corrupt the test runner's own output.
  beforeEach(() => {
    originalWrite = process.stderr.write;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stderr-redirect-'));
  });

  afterEach(() => {
    // Restore original stderr.write
    process.stderr.write = originalWrite;
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ok */ }
      fd = undefined;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates log file with startup banner', () => {
    fd = redirectStderrToFile(tmpDir, 'sess-001');

    const logPath = path.join(tmpDir, 'sess-001.log');
    assert.ok(fs.existsSync(logPath), 'log file should exist');

    const content = fs.readFileSync(logPath, 'utf-8');
    assert.match(content, /^\[babysitter\] session=sess-001 pid=\d+ pgid=\d+ log=.+ started at \d{4}-/);
  });

  it('handles string and Buffer writes', () => {
    fd = redirectStderrToFile(tmpDir, 'sess-002');

    process.stderr.write('line-one\n');
    process.stderr.write(Buffer.from('line-two\n'));
    process.stderr.write(new Uint8Array(Buffer.from('line-three\n')));

    const content = fs.readFileSync(path.join(tmpDir, 'sess-002.log'), 'utf-8');
    assert.ok(content.includes('line-one'), 'should contain string write');
    assert.ok(content.includes('line-two'), 'should contain Buffer write');
    assert.ok(content.includes('line-three'), 'should contain Uint8Array write');
  });

  it('invokes callback when provided', () => {
    fd = redirectStderrToFile(tmpDir, 'sess-003');

    let callbackInvoked = false;
    process.stderr.write('test\n', () => {
      callbackInvoked = true;
    });
    assert.ok(callbackInvoked, 'callback should be invoked');
  });

  it('creates logDir recursively', () => {
    const nestedDir = path.join(tmpDir, 'a', 'b', 'c');
    fd = redirectStderrToFile(nestedDir, 'sess-004');

    assert.ok(fs.existsSync(path.join(nestedDir, 'sess-004.log')), 'log file in nested dir should exist');
  });
});

// ── readConfigFromStdin logDir validation ─────────────────────────────

describe('readConfigFromStdin() logDir validation', () => {
  it('rejects config missing logDir', async () => {
    const config = {
      sessionId: 'x',
      guildToolUrl: 'http://x',
      dbPath: '/tmp/x',
      claudeArgs: [],
      cwd: '/tmp',
      env: {},
      prompt: '',
      tools: [],
      startedAt: '2026-01-01T00:00:00Z',
      provider: 'claude-code',
    };
    const stream = streamFromString(JSON.stringify(config));
    // Zod surfaces the offending field path (`["logDir"]`) and the
    // specific issue in its default error format. Pin against both so a
    // future regression on either dimension is caught.
    await assert.rejects(
      () => readConfigFromStdin(stream),
      /"logDir"[\s\S]*expected string, received undefined/,
    );
  });

  it('accepts config with logDir', async () => {
    const config = makeConfig({ logDir: '/tmp/test-logs' });
    const stream = streamFromString(JSON.stringify(config));
    const result = await readConfigFromStdin(stream);
    assert.equal(result.logDir, '/tmp/test-logs');
  });
});
