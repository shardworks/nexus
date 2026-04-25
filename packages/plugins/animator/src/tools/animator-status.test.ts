/**
 * Tests for the animator-status tool.
 *
 * The tool is JSON-only: empty params, returns the AnimatorStatusDoc
 * enriched with a server-computed `dispatchable` boolean (derived from
 * the canonical isDispatchable helper). CLI auto-printer pretty-prints.
 * No --json flag, no text formatter.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import animatorStatus from './animator-status.ts';
import type { AnimatorApi, AnimatorStatusDoc } from '../types.ts';

// ── Harness ─────────────────────────────────────────────────────────

let currentStatus: AnimatorStatusDoc = {
  id: 'dispatch-status',
  state: 'running',
  backoffLevel: 0,
};

function setup() {
  const apparatusMap = new Map<string, unknown>();
  const mockAnimator = {
    async getStatus(): Promise<AnimatorStatusDoc> { return currentStatus; },
    summon() { throw new Error('unused'); },
    animate() { throw new Error('unused'); },
    subscribeToSession() { return null; },
    async cancel() { throw new Error('unused'); },
    async getSessionCosts() { return new Map(); },
  } as unknown as AnimatorApi;
  apparatusMap.set('animator', mockAnimator);

  const fakeGuild: Guild = {
    home: '/tmp/animator-status-test',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },
    config<T>(): T { return {} as T; },
    writeConfig() {},
    guildConfig() { return { name: 't', nexus: '0.0.0', plugins: [] } as GuildConfig; },
    kits: () => [],
    apparatuses: () => [],
    startupWarnings() { return []; },
  };
  setGuild(fakeGuild);
}

describe('animator-status tool', () => {
  beforeEach(() => { setup(); });
  afterEach(() => { clearGuild(); });

  it('has permission read and is patron-callable', () => {
    assert.equal(animatorStatus.permission, 'read');
    assert.deepEqual(animatorStatus.callableBy, ['patron']);
  });

  it('exposes an empty params schema (no --json flag remains)', () => {
    // `tool()` wraps the raw shape with `z.object(...)` — an empty
    // shape parses cleanly and admits no keys.
    const parsed = animatorStatus.params.parse({});
    assert.deepEqual(parsed, {});
    // An unknown property is rejected (the old `json` flag is gone).
    assert.throws(() => animatorStatus.params.strict().parse({ json: true }));
  });

  it('returns the status doc enriched with dispatchable=false (paused, window not yet elapsed)', async () => {
    // Use a far-future pausedUntil so the canonical predicate evaluates
    // to false regardless of when the test runs.
    const farFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    currentStatus = {
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date(Date.now() - 60_000).toISOString(),
      pausedUntil: farFuture,
      pauseReason: 'rate-limit',
      backoffLevel: 1,
      lastTriggeringSession: 'ses-42',
    };
    const result = await animatorStatus.handler({});
    assert.deepEqual(result, { ...currentStatus, dispatchable: false });
  });

  it('returns dispatchable=true when paused window has already elapsed', async () => {
    const pastTime = new Date(Date.now() - 60 * 60_000).toISOString();
    currentStatus = {
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      pausedUntil: pastTime,
      pauseReason: 'rate-limit',
      backoffLevel: 2,
      lastTriggeringSession: 'ses-99',
    };
    const result = await animatorStatus.handler({});
    assert.deepEqual(result, { ...currentStatus, dispatchable: true });
  });

  it('returns dispatchable=true for the default running doc on a fresh install', async () => {
    currentStatus = { id: 'dispatch-status', state: 'running', backoffLevel: 0 };
    const result = await animatorStatus.handler({});
    assert.deepEqual(result, {
      id: 'dispatch-status',
      state: 'running',
      backoffLevel: 0,
      dispatchable: true,
    });
  });
});
