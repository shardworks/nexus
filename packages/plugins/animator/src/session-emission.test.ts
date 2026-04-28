/**
 * Animator — session emission helper tests.
 *
 * Covers the three surviving event-emit sites declared via the events
 * kit-contribution:
 *
 *   - animator.session.started fires for newly-running sessions (via
 *     the helper)
 *   - animator.session.ended fires for terminal sessions, with the
 *     agreed payload
 *   - animator.session.record-failed fires from the SessionDoc /
 *     transcript write-failure paths with `phase` from the catalog
 *     taxonomy (`'insert' | 'write-record' | 'update-row'`)
 *
 * Plus the soft-dependency contract: when the Clockworks is not
 * installed, every helper silently no-ops and never throws.
 *
 * Plus the kit-declaration shape contract: the apparatus's
 * `supportKit.events` must expose exactly the three declared names with
 * their descriptions — the cheapest guard against rename + kit-declared
 * surface drift.
 *
 * The terminal-site coverage (in-process attached, detached, orphan
 * recovery, rate-limit pre-check rejection) is asserted in a separate
 * end-to-end animator-emission integration test
 * (`session-emission.integration.test.ts`) that drives the actual
 * dispatch paths.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clearGuild, generateId, setGuild } from '@shardworks/nexus-core';
import type {
  Guild,
  GuildConfig,
  LoadedApparatus,
  LoadedKit,
} from '@shardworks/nexus-core';

import { createStacksApparatus } from '@shardworks/stacks-apparatus';
import { MemoryBackend } from '@shardworks/stacks-apparatus/testing';
import type { Book, StacksApi } from '@shardworks/stacks-apparatus';

import type { ClockworksApi, EventDoc } from '@shardworks/clockworks-apparatus';

import { createAnimator } from './animator.ts';
import {
  ANIMATOR_EVENTS,
  emitSessionEnded,
  emitSessionRecordFailed,
  emitSessionStarted,
} from './session-emission.ts';
import type { SessionDoc } from './types.ts';

// ── Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  stacks: StacksApi;
  clockworks: ClockworksApi;
  eventsBook: Book<EventDoc>;
  apparatusMap: Map<string, unknown>;
}

interface FixtureOptions {
  /** Set to false to omit the Clockworks — exercises the no-op contract. */
  withClockworks?: boolean;
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const withClockworks = options.withClockworks ?? true;

  const backend = new MemoryBackend();
  const stacksPlugin = createStacksApparatus(backend);

  const apparatusMap = new Map<string, unknown>();
  const guildConfig: GuildConfig = {
    name: 'test-guild',
    nexus: '0.0.0',
    plugins: [],
  };

  const fakeGuild: Guild = {
    home: '/tmp/test-guild',
    apparatus<T>(name: string): T {
      const api = apparatusMap.get(name);
      if (!api) throw new Error(`Apparatus "${name}" not installed`);
      return api as T;
    },

    tryApparatus<T>(name: string): T | null {
      try { return this.apparatus<T>(name); } catch { return null; }
    },
    config<T>(): T { return {} as T; },
    writeConfig(): void {},
    guildConfig(): GuildConfig { return guildConfig; },
    kits(): LoadedKit[] { return []; },
    apparatuses(): LoadedApparatus[] { return []; },
    failedPlugins() { return []; },
    startupWarnings() { return []; },
  };

  setGuild(fakeGuild);

  if (!('apparatus' in stacksPlugin)) throw new Error('stacks');

  // Pre-create books the helpers read.
  backend.ensureBook({ ownerId: 'clockworks', book: 'events' }, {
    indexes: ['name', 'processed', 'firedAt', ['processed', 'firedAt']],
  });

  await stacksPlugin.apparatus.start({ on: () => {}, kits: () => [] });
  const stacks = stacksPlugin.apparatus.provides as StacksApi;
  apparatusMap.set('stacks', stacks);

  const eventsBook = stacks.book<EventDoc>('clockworks', 'events');

  // Build a thin ClockworksApi that writes directly to the events book.
  // Bypasses the signal validator and the rest of the apparatus
  // machinery — the helpers under test only call `emit()`.
  let clockworks: ClockworksApi = undefined as unknown as ClockworksApi;
  if (withClockworks) {
    clockworks = {
      async emit(name, payload, emitter) {
        const id = generateId('e');
        await eventsBook.put({
          id,
          name,
          payload: payload === undefined ? null : payload,
          emitter,
          firedAt: new Date().toISOString(),
          processed: false,
        });
        return id;
      },
    };
    apparatusMap.set('clockworks', clockworks);
  }

  return { stacks, clockworks, eventsBook, apparatusMap };
}

function makeSessionDoc(overrides: Partial<SessionDoc>): SessionDoc {
  const startedAt = new Date().toISOString();
  return {
    id: 'ses-test-001',
    status: 'running',
    startedAt,
    provider: 'claude-code',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Animator — session emission helper', () => {
  let fix: Fixture;

  beforeEach(async () => {
    fix = await buildFixture();
  });

  afterEach(() => clearGuild());

  async function findEvents(name: string): Promise<EventDoc[]> {
    return fix.eventsBook.find({
      where: [['name', '=', name]],
      orderBy: ['firedAt', 'asc'],
    }) as Promise<EventDoc[]>;
  }

  // ── animator.session.started ───────────────────────────────────────

  it('emitSessionStarted fires animator.session.started with metadata-derived anima/trigger', async () => {
    const doc = makeSessionDoc({
      id: 'ses-start-1',
      metadata: { role: 'artificer', trigger: 'summon' },
    });
    await emitSessionStarted(doc);

    const [event] = await findEvents('animator.session.started');
    assert.ok(event);
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-start-1');
    assert.equal(payload.anima, 'artificer');
    assert.equal(payload.trigger, 'summon');
    // Deliberately omitted ("skip-when-unset" rule).
    assert.ok(!('workshop' in payload));
    assert.ok(!('workspaceKind' in payload));
  });

  it('emitSessionStarted omits anima/trigger when metadata is absent', async () => {
    await emitSessionStarted(makeSessionDoc({ id: 'ses-bare' }));
    const [event] = await findEvents('animator.session.started');
    const payload = event!.payload as Record<string, unknown>;
    assert.ok(!('anima' in payload));
    assert.ok(!('trigger' in payload));
  });

  // ── animator.session.ended ─────────────────────────────────────────

  it('emitSessionEnded fires animator.session.ended with terminal-payload fields', async () => {
    await emitSessionEnded({
      id: 'ses-end-1',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      costUsd: 0.42,
      metadata: { role: 'artificer' },
    });

    const [event] = await findEvents('animator.session.ended');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-end-1');
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.durationMs, 60_000);
    assert.equal(payload.costUsd, 0.42);
    assert.equal(payload.anima, 'artificer');
  });

  it('emitSessionEnded fires animator.session.ended with no metadata', async () => {
    await emitSessionEnded({
      id: 'ses-end-bare',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: {},
    });

    const ended = await findEvents('animator.session.ended');
    assert.equal(ended.length, 1);
  });

  // ── animator.session.record-failed ─────────────────────────────────

  it('emitSessionRecordFailed fires with phase=insert and an error message', async () => {
    await emitSessionRecordFailed(
      'ses-fail-1',
      'insert',
      new Error('disk full'),
    );

    const [event] = await findEvents('animator.session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.sessionId, 'ses-fail-1');
    assert.equal(payload.phase, 'insert');
    assert.equal(payload.error, 'disk full');
  });

  it('emitSessionRecordFailed fires with phase=update-row', async () => {
    await emitSessionRecordFailed(
      'ses-fail-2',
      'update-row',
      new Error('row clobbered'),
    );

    const [event] = await findEvents('animator.session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.phase, 'update-row');
    assert.equal(payload.error, 'row clobbered');
  });

  it('emitSessionRecordFailed fires with phase=write-record', async () => {
    await emitSessionRecordFailed(
      'ses-fail-3',
      'write-record',
      'transcript-write-error',
    );

    const [event] = await findEvents('animator.session.record-failed');
    const payload = event!.payload as Record<string, unknown>;
    assert.equal(payload.phase, 'write-record');
    assert.equal(payload.error, 'transcript-write-error');
  });

  // ── No-clockworks soft dependency ──────────────────────────────────

  it('helpers silently no-op when Clockworks is not installed', async () => {
    clearGuild();
    const noCw = await buildFixture({ withClockworks: false });
    fix = noCw;

    // None of these should throw — and there should be no observable
    // event row even if there were a way to read one.
    await emitSessionStarted(makeSessionDoc({ id: 'ses-no-cw' }));
    await emitSessionEnded({
      id: 'ses-no-cw',
      status: 'completed',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:01:00Z',
      durationMs: 60_000,
      provider: 'claude-code',
      exitCode: 0,
      metadata: {},
    });
    await emitSessionRecordFailed('ses-no-cw', 'insert', new Error('x'));

    // The events book has no rows (and silence is the contract).
    assert.equal(await fix.eventsBook.count(), 0);
  });
});

// ── Kit-declaration unit test ──────────────────────────────────────────

describe('Animator — events kit declaration', () => {
  it('createAnimator().apparatus.supportKit.events exposes exactly the three declared names', () => {
    const plugin = createAnimator();
    if (!('apparatus' in plugin)) throw new Error('animator must be apparatus');

    const events = plugin.apparatus.supportKit?.events as Record<string, { description?: string }> | undefined;
    assert.ok(events, 'supportKit.events must be present');

    const names = Object.keys(events).sort();
    assert.deepEqual(names, [
      'animator.session.ended',
      'animator.session.record-failed',
      'animator.session.started',
    ], 'exactly the three Animator-owned event names are declared');

    // The exported const is the same record the apparatus exposes —
    // proves co-location of kit names with emit-name string literals.
    assert.equal(events, ANIMATOR_EVENTS);

    // Each entry carries a non-empty description and no `schema` field
    // (D2 — no consumer for schema yet).
    for (const [name, spec] of Object.entries(events)) {
      assert.ok(
        typeof spec.description === 'string' && spec.description.length > 0,
        `event "${name}" must declare a non-empty description`,
      );
      assert.ok(
        !('schema' in spec),
        `event "${name}" must not declare a schema field`,
      );
    }
  });
});
