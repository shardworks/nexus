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

// ── patron-input block type ────────────────────────────────────────────

describe('patron-input block type', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has id "patron-input"', () => {
    assert.equal(patronInputBlockType.id, 'patron-input');
  });

  it('has pollIntervalMs of 10_000', () => {
    assert.equal(patronInputBlockType.pollIntervalMs, 10_000);
  });

  it('pending request → { status: "pending" }', async () => {
    const req = await createRequest(stacks);
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'pending' });
  });

  it('completed request → { status: "cleared" }', async () => {
    const req = await createRequest(stacks, { status: 'completed', answers: {} });
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'cleared' });
  });

  it('rejected request with reason → { status: "failed", reason: "<the reason>" }', async () => {
    const req = await createRequest(stacks, {
      status: 'rejected',
      rejectionReason: 'not applicable',
    });
    const result = await patronInputBlockType.check({ requestId: req.id });
    assert.deepEqual(result, { status: 'failed', reason: 'not applicable' });
  });

  it('rejected request without reason → { status: "failed", reason: "Request rejected by patron" }', async () => {
    const req = await createRequest(stacks, { status: 'rejected' });
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
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-list"', () => {
    assert.equal(inputRequestListTool.name, 'input-request-list');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestListTool) || (inputRequestListTool as Record<string,unknown>).callableBy === undefined);
  });

  it('default (no params) returns only pending requests', async () => {
    await createRequest(stacks, { status: 'pending' });
    await createRequest(stacks, { status: 'completed', answers: {} });
    await createRequest(stacks, { status: 'rejected' });

    const results = await inputRequestListTool.handler({}) as InputRequestDoc[];
    assert.ok(results.every((r) => r.status === 'pending'));
  });

  it('--status completed returns only completed requests', async () => {
    await createRequest(stacks, { status: 'pending' });
    await createRequest(stacks, { status: 'completed', answers: {} });

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
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-show"', () => {
    assert.equal(inputRequestShowTool.name, 'input-request-show');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestShowTool) || (inputRequestShowTool as Record<string,unknown>).callableBy === undefined);
  });

  it('returns the document for a known id', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestShowTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.id, req.id);
    assert.equal(result.status, 'pending');
  });

  it('throws for unknown id', async () => {
    await assert.rejects(
      () => inputRequestShowTool.handler({ id: 'ir-nonexistent' }),
      /not found/i,
    );
  });
});

// ── input-request-answer tool ──────────────────────────────────────────

describe('input-request-answer tool', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-answer"', () => {
    assert.equal(inputRequestAnswerTool.name, 'input-request-answer');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestAnswerTool) || (inputRequestAnswerTool as Record<string,unknown>).callableBy === undefined);
  });

  it('answers a choice question with --select validKey', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id,
      question: 'choice1',
      select: 'a',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['choice1'], { selected: 'a' });
  });

  it('overwrites a previous answer while pending', async () => {
    const req = await createRequest(stacks);
    await inputRequestAnswerTool.handler({ id: req.id, question: 'choice1', select: 'a' });
    const result = await inputRequestAnswerTool.handler({
      id: req.id,
      question: 'choice1',
      select: 'b',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['choice1'], { selected: 'b' });
  });

  it('--select invalidKey throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'choice1', select: 'zzz' }),
      /not a valid option/i,
    );
  });

  it('answers a choice question with --custom when allowCustom: true', async () => {
    const req = await createRequest(stacks, {
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
      id: req.id,
      question: 'customChoice',
      custom: 'my custom text',
    }) as InputRequestDoc;
    assert.deepEqual(result.answers['customChoice'], { custom: 'my custom text' });
  });

  it('--custom when allowCustom: false throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'choice1', custom: 'foo' }),
      /Custom answers not allowed/i,
    );
  });

  it('both --select and --custom throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'choice1', select: 'a', custom: 'b' }),
      /exactly one of/i,
    );
  });

  it('neither --select, --custom, nor --value for choice throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'choice1' }),
      /exactly one of/i,
    );
  });

  it('--select for a boolean question throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'bool1', select: 'a' }),
      /Use --value for boolean questions/i,
    );
  });

  it('--value true for a boolean question → answer is true', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id,
      question: 'bool1',
      value: 'true',
    }) as InputRequestDoc;
    assert.equal(result.answers['bool1'], true);
  });

  it('--value text for a text question → answer is the text', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestAnswerTool.handler({
      id: req.id,
      question: 'text1',
      value: 'hello world',
    }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'hello world');
  });

  it('missing --value for boolean question throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'bool1' }),
      /Provide --value for boolean questions/i,
    );
  });

  it('answering a non-existent question key throws', async () => {
    const req = await createRequest(stacks);
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'nonExistent', value: 'x' }),
      /not found in request/i,
    );
  });

  it('answering on a completed request throws', async () => {
    const req = await createRequest(stacks, { status: 'completed', answers: {} });
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'text1', value: 'x' }),
      /request status is "completed"/i,
    );
  });

  it('answering on a rejected request throws', async () => {
    const req = await createRequest(stacks, { status: 'rejected' });
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: req.id, question: 'text1', value: 'x' }),
      /request status is "rejected"/i,
    );
  });

  it('throws if request not found', async () => {
    await assert.rejects(
      () => inputRequestAnswerTool.handler({ id: 'ir-nonexistent', question: 'text1', value: 'x' }),
      /not found/i,
    );
  });
});

// ── input-request-complete tool ────────────────────────────────────────

describe('input-request-complete tool', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-complete"', () => {
    assert.equal(inputRequestCompleteTool.name, 'input-request-complete');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestCompleteTool) || (inputRequestCompleteTool as Record<string,unknown>).callableBy === undefined);
  });

  it('all questions answered → status becomes completed', async () => {
    const req = await createRequest(stacks, {
      answers: { choice1: { selected: 'a' }, bool1: true, text1: 'hello' },
    });
    const result = await inputRequestCompleteTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'completed');
  });

  it('one question unanswered → throws listing the key', async () => {
    const req = await createRequest(stacks, {
      answers: { choice1: { selected: 'a' }, bool1: true },
    });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /unanswered questions: text1/i,
    );
  });

  it('multiple questions unanswered → throws listing all keys', async () => {
    const req = await createRequest(stacks, { answers: {} });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /unanswered questions:/i,
    );
  });

  it('completing an already-completed request throws', async () => {
    const req = await createRequest(stacks, {
      status: 'completed',
      answers: { choice1: { selected: 'a' }, bool1: true, text1: 'hi' },
    });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /request status is "completed"/i,
    );
  });

  it('completing a rejected request throws', async () => {
    const req = await createRequest(stacks, { status: 'rejected' });
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: req.id }),
      /request status is "rejected"/i,
    );
  });

  it('throws if request not found', async () => {
    await assert.rejects(
      () => inputRequestCompleteTool.handler({ id: 'ir-nonexistent' }),
      /not found/i,
    );
  });
});

// ── input-request-reject tool ──────────────────────────────────────────

describe('input-request-reject tool', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-reject"', () => {
    assert.equal(inputRequestRejectTool.name, 'input-request-reject');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestRejectTool) || (inputRequestRejectTool as Record<string,unknown>).callableBy === undefined);
  });

  it('reject with reason → status rejected, rejectionReason set', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestRejectTool.handler({
      id: req.id,
      reason: 'not applicable',
    }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
    assert.equal(result.rejectionReason, 'not applicable');
  });

  it('reject without reason → status rejected, no rejectionReason', async () => {
    const req = await createRequest(stacks);
    const result = await inputRequestRejectTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
    assert.ok(!result.rejectionReason);
  });

  it('reject with partial answers succeeds', async () => {
    const req = await createRequest(stacks, { answers: { text1: 'partial' } });
    const result = await inputRequestRejectTool.handler({ id: req.id }) as InputRequestDoc;
    assert.equal(result.status, 'rejected');
  });

  it('reject a completed request throws', async () => {
    const req = await createRequest(stacks, {
      status: 'completed',
      answers: { choice1: { selected: 'a' }, bool1: true, text1: 'hi' },
    });
    await assert.rejects(
      () => inputRequestRejectTool.handler({ id: req.id }),
      /request status is "completed"/i,
    );
  });

  it('throws if request not found', async () => {
    await assert.rejects(
      () => inputRequestRejectTool.handler({ id: 'ir-nonexistent' }),
      /not found/i,
    );
  });
});

// ── input-request-export tool ──────────────────────────────────────────

describe('input-request-export tool', () => {
  let stacks: StacksApi;

  beforeEach(() => {
    ({ stacks } = buildFixture());
  });
  afterEach(() => clearGuild());

  it('has name "input-request-export"', () => {
    assert.equal(inputRequestExportTool.name, 'input-request-export');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestExportTool) || (inputRequestExportTool as Record<string,unknown>).callableBy === undefined);
  });

  it('exports YAML containing id, questions, answers, message', async () => {
    const req = await createRequest(stacks, {
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
    await assert.rejects(
      () => inputRequestExportTool.handler({ id: 'ir-nonexistent' }),
      /not found/i,
    );
  });
});

// ── input-request-import tool ──────────────────────────────────────────

describe('input-request-import tool', () => {
  let stacks: StacksApi;
  let tmpDir: string;

  beforeEach(async () => {
    ({ stacks } = buildFixture());
    tmpDir = await mkdtemp(join(tmpdir(), 'ir-test-'));
  });
  afterEach(async () => {
    clearGuild();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('has name "input-request-import"', () => {
    assert.equal(inputRequestImportTool.name, 'input-request-import');
  });

  it('does not have callableBy set', () => {
    assert.ok(!('callableBy' in inputRequestImportTool) || (inputRequestImportTool as Record<string,unknown>).callableBy === undefined);
  });

  it('imports answers from a YAML file', async () => {
    const req = await createRequest(stacks);
    const filePath = join(tmpDir, 'answers.yaml');
    await writeFile(filePath, stringify({
      id: req.id,
      answers: {
        text1: 'imported answer',
        bool1: true,
      },
    }));

    const result = await inputRequestImportTool.handler({ file: filePath }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'imported answer');
    assert.equal(result.answers['bool1'], true);
  });

  it('export → edit answers → import → answers updated', async () => {
    const req = await createRequest(stacks, { answers: { text1: 'original' } });

    // Export
    const exportResult = await inputRequestExportTool.handler({ id: req.id }) as { yaml: string };

    // Modify answers in the export object
    const exported = {
      id: req.id,
      answers: { text1: 'updated answer', bool1: 'false' },
    };
    const filePath = join(tmpDir, 'modified.yaml');
    await writeFile(filePath, stringify(exported));

    const result = await inputRequestImportTool.handler({ file: filePath }) as InputRequestDoc;
    assert.equal(result.answers['text1'], 'updated answer');
    assert.equal(result.answers['bool1'], false);

    // Original export had the old answers
    assert.ok(exportResult.yaml.includes('original'));
  });

  it('import with invalid choice key throws', async () => {
    const req = await createRequest(stacks);
    const filePath = join(tmpDir, 'bad.yaml');
    await writeFile(filePath, stringify({
      id: req.id,
      answers: { choice1: { selected: 'invalid-key' } },
    }));

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /not a valid option/i,
    );
  });

  it('import targeting a completed request throws', async () => {
    const req = await createRequest(stacks, { status: 'completed', answers: {} });
    const filePath = join(tmpDir, 'completed.yaml');
    await writeFile(filePath, stringify({ id: req.id, answers: { text1: 'hi' } }));

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /request status is "completed"/i,
    );
  });

  it('import with missing id in YAML throws', async () => {
    const filePath = join(tmpDir, 'noid.yaml');
    await writeFile(filePath, stringify({ answers: { text1: 'hi' } }));

    await assert.rejects(
      () => inputRequestImportTool.handler({ file: filePath }),
      /missing required "id"/i,
    );
  });

  it('import with unknown question key throws', async () => {
    const req = await createRequest(stacks);
    const filePath = join(tmpDir, 'unknownq.yaml');
    await writeFile(filePath, stringify({
      id: req.id,
      answers: { unknownQuestion: 'value' },
    }));

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
