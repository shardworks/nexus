/**
 * Verify engine — unit tests.
 *
 * Drives the engine's `run()` directly with real shell commands (`true` /
 * `false` / `echo`) against a tmp-dir cwd built into the fake
 * `context.upstream.draft.path`. The engine has no Guild/Animator/Stacks
 * dependencies so no `setGuild` fixture is required.
 *
 * Acceptance Signal #3 from the commission brief:
 *   - both checks pass → no throw, yields contain both MechanicalCheck entries
 *   - build fails / test passes → throws and the message embeds both outputs
 *   - build passes / test fails → throws and the message embeds both outputs
 *   - both fail → throws with both outputs and demonstrates no short-circuit
 *   - both vars missing → throws a configuration-error message
 *   - one var missing → the present check still runs and the engine
 *     completes when it passes
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EngineRunContext } from '@shardworks/fabricator-apparatus';

import verifyEngine from './verify.ts';
import type { DraftYields, VerifyYields } from '../types.ts';

// ── Fixtures ──────────────────────────────────────────────────────────

let workCwd: string;

before(async () => {
  workCwd = await mkdtemp(join(tmpdir(), 'verify-engine-'));
});

after(async () => {
  await rm(workCwd, { recursive: true, force: true });
});

function makeDraft(): DraftYields {
  return {
    draftId: 'd1',
    codexName: 'c1',
    branch: 'draft/abc',
    path: workCwd,
    baseSha: 'sha1',
  };
}

function makeContext(upstream: Record<string, unknown> = {}): EngineRunContext {
  return { rigId: 'rig-1', engineId: 'verify', upstream: { draft: makeDraft(), ...upstream } };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('verify engine — clockwork mechanical-check gate', () => {
  it('both checks pass → completes; yields contain both MechanicalCheck entries', async () => {
    const result = await verifyEngine.run(
      { buildCommand: 'true', testCommand: 'true' },
      makeContext(),
    );

    assert.equal(result.status, 'completed');
    const completed = result as { status: 'completed'; yields: VerifyYields };
    assert.equal(completed.yields.checks.length, 2);
    const names = completed.yields.checks.map((c) => c.name).sort();
    assert.deepEqual(names, ['build', 'test']);
    for (const check of completed.yields.checks) {
      assert.equal(check.passed, true, `${check.name} should have passed`);
      assert.equal(typeof check.output, 'string');
      assert.equal(typeof check.durationMs, 'number');
    }
  });

  it('build fails, test passes → throws; message embeds both per-check outputs', async () => {
    await assert.rejects(
      () =>
        verifyEngine.run(
          {
            buildCommand: 'echo BUILD_OUTPUT_LINE; exit 1',
            testCommand: 'echo TEST_OUTPUT_LINE',
          },
          makeContext(),
        ),
      (err: Error) => {
        // Summary header reflects both verdicts.
        assert.match(err.message, /^Verify failed:/);
        assert.match(err.message, /build FAILED/);
        assert.match(err.message, /test PASSED/);
        // Per-check sections embed the actual output of each check.
        assert.match(err.message, /BUILD_OUTPUT_LINE/);
        assert.match(err.message, /TEST_OUTPUT_LINE/);
        return true;
      },
    );
  });

  it('build passes, test fails → throws; message embeds both per-check outputs', async () => {
    await assert.rejects(
      () =>
        verifyEngine.run(
          {
            buildCommand: 'echo BUILD_OK_LINE',
            testCommand: 'echo TEST_FAIL_LINE; exit 1',
          },
          makeContext(),
        ),
      (err: Error) => {
        assert.match(err.message, /^Verify failed:/);
        assert.match(err.message, /build PASSED/);
        assert.match(err.message, /test FAILED/);
        assert.match(err.message, /BUILD_OK_LINE/);
        assert.match(err.message, /TEST_FAIL_LINE/);
        return true;
      },
    );
  });

  it('both fail → throws with both outputs (no short-circuit on the first failure)', async () => {
    await assert.rejects(
      () =>
        verifyEngine.run(
          {
            buildCommand: 'echo BUILD_BROKEN; exit 2',
            testCommand: 'echo TESTS_BROKEN; exit 3',
          },
          makeContext(),
        ),
      (err: Error) => {
        assert.match(err.message, /build FAILED/);
        assert.match(err.message, /test FAILED/);
        // Both outputs survive — proves the test ran even though build failed.
        assert.match(err.message, /BUILD_BROKEN/);
        assert.match(err.message, /TESTS_BROKEN/);
        return true;
      },
    );
  });

  it('both vars missing → throws a configuration-error message naming both variables', async () => {
    await assert.rejects(
      () => verifyEngine.run({}, makeContext()),
      (err: Error) => {
        assert.match(err.message, /buildCommand/);
        assert.match(err.message, /testCommand/);
        // Should not look like a normal "Verify failed" runtime message.
        assert.doesNotMatch(err.message, /^Verify failed:/);
        return true;
      },
    );
  });

  it('only buildCommand configured → runs build; engine completes when it passes', async () => {
    const result = await verifyEngine.run(
      { buildCommand: 'true' },
      makeContext(),
    );

    assert.equal(result.status, 'completed');
    const completed = result as { status: 'completed'; yields: VerifyYields };
    assert.equal(completed.yields.checks.length, 1);
    assert.equal(completed.yields.checks[0].name, 'build');
    assert.equal(completed.yields.checks[0].passed, true);
  });

  it('only testCommand configured → runs test; engine completes when it passes', async () => {
    const result = await verifyEngine.run(
      { testCommand: 'true' },
      makeContext(),
    );

    assert.equal(result.status, 'completed');
    const completed = result as { status: 'completed'; yields: VerifyYields };
    assert.equal(completed.yields.checks.length, 1);
    assert.equal(completed.yields.checks[0].name, 'test');
    assert.equal(completed.yields.checks[0].passed, true);
  });

  it('declares no retry policy (deterministic regressions surface immediately)', () => {
    assert.equal(verifyEngine.retry, undefined, 'verify engine must not declare a retry policy');
  });

  it('declares no collect() method (clockwork engine, no anima session)', () => {
    assert.equal(verifyEngine.collect, undefined, 'verify engine must not declare collect()');
  });

  it('exposes id "verify"', () => {
    assert.equal(verifyEngine.id, 'verify');
  });
});
