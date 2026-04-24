/**
 * Tests for the animator-status tool.
 *
 * Covers the text / JSON output variants and the AnimatorApi read path.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setGuild, clearGuild } from '@shardworks/nexus-core';
import type { Guild, GuildConfig } from '@shardworks/nexus-core';

import animatorStatus from './animator-status.ts';
import type { AnimatorApi, AnimatorStatusDoc } from '../types.ts';

// ── Harness ─────────────────────────────────────────────────────────

let currentStatus: AnimatorStatusDoc = {
  id: 'current',
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

  it('returns the raw status doc when --json is set', async () => {
    currentStatus = {
      id: 'current',
      state: 'paused',
      pausedSince: '2026-04-24T00:00:00.000Z',
      pausedUntil: '2026-04-24T00:15:00.000Z',
      pauseReason: 'rate-limit',
      backoffLevel: 1,
      lastTriggeringSession: 'ses-42',
    };
    const result = await animatorStatus.handler({ json: true });
    assert.ok(typeof result === 'object');
    assert.equal((result as AnimatorStatusDoc).state, 'paused');
    assert.equal((result as AnimatorStatusDoc).backoffLevel, 1);
    assert.equal((result as AnimatorStatusDoc).lastTriggeringSession, 'ses-42');
  });

  it('returns a human-readable multi-line string by default', async () => {
    currentStatus = {
      id: 'current',
      state: 'paused',
      pausedSince: '2026-04-24T00:00:00.000Z',
      pausedUntil: new Date(Date.now() + 60_000).toISOString(),
      pauseReason: 'rate-limit',
      backoffLevel: 2,
      lastTriggeringSession: 'ses-77',
    };
    const result = await animatorStatus.handler({});
    assert.ok(typeof result === 'string');
    assert.match(result as string, /State:\s+paused/);
    assert.match(result as string, /Back-off level:\s+2/);
    assert.match(result as string, /Pause reason:\s+rate-limit/);
    assert.match(result as string, /Triggering sess.:\s+ses-77/);
  });

  it('covers the running-state path (default install)', async () => {
    currentStatus = { id: 'current', state: 'running', backoffLevel: 0 };
    const result = await animatorStatus.handler({});
    assert.ok(typeof result === 'string');
    assert.match(result as string, /State:\s+running/);
    assert.ok(!(result as string).includes('Paused'), 'no paused-only fields when running');
  });
});
