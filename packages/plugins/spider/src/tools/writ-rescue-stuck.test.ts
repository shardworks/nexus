/**
 * writ-rescue-stuck — unit tests.
 *
 * Covers the rescue tool's strict matcher, list mode, apply mode, legacy
 * rig cleanup, --id targeting, --format json output, the friendly
 * zero-state message, the per-writ commit / continue-on-failure
 * contract, and the supportKit registration assertion.
 *
 * Tests use the shared `buildFixture` integration harness so the Clerk +
 * Stacks + Spider triad behaves end-to-end (writ phase transitions, the
 * status-slot read-modify-write, spider.cancel's legacy-tolerance branch
 * for 'stuck' / 'blocked' rigs). The tool's handler is invoked directly
 * via its `.handler({...})` entry point — the same contract the CLI and
 * MCP engines use.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig, LoadedKit, LoadedApparatus } from '@shardworks/nexus-core';

import type { ClerkApi, WritDoc } from '@shardworks/clerk-apparatus';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { SpiderApi, RigDoc } from '../types.ts';

import writRescueStuckTool from './writ-rescue-stuck.ts';
import { createSpider } from '../spider.ts';
import {
  buildFixture,
  rigsBook as rigsBookFor,
  postWrit,
} from '../spider-test-fixture.ts';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Drive a writ open → stuck and write the legacy `engine-failure` slot.
 * Mirrors the production atomicity (transition + setWritStatus inside a
 * single transaction) so the matcher sees the final phase + slot in one
 * snapshot, just like the pre-engine-level-retry Spider produced.
 */
async function makeLegacyStuck(
  fix: ReturnType<typeof buildFixture>,
  writId: string,
  options: { retryable?: boolean; observedAt?: string; detail?: string } = {},
): Promise<WritDoc> {
  const { stacks, clerk } = fix;
  await stacks.transaction(async () => {
    await clerk.transition(writId, 'stuck', { resolution: 'legacy engine-failure' });
    await clerk.setWritStatus(writId, 'spider', {
      stuckCause: 'engine-failure',
      retryable: options.retryable,
      observedAt: options.observedAt ?? new Date().toISOString(),
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
    });
  });
  const updated = await clerk.show(writId);
  return updated;
}

/**
 * Drive a writ open → stuck with a dependency-cause slot (`failed-blocker`
 * or `cycle`). These are autoUnstick's domain — the rescue tool must
 * never touch them.
 */
async function makeDependencyStuck(
  fix: ReturnType<typeof buildFixture>,
  writId: string,
  cause: 'failed-blocker' | 'cycle',
  blockerIds: string[] = [],
): Promise<WritDoc> {
  const { stacks, clerk } = fix;
  await stacks.transaction(async () => {
    await clerk.transition(writId, 'stuck', { resolution: 'dependency stuck' });
    await clerk.setWritStatus(writId, 'spider', {
      stuckCause: cause,
      blockerIds,
      observedAt: new Date().toISOString(),
    });
  });
  return clerk.show(writId);
}

/** Drive a writ open → stuck with no `status.spider` slot at all. */
async function makeOperatorStuck(
  fix: ReturnType<typeof buildFixture>,
  writId: string,
): Promise<WritDoc> {
  await fix.clerk.transition(writId, 'stuck', { resolution: 'operator-stuck' });
  return fix.clerk.show(writId);
}

/** Seed a rig record directly into the rigs book at a given status. */
async function seedRig(
  stacks: StacksApi,
  writId: string,
  status: RigDoc['status'] | 'stuck' | 'blocked',
  id?: string,
): Promise<string> {
  const book = rigsBookFor(stacks);
  const rigId = id ?? `rig-${writId}-${status}-${Math.random().toString(36).slice(2, 8)}`;
  await book.put({
    id: rigId,
    writId,
    // The persisted status field tolerates legacy strings on read; the
    // type assertion mirrors the rig-list filter signature that already
    // accepts 'stuck' | 'blocked'.
    status: status as RigDoc['status'],
    engines: [],
    createdAt: new Date().toISOString(),
  });
  return rigId;
}

// ── Tool registration assertion (D-x covered separately) ────────────────

describe('writ-rescue-stuck — registration', () => {
  it('is exported from spider supportKit.tools', () => {
    const spiderPlugin = createSpider();
    const kit = spiderPlugin.apparatus.supportKit as {
      tools?: Array<{ name: string }>;
    };
    const tools = kit.tools ?? [];
    const names = tools.map((t) => t.name);
    assert.ok(
      names.includes('writ-rescue-stuck'),
      `expected supportKit.tools to include "writ-rescue-stuck"; got ${JSON.stringify(names)}`,
    );
  });

  it('declares write permission and the strict params shape', () => {
    assert.equal(writRescueStuckTool.name, 'writ-rescue-stuck');
    assert.equal(writRescueStuckTool.permission, 'write');

    const empty = writRescueStuckTool.params.parse({});
    assert.equal(empty.apply, false, 'apply defaults to false');
    assert.equal(empty.format, 'text', 'format defaults to text');
    assert.equal(empty.id, undefined, 'id is optional');

    const full = writRescueStuckTool.params.parse({
      id: 'w-abc123',
      apply: true,
      format: 'json',
    });
    assert.equal(full.id, 'w-abc123');
    assert.equal(full.apply, true);
    assert.equal(full.format, 'json');

    const bad = writRescueStuckTool.params.safeParse({ format: 'xml' });
    assert.ok(!bad.success, '"xml" must not be a valid format');
  });
});

// ── List mode ──────────────────────────────────────────────────────────

describe('writ-rescue-stuck — list mode', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('returns the friendly zero-state message and exits 0 when nothing matches', async () => {
    // Seed only non-matching rows: a dependency stuck, an operator stuck, an
    // open writ, and a completed writ. The matcher must reject all of them.
    const open = await postWrit(fix.clerk, 'open writ');
    const dep = await postWrit(fix.clerk, 'dep stuck');
    const op = await postWrit(fix.clerk, 'operator stuck');
    await makeDependencyStuck(fix, dep.id, 'failed-blocker', ['w-fake']);
    await makeOperatorStuck(fix, op.id);
    void open; // referenced for clarity; no further setup needed

    const text = await writRescueStuckTool.handler({ apply: false, format: 'text' });
    assert.equal(typeof text, 'string');
    assert.ok(
      (text as string).includes('No legacy engine-failure stuck writs found'),
      `expected the verbose zero-state line; got: ${text}`,
    );

    const json = (await writRescueStuckTool.handler({ apply: false, format: 'json' })) as {
      mode: string;
      candidates: unknown[];
    };
    assert.equal(json.mode, 'list');
    assert.deepEqual(json.candidates, []);
  });

  it('lists only legacy engine-failure stucks alongside dependency-cause + operator-stuck rows', async () => {
    const w1 = await postWrit(fix.clerk, 'legacy A');
    const w2 = await postWrit(fix.clerk, 'legacy B');
    const dep = await postWrit(fix.clerk, 'dep failed-blocker');
    const cyc = await postWrit(fix.clerk, 'dep cycle');
    const op = await postWrit(fix.clerk, 'operator stuck');

    await makeLegacyStuck(fix, w1.id, { retryable: true, observedAt: '2025-09-01T00:00:00.000Z' });
    await makeLegacyStuck(fix, w2.id, { retryable: false });
    await makeDependencyStuck(fix, dep.id, 'failed-blocker', ['w-fake']);
    await makeDependencyStuck(fix, cyc.id, 'cycle', [cyc.id]);
    await makeOperatorStuck(fix, op.id);

    const json = (await writRescueStuckTool.handler({ apply: false, format: 'json' })) as {
      mode: string;
      candidates: Array<{
        writId: string;
        title: string;
        rigCount: number;
        retryable?: boolean;
        observedAt?: string;
      }>;
    };

    assert.equal(json.mode, 'list');
    const ids = new Set(json.candidates.map((c) => c.writId));
    assert.ok(ids.has(w1.id), 'legacy A must be in the candidate set');
    assert.ok(ids.has(w2.id), 'legacy B must be in the candidate set');
    assert.ok(!ids.has(dep.id), 'failed-blocker stuck must not be in the candidate set');
    assert.ok(!ids.has(cyc.id), 'cycle stuck must not be in the candidate set');
    assert.ok(!ids.has(op.id), 'operator-stuck (no slot) must not be in the candidate set');
    assert.equal(json.candidates.length, 2, 'exactly two legacy rows expected');

    const a = json.candidates.find((c) => c.writId === w1.id)!;
    assert.equal(a.title, 'legacy A');
    assert.equal(a.retryable, true);
    assert.equal(a.observedAt, '2025-09-01T00:00:00.000Z');
  });

  it('reports rigCount per candidate, drawn from the persisted rigs book', async () => {
    const w1 = await postWrit(fix.clerk, 'legacy with rigs');
    await makeLegacyStuck(fix, w1.id);
    await seedRig(fix.stacks, w1.id, 'stuck', 'rig-leg-1');
    await seedRig(fix.stacks, w1.id, 'blocked', 'rig-leg-2');
    await seedRig(fix.stacks, w1.id, 'failed', 'rig-leg-3');

    const json = (await writRescueStuckTool.handler({ apply: false, format: 'json' })) as {
      candidates: Array<{ writId: string; rigCount: number }>;
    };
    const row = json.candidates.find((c) => c.writId === w1.id);
    assert.ok(row, 'expected the legacy candidate row');
    assert.equal(row!.rigCount, 3, 'rigCount must include every persisted rig for the writ');
  });

  it('text rendering surfaces id, title, rigs, retryable, and observedAt columns', async () => {
    const w1 = await postWrit(fix.clerk, 'legacy txt');
    await makeLegacyStuck(fix, w1.id, { retryable: true, observedAt: '2025-10-10T12:00:00.000Z' });

    const text = (await writRescueStuckTool.handler({ apply: false, format: 'text' })) as string;
    assert.ok(text.includes('ID'), 'header column ID');
    assert.ok(text.includes('TITLE'), 'header column TITLE');
    assert.ok(text.includes('RIGS'), 'header column RIGS');
    assert.ok(text.includes('RETRYABLE'), 'header column RETRYABLE');
    assert.ok(text.includes('OBSERVED'), 'header column OBSERVED');
    assert.ok(text.includes('legacy txt'), 'must surface the writ title');
    assert.ok(text.includes('2025-10-10T12:00:00.000Z'), 'must surface observedAt');
    assert.ok(text.includes('--apply'), 'text footer must hint at --apply');
  });
});

// ── Apply mode ─────────────────────────────────────────────────────────

describe('writ-rescue-stuck — apply mode', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('transitions matched writs stuck → open, clears status.spider, sets a templated resolution', async () => {
    const w1 = await postWrit(fix.clerk, 'rescue me 1');
    const w2 = await postWrit(fix.clerk, 'rescue me 2');
    await makeLegacyStuck(fix, w1.id, {
      retryable: true,
      observedAt: '2025-09-15T10:11:12.000Z',
    });
    await makeLegacyStuck(fix, w2.id);

    const result = (await writRescueStuckTool.handler({ apply: true, format: 'json' })) as {
      mode: string;
      summary: { succeeded: number; failed: number; skipped: number; totalRigsCancelled: number };
      applied: Array<{
        writId: string;
        status: 'rescued' | 'failed' | 'skipped';
        rigsCancelled: number;
        resolution?: string;
      }>;
    };

    assert.equal(result.mode, 'apply');
    assert.equal(result.summary.succeeded, 2, 'both writs must rescue');
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.skipped, 0);

    // Each rescued row carries a templated resolution that names the
    // tool, the legacy cause, and the original observedAt.
    for (const row of result.applied) {
      assert.equal(row.status, 'rescued');
      assert.ok(row.resolution, 'every rescued row must report its resolution string');
      assert.ok(row.resolution!.includes('writ-rescue-stuck'), 'resolution names the tool');
      assert.ok(row.resolution!.includes('engine-failure'), 'resolution names the legacy cause');
    }

    // Substrate verification: phase=open and status.spider === {} on each writ.
    for (const w of [w1, w2]) {
      const updated = await fix.clerk.show(w.id);
      assert.equal(updated.phase, 'open', `${w.id} must be open after rescue`);
      const spiderSlot = updated.status?.spider as Record<string, unknown> | undefined;
      assert.ok(spiderSlot !== undefined, 'spider slot is set (cleared to empty object)');
      assert.deepEqual(spiderSlot, {}, 'spider slot must be cleared to {}');
    }
  });

  it('cancels every legacy stuck/blocked rig per rescued writ via spider.cancel', async () => {
    const w1 = await postWrit(fix.clerk, 'rig cleanup');
    await makeLegacyStuck(fix, w1.id);
    const stuckRigId = await seedRig(fix.stacks, w1.id, 'stuck', 'rig-stuck-x');
    const blockedRigId = await seedRig(fix.stacks, w1.id, 'blocked', 'rig-blocked-y');
    // A pre-existing terminal rig must be left alone — only legacy
    // 'stuck' / 'blocked' get cancelled.
    const failedRigId = await seedRig(fix.stacks, w1.id, 'failed', 'rig-failed-z');

    const result = (await writRescueStuckTool.handler({ apply: true, format: 'json' })) as {
      summary: { totalRigsCancelled: number; succeeded: number };
      applied: Array<{ writId: string; rigsCancelled: number }>;
    };
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.summary.totalRigsCancelled, 2, 'two legacy rigs cancelled');
    const row = result.applied.find((r) => r.writId === w1.id)!;
    assert.equal(row.rigsCancelled, 2);

    const book = rigsBookFor(fix.stacks);
    const stuckRig = await book.get(stuckRigId);
    const blockedRig = await book.get(blockedRigId);
    const failedRig = await book.get(failedRigId);
    assert.equal(stuckRig?.status, 'cancelled', 'legacy stuck rig must be cancelled');
    assert.equal(blockedRig?.status, 'cancelled', 'legacy blocked rig must be cancelled');
    assert.equal(failedRig?.status, 'failed', 'pre-existing failed rig must be untouched');
  });

  it('per-writ failures do not abort the bulk run', async () => {
    const ok1 = await postWrit(fix.clerk, 'rescuable 1');
    const ok2 = await postWrit(fix.clerk, 'rescuable 2');
    const broken = await postWrit(fix.clerk, 'broken transition');
    await makeLegacyStuck(fix, ok1.id);
    await makeLegacyStuck(fix, ok2.id);
    await makeLegacyStuck(fix, broken.id);

    // Inject a per-writ failure: wrap clerk.transition so that the
    // broken writ's stuck → open call throws. The other two rescue
    // attempts must still succeed and the report must enumerate the
    // failure cleanly.
    const realTransition = fix.clerk.transition.bind(fix.clerk);
    fix.clerk.transition = async (id: string, to, fields) => {
      if (id === broken.id && to === 'open') {
        throw new Error('synthetic transition failure');
      }
      return realTransition(id, to, fields);
    };

    const result = (await writRescueStuckTool.handler({ apply: true, format: 'json' })) as {
      summary: { succeeded: number; failed: number; skipped: number };
      applied: Array<{ writId: string; status: string; error?: string }>;
    };

    assert.equal(result.summary.succeeded, 2, 'two writs rescued despite one failure');
    assert.equal(result.summary.failed, 1, 'one writ reported as failed');
    const failedRow = result.applied.find((r) => r.writId === broken.id);
    assert.ok(failedRow, 'broken writ must appear in the apply report');
    assert.equal(failedRow!.status, 'failed');
    assert.ok(
      failedRow!.error?.includes('synthetic transition failure'),
      'the synthetic error must propagate into the report',
    );

    // The two healthy writs landed at phase=open.
    for (const w of [ok1, ok2]) {
      const fresh = await fix.clerk.show(w.id);
      assert.equal(fresh.phase, 'open');
    }
    // The broken writ stayed stuck (transition was rejected before any
    // status-slot mutation could fire).
    const brokenFresh = await fix.clerk.show(broken.id);
    assert.equal(brokenFresh.phase, 'stuck', 'broken writ must remain stuck');
  });

  it('text rendering of an apply run reports per-writ rows and a totals line', async () => {
    const w1 = await postWrit(fix.clerk, 'text apply');
    await makeLegacyStuck(fix, w1.id);

    const text = (await writRescueStuckTool.handler({ apply: true, format: 'text' })) as string;
    assert.ok(text.includes('rescued'), 'must surface a rescued row');
    assert.ok(text.includes(w1.title), 'must include the writ title');
    assert.ok(/summary:.*rescued.*failed.*skipped/i.test(text), 'must include a summary line');
  });

  it('emits the friendly zero-state message in apply mode when there are no candidates', async () => {
    const text = (await writRescueStuckTool.handler({ apply: true, format: 'text' })) as string;
    assert.ok(
      text.includes('No legacy engine-failure stuck writs found'),
      'apply mode must also produce the friendly zero-state message',
    );
    const json = (await writRescueStuckTool.handler({ apply: true, format: 'json' })) as {
      summary: { succeeded: number; failed: number };
    };
    assert.equal(json.summary.succeeded, 0);
    assert.equal(json.summary.failed, 0);
  });
});

// ── --id targeting ─────────────────────────────────────────────────────

describe('writ-rescue-stuck — --id targeting', () => {
  let fix: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fix = buildFixture();
  });

  afterEach(() => {
    clearGuild();
  });

  it('rescues only the supplied legacy writ when matched', async () => {
    const target = await postWrit(fix.clerk, 'targeted rescue');
    const sibling = await postWrit(fix.clerk, 'should-not-rescue');
    await makeLegacyStuck(fix, target.id);
    await makeLegacyStuck(fix, sibling.id);

    const result = (await writRescueStuckTool.handler({
      id: target.id,
      apply: true,
      format: 'json',
    })) as {
      summary: { succeeded: number };
      applied: Array<{ writId: string }>;
    };
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].writId, target.id);

    const t = await fix.clerk.show(target.id);
    const s = await fix.clerk.show(sibling.id);
    assert.equal(t.phase, 'open', 'target writ must be rescued');
    assert.equal(s.phase, 'stuck', 'sibling writ must be left alone');
  });

  it('rejects an --id whose writ phase is not stuck before any mutation', async () => {
    const w = await postWrit(fix.clerk, 'open writ');
    const json = (await writRescueStuckTool.handler({
      id: w.id,
      apply: true,
      format: 'json',
    })) as { matches: boolean; reason: string };
    assert.equal(json.matches, false);
    assert.equal(json.reason, 'predicate-mismatch');

    const fresh = await fix.clerk.show(w.id);
    assert.equal(fresh.phase, 'open', 'writ phase must not have been mutated');
  });

  it('rejects an --id whose stuckCause is not the legacy engine-failure value', async () => {
    const w = await postWrit(fix.clerk, 'dep stuck');
    await makeDependencyStuck(fix, w.id, 'failed-blocker', ['w-x']);

    const text = (await writRescueStuckTool.handler({
      id: w.id,
      apply: true,
      format: 'text',
    })) as string;
    assert.ok(
      text.includes('does not match the strict rescue predicate'),
      `expected predicate-mismatch text; got: ${text}`,
    );

    const fresh = await fix.clerk.show(w.id);
    assert.equal(fresh.phase, 'stuck', 'phase must remain stuck');
    const slot = fresh.status?.spider as { stuckCause?: string } | undefined;
    assert.equal(slot?.stuckCause, 'failed-blocker', 'slot must remain unchanged');
  });

  it('rejects an --id whose writ does not exist', async () => {
    const json = (await writRescueStuckTool.handler({
      id: 'w-does-not-exist',
      apply: true,
      format: 'json',
    })) as { matches: boolean; reason: string };
    assert.equal(json.matches, false);
    assert.equal(json.reason, 'not-found');
  });

  it('lists a single matched candidate when --id targets a legacy writ in list mode', async () => {
    const target = await postWrit(fix.clerk, 'list one');
    await makeLegacyStuck(fix, target.id);

    const json = (await writRescueStuckTool.handler({
      id: target.id,
      apply: false,
      format: 'json',
    })) as { mode: string; candidates: Array<{ writId: string }> };
    assert.equal(json.mode, 'list');
    assert.equal(json.candidates.length, 1);
    assert.equal(json.candidates[0].writId, target.id);
  });
});
