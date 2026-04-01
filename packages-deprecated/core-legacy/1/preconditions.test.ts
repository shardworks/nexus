import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readPreconditions,
  checkOne,
  checkPreconditions,
  checkAllPreconditions,
  checkToolPreconditions,
} from './preconditions.ts';
import type { Precondition } from './preconditions.ts';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preconditions-test-'));
}

function writeDescriptor(dir: string, descriptor: Record<string, unknown>): string {
  const p = path.join(dir, 'nexus-tool.json');
  fs.writeFileSync(p, JSON.stringify(descriptor));
  return p;
}

// ── readPreconditions ────────────────────────────────────────────────────

describe('readPreconditions', () => {
  it('returns empty array for missing file', () => {
    assert.deepEqual(readPreconditions('/nonexistent/path.json'), []);
  });

  it('returns empty array when no preconditions field', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, { entry: 'handler.ts' });
    assert.deepEqual(readPreconditions(p), []);
    fs.rmSync(dir, { recursive: true });
  });

  it('parses valid command precondition', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, {
      entry: 'handler.ts',
      preconditions: [
        { check: 'command', command: 'git', message: 'Install git' },
      ],
    });
    const result = readPreconditions(p);
    assert.equal(result.length, 1);
    assert.equal(result[0].check, 'command');
    assert.equal((result[0] as { command: string }).command, 'git');
    fs.rmSync(dir, { recursive: true });
  });

  it('parses valid command-output precondition', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, {
      entry: 'handler.ts',
      preconditions: [
        { check: 'command-output', command: 'git --version', pattern: 'git version', message: 'Git not working' },
      ],
    });
    const result = readPreconditions(p);
    assert.equal(result.length, 1);
    assert.equal(result[0].check, 'command-output');
    fs.rmSync(dir, { recursive: true });
  });

  it('parses valid env precondition', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, {
      entry: 'handler.ts',
      preconditions: [
        { check: 'env', variable: 'HOME', message: 'HOME not set' },
      ],
    });
    const result = readPreconditions(p);
    assert.equal(result.length, 1);
    assert.equal(result[0].check, 'env');
    assert.equal((result[0] as { variable: string }).variable, 'HOME');
    fs.rmSync(dir, { recursive: true });
  });

  it('skips invalid entries', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, {
      entry: 'handler.ts',
      preconditions: [
        { check: 'unknown-type', message: 'whatever' },
        { check: 'command' }, // missing message
        'not-an-object',
        null,
        { check: 'command', command: 'git', message: 'Install git' }, // valid
      ],
    });
    const result = readPreconditions(p);
    assert.equal(result.length, 1);
    assert.equal(result[0].check, 'command');
    fs.rmSync(dir, { recursive: true });
  });
});

// ── checkOne ─────────────────────────────────────────────────────────────

describe('checkOne', () => {
  it('command: passes for a command that exists (node)', () => {
    const result = checkOne({
      check: 'command',
      command: 'node',
      message: 'Node not found',
    });
    assert.equal(result.passed, true);
    assert.equal(result.message, undefined);
  });

  it('command: fails for a command that does not exist', () => {
    const result = checkOne({
      check: 'command',
      command: 'nonexistent-binary-xyz-12345',
      message: 'Install the xyz tool',
    });
    assert.equal(result.passed, false);
    assert.equal(result.message, 'Install the xyz tool');
  });

  it('command-output: passes when output matches pattern', () => {
    const result = checkOne({
      check: 'command-output',
      command: 'node --version',
      pattern: 'v\\d+',
      message: 'Node version check failed',
    });
    assert.equal(result.passed, true);
  });

  it('command-output: fails when output does not match pattern', () => {
    const result = checkOne({
      check: 'command-output',
      command: 'node --version',
      pattern: 'python',
      message: 'Expected python, got node',
    });
    assert.equal(result.passed, false);
    assert.equal(result.message, 'Expected python, got node');
  });

  it('command-output: fails gracefully when command does not exist', () => {
    const result = checkOne({
      check: 'command-output',
      command: 'nonexistent-binary-xyz-12345 --version',
      pattern: 'anything',
      message: 'Binary not found',
    });
    assert.equal(result.passed, false);
    assert.equal(result.message, 'Binary not found');
  });

  it('env: passes when variable is set', () => {
    // HOME should always be set in test environments
    const result = checkOne({
      check: 'env',
      variable: 'HOME',
      message: 'HOME not set',
    });
    assert.equal(result.passed, true);
  });

  it('env: fails when variable is not set', () => {
    const result = checkOne({
      check: 'env',
      variable: 'NEXUS_TEST_NONEXISTENT_VAR_XYZ',
      message: 'Set the var',
    });
    assert.equal(result.passed, false);
    assert.equal(result.message, 'Set the var');
  });

  it('env: fails when variable is empty string', () => {
    const key = 'NEXUS_TEST_EMPTY_VAR';
    process.env[key] = '';
    try {
      const result = checkOne({
        check: 'env',
        variable: key,
        message: 'Var is empty',
      });
      assert.equal(result.passed, false);
    } finally {
      delete process.env[key];
    }
  });
});

// ── checkPreconditions ───────────────────────────────────────────────────

describe('checkPreconditions', () => {
  it('returns empty array for no preconditions', () => {
    assert.deepEqual(checkPreconditions([]), []);
  });

  it('returns mixed results', () => {
    const preconditions: Precondition[] = [
      { check: 'command', command: 'node', message: 'Install node' },
      { check: 'command', command: 'nonexistent-xyz-99', message: 'Install xyz' },
    ];
    const results = checkPreconditions(preconditions);
    assert.equal(results.length, 2);
    assert.equal(results[0].passed, true);
    assert.equal(results[1].passed, false);
  });
});

// ── checkAllPreconditions ────────────────────────────────────────────────

describe('checkAllPreconditions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reports all tools, including those with no preconditions', () => {
    // Set up a minimal guild structure
    const implDir = path.join(tmpDir, 'tools', 'dispatch');
    fs.mkdirSync(implDir, { recursive: true });
    fs.writeFileSync(
      path.join(implDir, 'nexus-tool.json'),
      JSON.stringify({ entry: 'handler.ts' }),
    );

    const engineDir = path.join(tmpDir, 'engines', 'manifest');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(
      path.join(engineDir, 'nexus-engine.json'),
      JSON.stringify({ entry: 'index.ts' }),
    );

    const config = {
      tools: { dispatch: {} },
      engines: { manifest: {} },
    };

    const results = checkAllPreconditions(tmpDir, config);
    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'dispatch');
    assert.equal(results[0].available, true);
    assert.equal(results[0].checks.length, 0);
    assert.equal(results[1].name, 'manifest');
    assert.equal(results[1].available, true);
  });

  it('detects failed preconditions', () => {
    const implDir = path.join(tmpDir, 'tools', 'github-tool');
    fs.mkdirSync(implDir, { recursive: true });
    fs.writeFileSync(
      path.join(implDir, 'nexus-tool.json'),
      JSON.stringify({
        entry: 'handler.ts',
        preconditions: [
          { check: 'command', command: 'nonexistent-xyz-99', message: 'Install xyz' },
        ],
      }),
    );

    const config = {
      tools: { 'github-tool': {} },
      engines: {},
    };

    const results = checkAllPreconditions(tmpDir, config);
    assert.equal(results.length, 1);
    assert.equal(results[0].available, false);
    assert.equal(results[0].failures.length, 1);
    assert.equal(results[0].failures[0], 'Install xyz');
  });
});

// ── checkToolPreconditions ───────────────────────────────────────────────

describe('checkToolPreconditions', () => {
  it('returns results for a descriptor with preconditions', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, {
      entry: 'handler.ts',
      preconditions: [
        { check: 'command', command: 'node', message: 'Install node' },
      ],
    });
    const results = checkToolPreconditions(p);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, true);
    fs.rmSync(dir, { recursive: true });
  });

  it('returns empty for no preconditions', () => {
    const dir = makeTmpDir();
    const p = writeDescriptor(dir, { entry: 'handler.ts' });
    const results = checkToolPreconditions(p);
    assert.equal(results.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});
