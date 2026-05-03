/**
 * Tests for the patron-input block type and input-request-* tools.
 *
 * Uses an in-memory Stacks backend and mock Guild singleton.
 * Tests cover the block type checker, all seven CLI tools, and validation
 * edge cases in the answer tool.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';

import { setGuild, clearGuild, generateId } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { StacksApi } from '@shardworks/stacks-apparatus';

import type { InputRequestDoc } from './types.ts';

import patronInputBlockType from './block-types/patron-input.ts';

import inputRequestListTool from './tools/input-request-list.ts';
import inputRequestShowTool from './tools/input-request-show.ts';
import inputRequestAnswerTool from './tools/input-request-answer.ts';
import inputRequestCompleteTool from './tools/input-request-complete.ts';
import inputRequestRejectTool from './tools/input-request-reject.ts';
import inputRequestExportTool from './tools/input-request-export.ts';
import inputRequestImportTool from './tools/input-request-import.ts';

// ── Test fixture ───────────────────────────────────────────────────────

function buildFixture(): {
  stacks: StacksApi;
  memBackend: InstanceType<typeof MemoryBackend>;
} {
  const memBackend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(memBackend);
  if (!('apparatus' in stacksPlugin)) throw new Error('stacks must be apparatus');
  const stacksApparatus = stacksPlugin.apparatus;

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      if (name === 'stacks') return stacks as unknown as T;
      throw new Error(`Apparatus "${name}" not found`);
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(_pluginId: string): T { return {} as T; },
    writeConfig() {},
    guildConfig(): GuildConfig {
      return { name: 'test-guild', nexus: '0.0.0', plugins: [] };
    },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  stacksApparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksApparatus.provides as StacksApi;

  memBackend.ensureBook({ ownerId: 'spider', book: 'input-requests' }, {
    indexes: ['status', 'rigId', 'engineId', 'createdAt', ['rigId', 'engineId', 'status']],
  });

  return { stacks, memBackend };
}

/** Create a minimal InputRequestDoc in the book. */
async function createRequest(
  stacks: StacksApi,
  overrides: Partial<InputRequestDoc> = {},
): Promise<InputRequestDoc> {
  const now = new Date().toISOString();
  const doc: InputRequestDoc = {
    id: generateId('ir', 4),
    rigId: generateId('rig', 4),
    engineId: 'test-engine',
    status: 'pending',
    questions: {
      choice1: {
        type: 'choice',
        label: 'Choose something',
        options: { a: 'Option A', b: 'Option B', c: 'Option C' },
        allowCustom: false,
      },
      bool1: {
        type: 'boolean',
        label: 'Is this true?',
      },
      text1: {
        type: 'text',
        label: 'Describe it',
      },
    },
    answers: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const book = stacks.book<InputRequestDoc>('spider', 'input-requests');
  await book.put(doc);
  return doc;
}

// Common request shapes — factory helpers that pre-fill all answers so
// transitions to `completed` succeed.
const ALL_ANSWERS = { choice1: { selected: 'a' }, bool1: true, text1: 'hi' } as const;
const completedReq = (extra: Partial<InputRequestDoc> = {}) =>
  ({ status: 'completed' as const, answers: ALL_ANSWERS, ...extra });
const rejectedReq = (extra: Partial<InputRequestDoc> = {}) =>
  ({ status: 'rejected' as const, ...extra });

/**
 * Install per-test stacks fixture. Returns a getter object so that test
 * bodies can read `ctx.stacks` after `beforeEach` has populated it.
 *
 * Must be called from inside a `describe` callback so that the
 * `beforeEach` / `afterEach` hooks are bound to that describe's scope.
 */
function setupStacksCtx(): { stacks: StacksApi } {
  const ctx = {} as { stacks: StacksApi };
  beforeEach(() => { ctx.stacks = buildFixture().stacks; });
  afterEach(() => clearGuild());
  return ctx;
}

/**
 * Emit the standard `has name "X"` + `does not have callableBy set`
 * tests for an input-request CLI tool. Generates two `it` blocks per
 * call so test counts are preserved exactly when this replaces the
 * inline metadata tests in each tool's describe.
 */
function declareToolMetadataTests(
  tool: { name: string },
  expectedName: string,
): void {
  it(`has name "${expectedName}"`, () => {
    assert.equal(tool.name, expectedName);
  });
  it('does not have callableBy set', () => {
    assert.ok(
      !('callableBy' in tool) || (tool as Record<string, unknown>).callableBy === undefined,
    );
  });
}

/** assert.rejects shorthand for the recurring "throws if request not found" pattern. */
async function expectNotFound(
  tool: { handler: (args: { id: string; [k: string]: unknown }) => Promise<unknown> },
  extra: Record<string, unknown> = {},
): Promise<void> {
  await assert.rejects(
    () => tool.handler({ id: 'ir-nonexistent', ...extra }),
    /not found/i,
  );
}

// ── patron-input block type ────────────────────────────────────────────

describe('patron-input block type', () => {
  const ctx = setupStacksCtx();

  it('has id "patron-input"', () => {
    assert.equal(patronInputBlockType.id, 'patron-input');
  });

  it('has pollIntervalMs of 10_000', () => {
    assert.equal(patronInputBlockType.pollIntervalMs, 10_000);
  });

  it('pending request → { status: "pending" }', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'pending' });
  });

  it('completed request → { status: "cleared" }', async () => {
    const req = await createRequest(ctx.stacks, { status: 'completed', answers: {} });
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'cleared' });
  });

  it('rejected request with reason → { status: "failed", reason: "<the reason>" }', async () => {
    const req = await createRequest(ctx.stacks, rejectedReq({ rejectionReason: 'not applicable' }));
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'failed', reason: 'not applicable' });
  });

  it('rejected request without reason → { status: "failed", reason: "Request rejected by patron" }', async () => {
    const req = await createRequest(ctx.stacks, rejectedReq());
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'failed', reason: 'Request rejected by patron' });
  });

  it('non-existent requestId → { status: "failed", reason: "Input request not found" }', async () => {
    const result = await patronInputBlockType.check({ requestId: 'ir-nonexistent' });
    assert.deepEqual(result, { status: 'failed', reason: 'Input request not found' });
  });

  it('invalid condition schema throws', async () => {
    await assert.rejects(
      () => patronInputBlockType.check({ notRequestId: 'foo' }),
    );
  });
});

// ── input-request-list tool ────────────────────────────────────────────

describe('input-request-list tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestListTool, 'input-request-list');

  it('default (no params) returns only pending requests', async () => {
    await createRequest(ctx.stacks, { status: 'pending' });
    await createRequest(ctx.stacks, { status: 'completed', answers: {} });
    await createRequest(ctx.stacks, rejectedReq());

    const results = await inputRequestListTool.handler({}) as InputRequestDoc[];
    assert.ok(results.every((r) => r.status === 'pending'));
  });

  it('--status completed returns only completed requests', async () => {
    await createRequest(ctx.stacks, { status: 'pending' });
    await createRequest(ctx.stacks, { status: 'completed', answers: {} });

    const results = await inputRequestListTool.handler({ status: 'completed' }) as InputRequestDoc[];
    assert.ok(results.every((r) => r.status === 'completed'));
    assert.equal(results.length, 1);
  });

  it('empty result set returns empty array', async () => {
    const results = await inputRequestListTool.handler({ status: 'rejected' }) as InputRequestDoc[];
    assert.deepEqual(results, []);
  });
});

// ── input-request-show tool ────────────────────────────────────────────

describe('input-request-show tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestShowTool, 'input-request-show');

  it('returns the document for a known id', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestShowTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.id, req.id);
    assert.equal(result.status, 'pending');
  });

  it('throws for unknown id', async () => {
    await expectNotFound(inputRequestShowTool);
  });
});

// ── input-request-answer tool ──────────────────────────────────────────

describe('input-request-answer tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestAnswerTool, 'input-request-answer');

  /** Shorthand: post a default request and assert that the given answer args reject with `pattern`. */
  async function expectAnswerRejects(
    args: Record<string, unknown>,
    pattern: RegExp,
    overrides: Partial<InputRequestDoc> = {},
  ): Promise<void> {
    const req = await createRequest(ctx.stacks, overrides);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, ...args }),
      pattern,
    );
  }

  it('answers a choice question with --select validKey', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id, question: 'choice1', select: 'a',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['choice1'], { selected: 'a' });
  });

  it('overwrites a previous answer while pending', async () => {
    const req = await createRequest(ctx.stacks);
    await inputRequestAnswerTool.handler({ id: req.id, question: 'choice1', select: 'a' });
    const result = await inputRequestAnswerTool.handler({
      id: req.id, question: 'choice1', select: 'b',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['choice1'], { selected: 'b' });
  });

  it('--select invalidKey throws', async () => {
    await expectAnswerRejects(
      { question: 'choice1', select: 'zzz' },
      /not a valid option/i,
    );
  });

  it('answers a choice question with --custom when allowCustom: true', async () => {
    const req = await createRequest(ctx.stacks, {
      questions: {
        customChoice: {
          type: 'choice',
          label: 'Pick or write',
          options: { a: 'A' },
          allowCustom: true,
        },
      },
    });
    const result = await inputRequestAnswerTool.handler({
      id: req.id, question: 'customChoice', custom: 'my custom text',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['customChoice'], { custom: 'my custom text' });
  });

  it('--custom when allowCustom: false throws', async () => {
    await expectAnswerRejects(
      { question: 'choice1', custom: 'foo' },
      /Custom answers not allowed/i,
    );
  });

  it('both --select and --custom throws', async () => {
    await expectAnswerRejects(
      { question: 'choice1', select: 'a', custom: 'b' },
      /exactly one of/i,
    );
  });

  it('neither --select, --custom, nor --value for choice throws', async () => {
    await expectAnswerRejects(
      { question: 'choice1' },
      /exactly one of/i,
    );
  });

  it('--select for a boolean question throws', async () => {
    await expectAnswerRejects(
      { question: 'bool1', select: 'a' },
      /Use --value for boolean questions/i,
    );
  });

  it('--value true for a boolean question → answer is true', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id, question: 'bool1', value: 'true',
    }) as InputRequestDoc;
    assert.equal(result.answers['bool1'], true);
  });

  it('--value text for a text question → answer is the text', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id, question: 'text1', value: 'hello world',
    }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'hello world');
  });

  it('missing --value for boolean question throws', async () => {
    await expectAnswerRejects(
      { question: 'bool1' },
      /Provide --value for boolean questions/i,
    );
  });

  it('answering a non-existent question key throws', async () => {
    await expectAnswerRejects(
      { question: 'nonExistent', value: 'x' },
      /not found in request/i,
    );
  });

  it('answering on a completed request throws', async () => {
    await expectAnswerRejects(
      { question: 'text1', value: 'x' },
      /request status is "completed"/i,
      { status: 'completed', answers: {} },
    );
  });

  it('answering on a rejected request throws', async () => {
    await expectAnswerRejects(
      { question: 'text1', value: 'x' },
      /request status is "rejected"/i,
      rejectedReq(),
    );
  });

  it('throws if request not found', async () => {
    await expectNotFound(inputRequestAnswerTool, { question: 'text1', value: 'x' });
  });
});

// ── input-request-complete tool ────────────────────────────────────────

describe('input-request-complete tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestCompleteTool, 'input-request-complete');

  it('all questions answered → status becomes completed', async () => {
    const req = await createRequest(ctx.stacks, {
      answers: { choice1: { selected: 'a' }, bool1: true, text1: 'hello' },
    });
    const result = await inputRequestCompleteTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'completed');
  });

  it('one question unanswered → throws listing the key', async () => {
    const req = await createRequest(ctx.stacks, {
      answers: { choice1: { selected: 'a' }, bool1: true },
    });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /unanswered questions: text1/i,
    );
  });

  it('multiple questions unanswered → throws listing all keys', async () => {
    const req = await createRequest(ctx.stacks, { answers: {} });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /unanswered questions:/i,
    );
  });

  it('completing an already-completed request throws', async () => {
    const req = await createRequest(ctx.stacks, completedReq());
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /request status is "completed"/i,
    );
  });

  it('completing a rejected request throws', async () => {
    const req = await createRequest(ctx.stacks, rejectedReq());
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /request status is "rejected"/i,
    );
  });

  it('throws if request not found', async () => {
    await expectNotFound(inputRequestCompleteTool);
  });
});

// ── input-request-reject tool ──────────────────────────────────────────

describe('input-request-reject tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestRejectTool, 'input-request-reject');

  it('reject with reason → status rejected, rejectionReason set', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestRejectTool.handler({
      id: req.id, reason: 'not applicable',
    }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejectionReason, 'not applicable');
  });

  it('reject without reason → status rejected, no rejectionReason', async () => {
    const req = await createRequest(ctx.stacks);
    const result = await inputRequestRejectTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
    assert.ok(!result.rejectionReason);
  });

  it('reject with partial answers succeeds', async () => {
    const req = await createRequest(ctx.stacks, { answers: { text1: 'partial' } });
    const result = await inputRequestRejectTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
  });

  it('reject a completed request throws', async () => {
    const req = await createRequest(ctx.stacks, completedReq());
    await assert.rejects(
      () => inputRequestRejectTool.handler({ id: req.id }),
      /request status is "completed"/i,
    );
  });

  it('throws if request not found', async () => {
    await expectNotFound(inputRequestRejectTool);
  });
});

// ── input-request-export tool ──────────────────────────────────────────

describe('input-request-export tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestExportTool, 'input-request-export');

  it('exports YAML containing id, questions, answers, message', async () => {
    const req = await createRequest(ctx.stacks, {
      message: 'Please answer these questions',
      answers: { text1: 'hello' },
    });
    const result = await inputRequestExportTool.handler({ id: req.id }) as { yaml: string };
    assert.ok(typeof result.yaml === 'string');
    assert.ok(result.yaml.includes(req.id));
    assert.ok(result.yaml.includes('questions'));
    assert.ok(result.yaml.includes('answers'));
    assert.ok(result.yaml.includes('Please answer these questions'));
  });

  it('throws if request not found', async () => {
    await expectNotFound(inputRequestExportTool);
  });
});

// ── input-request-import tool ──────────────────────────────────────────

describe('input-request-import tool', () => {
  const ctx = setupStacksCtx();
  declareToolMetadataTests(inputRequestImportTool, 'input-request-import');

  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'ir-test-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  /** Write a YAML payload to a fresh file in tmpDir, returning its path. */
  async function writeYaml(name: string, payload: unknown): Promise<string> {
    const path = join(tmpDir, name);
    await writeFile(path, stringify(payload));
    return path;
  }

  it('imports answers from a YAML file', async () => {
    const req = await createRequest(ctx.stacks);
    const filePath = await writeYaml('answers.yaml', {
      id: req.id,
      answers: { text1: 'imported answer', bool1: true },
    });

    const result = await inputRequestImportTool.handler({ file: filePath }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'imported answer');
    assert.equal(result.answers['bool1'], true);
  });

  it('export → edit answers → import → answers updated', async () => {
    const req = await createRequest(ctx.stacks, { answers: { text1: 'original' } });

    // Export captures the original
    const exportResult = await inputRequestExportTool.handler({ id: req.id }) as { yaml: string };

    // Modify answers in the export object and re-import
    const filePath = await writeYaml('modified.yaml', {
      id: req.id,
      answers: { text1: 'updated answer', bool1: 'false' },
    });
    const result = await inputRequestImportTool.handler({ file: filePath }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'updated answer');
    assert.equal(result.answers['bool1'], false);

    // Original export had the old answers
    assert.ok(exportResult.yaml.includes('original'));
  });

  it('import with invalid choice key throws', async () => {
    const req = await createRequest(ctx.stacks);
    const filePath = await writeYaml('bad.yaml', {
      id: req.id,
      answers: { choice1: { selected: 'invalid-key' } },
    });

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /not a valid option/i,
    );
  });

  it('import targeting a completed request throws', async () => {
    const req = await createRequest(ctx.stacks, { status: 'completed', answers: {} });
    const filePath = await writeYaml('completed.yaml', { id: req.id, answers: { text1: 'hi' } });

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /request status is "completed"/i,
    );
  });

  it('import with missing id in YAML throws', async () => {
    const filePath = await writeYaml('noid.yaml', { answers: { text1: 'hi' } });

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /missing required "id"/i,
    );
  });

  it('import with unknown question key throws', async () => {
    const req = await createRequest(ctx.stacks);
    const filePath = await writeYaml('unknownq.yaml', {
      id: req.id,
      answers: { unknownQuestion: 'value' },
    });

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /Unknown question key/i,
    );
  });
});

// ── callableBy check for all tools ────────────────────────────────────

describe('Tool callableBy — all input-request tools', () => {
  const tools = [
    inputRequestListTool,
    inputRequestShowTool,
    inputRequestAnswerTool,
    inputRequestCompleteTool,
    inputRequestRejectTool,
    inputRequestExportTool,
    inputRequestImportTool,
  ];

  for (const t of tools) {
    it(`${t.name} does not have callableBy set`, () => {
      assert.ok(
        !('callableBy' in t) || (t as Record<string, unknown>).callableBy === undefined,
        `${t.name} should not have callableBy`,
      );
    });
  }
});
