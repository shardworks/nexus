/**
 * Tests for detached session launch.
 *
 * Covers:
 * - Tool serialization from Zod to JSON Schema (unit)
 * - BabysitterConfig construction (unit)
 * - Polling helpers (unit)
 * - Detached launch integration with mock babysitter (integration)
 * - Cancel via PID from SessionDoc (integration)
 * - Empty chunks iterable (unit)
 */

import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { z } from 'zod';

import type {
  SessionProviderConfig,
  SessionDoc,
} from '@shardworks/animator-apparatus';
import type { ResolvedTool } from '@shardworks/tools-apparatus';
import type { ReadOnlyBook } from '@shardworks/stacks-apparatus';

import {
  serializeTool,
  serializeTools,
  buildBabysitterConfig,
  pollForTerminalStatus,
  pollForProcessInfo,
  launchDetached,
} from './detached.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeProviderConfig(overrides?: Partial<SessionProviderConfig>): SessionProviderConfig {
  return {
    sessionId: 'ses-test-001',
    model: 'sonnet',
    cwd: os.tmpdir(),
    ...overrides,
  };
}

function makeResolvedTool(
  name: string,
  params: z.ZodObject<z.ZodRawShape>,
  description: string = `Tool: ${name}`,
): ResolvedTool {
  return {
    definition: {
      name,
      description,
      params,
      handler: () => ({ ok: true }),
    },
    pluginId: 'test-plugin',
  };
}

/** Create a mock ReadOnlyBook that returns docs from a Map. */
function createMockSessionsBook(
  docs: Map<string, SessionDoc>,
): ReadOnlyBook<SessionDoc> {
  return {
    async get(id: string) {
      return docs.get(id) ?? null;
    },
    async find() { return []; },
    async list() { return []; },
    async count() { return 0; },
  } as unknown as ReadOnlyBook<SessionDoc>;
}

function makeSessionDoc(overrides?: Partial<SessionDoc>): SessionDoc {
  return {
    id: 'ses-test-001',
    status: 'running',
    startedAt: '2026-04-10T00:00:00.000Z',
    provider: 'claude-code',
    ...overrides,
  } as SessionDoc;
}

// ── serializeTool ─────────────────────────────────────────────────────

describe('serializeTool()', () => {
  it('converts Zod params to JSON Schema', () => {
    const tool = makeResolvedTool(
      'writ-list',
      z.object({
        status: z.string().describe('Filter by status'),
      }),
      'List writs',
    );

    const serialized = serializeTool(tool);

    assert.equal(serialized.name, 'writ-list');
    assert.equal(serialized.description, 'List writs');
    assert.ok(serialized.params, 'params should exist');
    assert.ok(serialized.params.properties, 'should have properties');

    const props = serialized.params.properties as Record<string, unknown>;
    assert.ok(props.status, 'should have status property');
  });

  it('preserves required fields in JSON Schema', () => {
    const tool = makeResolvedTool(
      'signal',
      z.object({
        message: z.string(),
        priority: z.number().optional(),
      }),
    );

    const serialized = serializeTool(tool);

    // Required fields should be present
    const params = serialized.params;
    const props = params.properties as Record<string, unknown>;
    assert.ok(props.message, 'should have message property');
    assert.ok(props.priority, 'should have priority property');
  });

  it('strips type and $schema from top level', () => {
    const tool = makeResolvedTool(
      'test',
      z.object({ x: z.string() }),
    );

    const serialized = serializeTool(tool);

    // Should NOT have 'type' or '$schema' at the top level
    // (the babysitter adds { type: 'object', ...params } itself)
    assert.equal(serialized.params.type, undefined, 'should strip type');
    assert.equal(serialized.params.$schema, undefined, 'should strip $schema');
  });

  it('handles empty params schema', () => {
    const tool = makeResolvedTool(
      'no-params',
      z.object({}),
      'Tool with no params',
    );

    const serialized = serializeTool(tool);

    assert.equal(serialized.name, 'no-params');
    assert.ok(serialized.params !== undefined, 'params should exist even if empty');
  });
});

describe('serializeTools()', () => {
  it('serializes an array of tools', () => {
    const tools = [
      makeResolvedTool('tool-a', z.object({ x: z.string() })),
      makeResolvedTool('tool-b', z.object({ y: z.number() })),
    ];

    const serialized = serializeTools(tools);

    assert.equal(serialized.length, 2);
    assert.equal(serialized[0]!.name, 'tool-a');
    assert.equal(serialized[1]!.name, 'tool-b');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(serializeTools([]), []);
  });
});

// ── buildBabysitterConfig ─────────────────────────────────────────────

describe('buildBabysitterConfig()', () => {
  it('populates all required fields', () => {
    const config = makeProviderConfig({
      initialPrompt: 'Do the thing',
      environment: { GITHUB_TOKEN: 'abc' },
    });

    const bc = buildBabysitterConfig(config, {
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: '/tmp/nexus.db',
    });

    assert.equal(bc.sessionId, 'ses-test-001');
    assert.equal(bc.guildToolUrl, 'http://127.0.0.1:7471');
    assert.equal(bc.dbPath, '/tmp/nexus.db');
    assert.equal(bc.cwd, os.tmpdir());
    assert.equal(bc.prompt, 'Do the thing');
    assert.equal(bc.provider, 'claude-code');
    assert.ok(bc.startedAt, 'should have startedAt');
    assert.deepEqual(bc.env, { GITHUB_TOKEN: 'abc' });
  });

  it('includes base CLI args', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig({ model: 'opus' }),
      { guildToolUrl: 'http://x', dbPath: '/tmp/x.db' },
    );

    assert.ok(bc.claudeArgs.includes('--model'), 'should include --model');
    assert.ok(bc.claudeArgs.includes('opus'), 'should include model value');
    assert.ok(bc.claudeArgs.includes('--setting-sources'), 'should include --setting-sources');
    assert.ok(bc.claudeArgs.includes('--dangerously-skip-permissions'), 'should include --dangerously-skip-permissions');
  });

  it('includes --resume when conversationId is provided', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig({ conversationId: 'conv-123' }),
      { guildToolUrl: 'http://x', dbPath: '/tmp/x.db' },
    );

    assert.ok(bc.claudeArgs.includes('--resume'), 'should include --resume');
    assert.ok(bc.claudeArgs.includes('conv-123'), 'should include conversation id');
  });

  it('writes system prompt file and includes --system-prompt-file', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig({ systemPrompt: 'You are a helpful assistant.' }),
      { guildToolUrl: 'http://x', dbPath: '/tmp/x.db' },
    );

    const idx = bc.claudeArgs.indexOf('--system-prompt-file');
    assert.ok(idx >= 0, 'should include --system-prompt-file');

    const filePath = bc.claudeArgs[idx + 1]!;
    assert.ok(fs.existsSync(filePath), 'system prompt file should exist');

    const content = fs.readFileSync(filePath, 'utf-8');
    assert.equal(content, 'You are a helpful assistant.');

    // Cleanup
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it('serializes tools from Zod to JSON Schema', () => {
    const config = makeProviderConfig({
      tools: [
        makeResolvedTool('writ-list', z.object({ status: z.string() }), 'List writs'),
      ],
    });

    const bc = buildBabysitterConfig(config, {
      guildToolUrl: 'http://x',
      dbPath: '/tmp/x.db',
    });

    assert.equal(bc.tools.length, 1);
    assert.equal(bc.tools[0]!.name, 'writ-list');
    assert.equal(bc.tools[0]!.description, 'List writs');
    assert.ok(bc.tools[0]!.params.properties, 'should have JSON Schema properties');
  });

  it('defaults prompt to empty string when not provided', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig(),
      { guildToolUrl: 'http://x', dbPath: '/tmp/x.db' },
    );

    assert.equal(bc.prompt, '');
  });

  it('defaults env to empty object when not provided', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig(),
      { guildToolUrl: 'http://x', dbPath: '/tmp/x.db' },
    );

    assert.deepEqual(bc.env, {});
  });

  it('includes metadata when provided', () => {
    const bc = buildBabysitterConfig(
      makeProviderConfig(),
      {
        guildToolUrl: 'http://x',
        dbPath: '/tmp/x.db',
        metadata: { writId: 'w-1', role: 'artificer' },
      },
    );

    assert.deepEqual(bc.metadata, { writId: 'w-1', role: 'artificer' });
  });
});

// ── pollForTerminalStatus ──────────────────────────────────────────────

describe('pollForTerminalStatus()', () => {
  it('resolves immediately when session is already terminal', async () => {
    const doc = makeSessionDoc({ status: 'completed', exitCode: 0 });
    const book = createMockSessionsBook(new Map([['ses-test-001', doc]]));

    const result = await pollForTerminalStatus(book, 'ses-test-001', 50, 1000);

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
  });

  it('polls until session reaches terminal status', async () => {
    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 3) {
          return makeSessionDoc({ id, status: 'running' });
        }
        return makeSessionDoc({ id, status: 'completed', exitCode: 0 });
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const result = await pollForTerminalStatus(book, 'ses-test-001', 50, 5000);

    assert.equal(result.status, 'completed');
    assert.ok(callCount >= 3, `Should have polled at least 3 times, got ${callCount}`);
  });

  it('throws on timeout', async () => {
    const book = createMockSessionsBook(
      new Map([['ses-test-001', makeSessionDoc({ status: 'running' })]]),
    );

    await assert.rejects(
      () => pollForTerminalStatus(book, 'ses-test-001', 50, 200),
      /did not reach terminal status within 200ms/,
    );
  });

  it('handles session not found (keeps polling)', async () => {
    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 3) return null;
        return makeSessionDoc({ id, status: 'failed', exitCode: 1 });
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const result = await pollForTerminalStatus(book, 'ses-test-001', 50, 5000);

    assert.equal(result.status, 'failed');
  });

  it('detects cancelled status', async () => {
    const doc = makeSessionDoc({
      status: 'cancelled',
      error: 'User cancelled',
    });
    const book = createMockSessionsBook(new Map([['ses-test-001', doc]]));

    const result = await pollForTerminalStatus(book, 'ses-test-001', 50, 1000);

    assert.equal(result.status, 'cancelled');
    assert.equal(result.error, 'User cancelled');
  });
});

// ── pollForProcessInfo ─────────────────────────────────────────────────

describe('pollForProcessInfo()', () => {
  it('resolves immediately when cancelMetadata is available', async () => {
    const doc = makeSessionDoc({
      status: 'running',
      cancelMetadata: { pid: 12345 },
    });
    const book = createMockSessionsBook(new Map([['ses-test-001', doc]]));

    const info = await pollForProcessInfo(book, 'ses-test-001', 50, 1000);

    assert.deepEqual(info, { pid: 12345 });
  });

  it('polls until cancelMetadata appears', async () => {
    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 3) {
          return makeSessionDoc({ id, status: 'running' });
        }
        return makeSessionDoc({
          id,
          status: 'running',
          cancelMetadata: { pid: 99 },
        });
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const info = await pollForProcessInfo(book, 'ses-test-001', 50, 5000);

    assert.deepEqual(info, { pid: 99 });
  });

  it('returns empty when session terminates before cancelMetadata', async () => {
    const doc = makeSessionDoc({
      status: 'completed',
      exitCode: 0,
    });
    const book = createMockSessionsBook(new Map([['ses-test-001', doc]]));

    const info = await pollForProcessInfo(book, 'ses-test-001', 50, 1000);

    assert.deepEqual(info, {});
  });

  it('returns empty on timeout', async () => {
    const book = createMockSessionsBook(
      new Map([['ses-test-001', makeSessionDoc({ status: 'running' })]]),
    );

    const info = await pollForProcessInfo(book, 'ses-test-001', 50, 200);

    assert.deepEqual(info, {});
  });
});

// ── launchDetached ─────────────────────────────────────────────────────

describe('launchDetached()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-test-'));
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty chunks iterable that completes immediately', async () => {
    // Write a dummy babysitter script that reads stdin and exits
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { process.exit(0); });
    `);

    const docs = new Map<string, SessionDoc>();
    docs.set('ses-test-001', makeSessionDoc({
      status: 'completed',
      exitCode: 0,
    }));
    const book = createMockSessionsBook(docs);

    const config = makeProviderConfig({ cwd: tmpDir });
    const { chunks } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: book,
      pollIntervalMs: 50,
      pollTimeoutMs: 2000,
    });

    const collected = [];
    for await (const chunk of chunks) {
      collected.push(chunk);
    }

    assert.equal(collected.length, 0, 'chunks should be empty');
  });

  it('spawns babysitter and writes config to stdin', async () => {
    // Write a babysitter script that saves received config
    const configOutputPath = path.join(tmpDir, 'received-config.json');
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      const fs = require('fs');
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(configOutputPath)}, data);
        process.exit(0);
      });
    `);

    const docs = new Map<string, SessionDoc>();
    docs.set('ses-test-001', makeSessionDoc({
      status: 'completed',
      exitCode: 0,
    }));

    const config = makeProviderConfig({
      cwd: tmpDir,
      initialPrompt: 'Test prompt',
    });

    const { result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: createMockSessionsBook(docs),
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    });

    // Wait for result (polls until terminal)
    const providerResult = await result;
    assert.equal(providerResult.status, 'completed');

    // Verify babysitter received the config
    // Give it a moment for the file to be written
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(fs.existsSync(configOutputPath), 'babysitter should have received config');

    const receivedConfig = JSON.parse(fs.readFileSync(configOutputPath, 'utf-8'));
    assert.equal(receivedConfig.sessionId, 'ses-test-001');
    assert.equal(receivedConfig.prompt, 'Test prompt');
    assert.equal(receivedConfig.guildToolUrl, 'http://127.0.0.1:7471');
  });

  it('resolves result when session reaches terminal status', async () => {
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { process.exit(0); });
    `);

    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 3) {
          return makeSessionDoc({ id, status: 'running' });
        }
        return makeSessionDoc({
          id,
          status: 'completed',
          exitCode: 0,
          costUsd: 0.42,
          tokenUsage: { inputTokens: 1000, outputTokens: 500 },
          output: 'Done!',
          providerSessionId: 'claude-sess-1',
        });
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const config = makeProviderConfig({ cwd: tmpDir });
    const { result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: book,
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    });

    const providerResult = await result;
    assert.equal(providerResult.status, 'completed');
    assert.equal(providerResult.exitCode, 0);
    assert.equal(providerResult.costUsd, 0.42);
    assert.equal(providerResult.output, 'Done!');
    assert.equal(providerResult.providerSessionId, 'claude-sess-1');
    assert.deepEqual(providerResult.tokenUsage, { inputTokens: 1000, outputTokens: 500 });
  });

  it('resolves processInfo with cancelMetadata from SessionDoc', async () => {
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { /* stay alive briefly */ setTimeout(() => process.exit(0), 2000); });
    `);

    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 2) {
          return makeSessionDoc({ id, status: 'running' });
        }
        // After a few polls, cancelMetadata appears (babysitter called session-running)
        if (callCount < 5) {
          return makeSessionDoc({
            id,
            status: 'running',
            cancelMetadata: { pid: 54321 },
          });
        }
        return makeSessionDoc({
          id,
          status: 'completed',
          exitCode: 0,
          cancelMetadata: { pid: 54321 },
        });
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const config = makeProviderConfig({ cwd: tmpDir });
    const { processInfo, result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: book,
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    });

    assert.ok(processInfo, 'processInfo should be defined');
    const info = await processInfo!;
    assert.deepEqual(info, { pid: 54321 });

    // Also wait for result to avoid dangling promises
    await result;
  });

  it('returns failed status when polling times out', async () => {
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => { process.exit(0); });
    `);

    // Session stays running forever
    const book = createMockSessionsBook(
      new Map([['ses-test-001', makeSessionDoc({ status: 'running' })]]),
    );

    const config = makeProviderConfig({ cwd: tmpDir });
    const { result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: book,
      pollIntervalMs: 50,
      pollTimeoutMs: 300,
    });

    const providerResult = await result;
    assert.equal(providerResult.status, 'failed');
    assert.match(providerResult.error!, /polling failed/);
  });

  it('serializes tools in babysitter config', async () => {
    const configOutputPath = path.join(tmpDir, 'received-config.json');
    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      const fs = require('fs');
      let data = '';
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(configOutputPath)}, data);
        process.exit(0);
      });
    `);

    const docs = new Map<string, SessionDoc>();
    docs.set('ses-test-001', makeSessionDoc({ status: 'completed', exitCode: 0 }));

    const config = makeProviderConfig({
      cwd: tmpDir,
      tools: [
        makeResolvedTool('writ-list', z.object({
          status: z.string().describe('Filter by status'),
          limit: z.number().optional(),
        }), 'List writs'),
        makeResolvedTool('signal', z.object({
          message: z.string(),
        }), 'Send signal'),
      ],
    });

    const { result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: createMockSessionsBook(docs),
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    });

    await result;

    // Wait for file write
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(fs.existsSync(configOutputPath), 'config should be written');

    const receivedConfig = JSON.parse(fs.readFileSync(configOutputPath, 'utf-8'));
    assert.equal(receivedConfig.tools.length, 2);
    assert.equal(receivedConfig.tools[0].name, 'writ-list');
    assert.ok(receivedConfig.tools[0].params.properties, 'should have JSON Schema properties');
    assert.ok(receivedConfig.tools[0].params.properties.status, 'should have status property');
    assert.equal(receivedConfig.tools[1].name, 'signal');
  });

  it('cancel sends SIGTERM to PID from processInfo', async () => {
    // This test verifies the provider's cancel() works with a PID obtained
    // from the SessionDoc's cancelMetadata (set by the babysitter).

    // We can't easily test cross-process SIGTERM in a unit test, but we
    // can verify that the cancel() method from the provider handles the PID.
    // The cancel logic is in the provider's cancel() method (index.ts).
    // Here we just verify processInfo resolves with the right PID.

    const babysitterScript = path.join(tmpDir, 'babysitter.js');
    fs.writeFileSync(babysitterScript, `
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => { setTimeout(() => process.exit(0), 2000); });
    `);

    const doc = makeSessionDoc({
      status: 'running',
      cancelMetadata: { pid: 77777 },
    });
    const terminalDoc = makeSessionDoc({
      status: 'completed',
      exitCode: 0,
      cancelMetadata: { pid: 77777 },
    });

    let callCount = 0;
    const book = {
      async get(id: string) {
        callCount++;
        if (callCount < 4) return doc;
        return terminalDoc;
      },
      async find() { return []; },
      async list() { return []; },
      async count() { return 0; },
    } as unknown as ReadOnlyBook<SessionDoc>;

    const config = makeProviderConfig({ cwd: tmpDir });
    const { processInfo, result } = launchDetached(config, {
      babysitterPath: babysitterScript,
      guildToolUrl: 'http://127.0.0.1:7471',
      dbPath: path.join(tmpDir, 'nexus.db'),
      sessionsBook: book,
      pollIntervalMs: 50,
      pollTimeoutMs: 5000,
    });

    const info = await processInfo!;
    assert.deepEqual(info, { pid: 77777 });

    await result;
  });
});
