/**
 * Tests for the animator-status tool.
 *
 * The tool is JSON-only: empty params, returns the AnimatorStatusDoc
 * verbatim, CLI auto-printer pretty-prints. No --json flag, no text
 * formatter.
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

  it('returns the status doc verbatim (paused shape)', async () => {
    currentStatus = {
      id: 'dispatch-status',
      state: 'paused',
      pausedSince: '2026-04-24T00:00:00.000Z',
      pausedUntil: '2026-04-24T00:15:00.000Z',
      pauseReason: 'rate-limit',
      backoffLevel: 1,
      lastTriggeringSession: 'ses-42',
    };
    const result = await animatorStatus.handler({});
    assert.deepEqual(result, currentStatus);
  });

  it('returns the default running doc on a fresh install', async () => {
    currentStatus = { id: 'dispatch-status', state: 'running', backoffLevel: 0 };
    const result = await animatorStatus.handler({});
    assert.deepEqual(result, {
      id: 'dispatch-status',
      state: 'running',
      backoffLevel: 0,
    });
  });
});
