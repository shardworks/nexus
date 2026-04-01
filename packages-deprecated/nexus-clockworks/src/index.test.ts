/**
 * nexus-clockworks plugin — test suite.
 *
 * Tests the events API, runner, and tool handlers. Uses temp directories
 * as guild roots with Books tables created in-process (no arbor needed).
 *
 * Table setup mirrors what reconcileBooks() would create at runtime:
 *   books_nexus_clockworks_events    (id TEXT PK, content TEXT)
 *   books_nexus_clockworks_dispatches (id TEXT PK, content TEXT)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { StandingOrder } from '@shardworks/nexus-core';
import { setGuild } from '@shardworks/nexus-core';

import {
  isFrameworkEvent,
  validateCustomEvent,
  signalEvent,
  readEvent,
  readPendingEvents,
  markEventProcessed,
  recordDispatch,
  listEvents,
  listDispatches,
} from './lib/events-api.ts';
import { desugarOrder, extractParams, clockTick, clockRun } from './lib/runner.ts';
import { EVENTS_TABLE, DISPATCHES_TABLE } from './lib/db.ts';

// ── Test guild setup ──────────────────────────────────────────────────

/** V2 guild config for test guilds. */
function makeGuildConfig(clockworksConfig?: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: 'test-guild',
    nexus: '0.1.0',
    workshops: {},
    roles: {},
    baseTools: [],
    rigs: [],
    settings: { model: 'test' },
  };
  if (clockworksConfig) {
    config.clockworks = clockworksConfig;
  }
  return config;
}

/**
 * Create a minimal test guild with the clockworks Books tables.
 * Matches what reconcileBooks() creates at runtime.
 */
function setupTestGuild(clockworksConfig?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clockworks-test-'));
  const nexusDir = path.join(home, '.nexus');
  fs.mkdirSync(nexusDir, { recursive: true });

  fs.writeFileSync(
    path.join(home, 'guild.json'),
    JSON.stringify(makeGuildConfig(clockworksConfig), null, 2),
  );

  const db = new Database(path.join(nexusDir, 'nexus.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS "${EVENTS_TABLE}" (
      id      TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_${EVENTS_TABLE}_name"
      ON "${EVENTS_TABLE}"(json_extract(content, '$.name'));
    CREATE INDEX IF NOT EXISTS "idx_${EVENTS_TABLE}_emitter"
      ON "${EVENTS_TABLE}"(json_extract(content, '$.emitter'));
    CREATE INDEX IF NOT EXISTS "idx_${EVENTS_TABLE}_processed"
      ON "${EVENTS_TABLE}"(json_extract(content, '$.processed'));
    CREATE INDEX IF NOT EXISTS "idx_${EVENTS_TABLE}_firedAt"
      ON "${EVENTS_TABLE}"(json_extract(content, '$.firedAt'));

    CREATE TABLE IF NOT EXISTS "${DISPATCHES_TABLE}" (
      id      TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_${DISPATCHES_TABLE}_eventId"
      ON "${DISPATCHES_TABLE}"(json_extract(content, '$.eventId'));
    CREATE INDEX IF NOT EXISTS "idx_${DISPATCHES_TABLE}_status"
      ON "${DISPATCHES_TABLE}"(json_extract(content, '$.status'));
  `);
  db.close();

  return home;
}

// ── isFrameworkEvent ──────────────────────────────────────────────────

describe('isFrameworkEvent', () => {
  it('identifies all reserved framework namespaces', () => {
    const reserved = [
      'anima.instantiated',
      'writ.posted',
      'writ.ready',
      'writ.completed',
      'summon.completed',
      'tool.installed',
      'migration.applied',
      'guild.initialized',
      'standing-order.failed',
      'session.started',
      'session.ended',
    ];
    for (const name of reserved) {
      assert.equal(isFrameworkEvent(name), true, `expected ${name} to be a framework event`);
    }
  });

  it('accepts custom event names', () => {
    assert.equal(isFrameworkEvent('code.reviewed'), false);
    assert.equal(isFrameworkEvent('deploy.approved'), false);
    assert.equal(isFrameworkEvent('my.custom.event'), false);
  });

  it('is case-sensitive — does not match ANIMA.created', () => {
    assert.equal(isFrameworkEvent('ANIMA.created'), false);
  });
});

// ── validateCustomEvent ───────────────────────────────────────────────

describe('validateCustomEvent', () => {
  it('rejects framework-namespace events', () => {
    const home = setupTestGuild({ events: {} });
    assert.throws(
      () => validateCustomEvent(home, 'anima.instantiated'),
      /reserved framework namespace/,
    );
  });

  it('rejects undeclared custom events', () => {
    const home = setupTestGuild({ events: {} });
    assert.throws(
      () => validateCustomEvent(home, 'code.reviewed'),
      /not declared in guild.json/,
    );
  });

  it('rejects when clockworks config is absent', () => {
    const home = setupTestGuild(); // no clockworks key
    assert.throws(
      () => validateCustomEvent(home, 'code.reviewed'),
      /not declared/,
    );
  });

  it('accepts a declared custom event', () => {
    const home = setupTestGuild({
      events: { 'code.reviewed': { description: 'Code review completed' } },
    });
    assert.doesNotThrow(() => validateCustomEvent(home, 'code.reviewed'));
  });

  it('lists available events in error message when some are declared', () => {
    const home = setupTestGuild({
      events: { 'deploy.approved': {} },
    });
    assert.throws(
      () => validateCustomEvent(home, 'code.reviewed'),
      /deploy\.approved/,
    );
  });
});

// ── signalEvent ───────────────────────────────────────────────────────

describe('signalEvent', () => {
  it('persists an event and returns a prefixed id', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', { key: 'value' }, 'test-emitter');
    assert.ok(typeof id === 'string');
    assert.ok(id.startsWith('evt-'));
  });

  it('stores the event as unprocessed', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'framework');
    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.processed, false);
  });

  it('stores name, emitter, and payload correctly', () => {
    const home = setupTestGuild();
    const payload = { writId: 'wrt-abc123', status: 'ready' };
    const id = signalEvent(home, 'writ.ready', payload, 'framework');
    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.name, 'writ.ready');
    assert.equal(event.emitter, 'framework');
    assert.deepEqual(event.payload, payload);
  });

  it('accepts null payload', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test');
    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.payload, null);
  });

  it('stores firedAt as an ISO-8601 timestamp', () => {
    const before = new Date().toISOString();
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test');
    const after = new Date().toISOString();
    const event = readEvent(home, id);
    assert.ok(event);
    assert.ok(event.firedAt >= before);
    assert.ok(event.firedAt <= after);
  });

  it('multiple signals produce multiple events', () => {
    const home = setupTestGuild();
    signalEvent(home, 'test.one', null, 'test');
    signalEvent(home, 'test.two', null, 'test');
    signalEvent(home, 'test.three', null, 'test');
    const pending = readPendingEvents(home);
    assert.equal(pending.length, 3);
  });
});

// ── readEvent ─────────────────────────────────────────────────────────

describe('readEvent', () => {
  it('returns null for a nonexistent id', () => {
    const home = setupTestGuild();
    const result = readEvent(home, 'evt-nonexistent');
    assert.equal(result, null);
  });

  it('returns the full event document', () => {
    const home = setupTestGuild();
    const payload = { x: 1 };
    const id = signalEvent(home, 'test.event', payload, 'emitter-a');
    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.id, id);
    assert.equal(event.name, 'test.event');
    assert.equal(event.emitter, 'emitter-a');
    assert.deepEqual(event.payload, payload);
    assert.equal(event.processed, false);
  });
});

// ── readPendingEvents ─────────────────────────────────────────────────

describe('readPendingEvents', () => {
  it('returns empty array when no events', () => {
    const home = setupTestGuild();
    assert.deepEqual(readPendingEvents(home), []);
  });

  it('returns only unprocessed events', () => {
    const home = setupTestGuild();
    const id1 = signalEvent(home, 'event.a', null, 'test');
    const id2 = signalEvent(home, 'event.b', null, 'test');
    signalEvent(home, 'event.c', null, 'test');

    markEventProcessed(home, id1);
    markEventProcessed(home, id2);

    const pending = readPendingEvents(home);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.name, 'event.c');
  });

  it('orders by firedAt ascending (FIFO)', () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.first', null, 'test');
    signalEvent(home, 'event.second', null, 'test');
    signalEvent(home, 'event.third', null, 'test');

    const pending = readPendingEvents(home);
    assert.equal(pending[0]!.name, 'event.first');
    assert.equal(pending[1]!.name, 'event.second');
    assert.equal(pending[2]!.name, 'event.third');
  });
});

// ── markEventProcessed ────────────────────────────────────────────────

describe('markEventProcessed', () => {
  it('marks the event processed', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test');

    markEventProcessed(home, id);

    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.processed, true);
  });

  it('removes the event from pending queue', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test');
    markEventProcessed(home, id);
    assert.equal(readPendingEvents(home).length, 0);
  });

  it('is a no-op for a nonexistent event id', () => {
    const home = setupTestGuild();
    assert.doesNotThrow(() => markEventProcessed(home, 'evt-nonexistent'));
  });
});

// ── recordDispatch ────────────────────────────────────────────────────

describe('recordDispatch', () => {
  it('creates a dispatch record', () => {
    const home = setupTestGuild();
    const eventId = signalEvent(home, 'test.event', null, 'test');
    const now = new Date().toISOString();
    recordDispatch(home, {
      eventId,
      handlerType: 'engine',
      handlerName: 'my-engine',
      startedAt: now,
      endedAt: now,
      status: 'success',
    });

    const dispatches = listDispatches(home, { eventId });
    assert.equal(dispatches.length, 1);
    const d = dispatches[0]!;
    assert.equal(d.eventId, eventId);
    assert.equal(d.handlerType, 'engine');
    assert.equal(d.handlerName, 'my-engine');
    assert.equal(d.status, 'success');
    assert.equal(d.error, null);
    assert.equal(d.targetRole, null);
  });

  it('stores error message for failed dispatches', () => {
    const home = setupTestGuild();
    const eventId = signalEvent(home, 'test.event', null, 'test');
    const now = new Date().toISOString();
    recordDispatch(home, {
      eventId,
      handlerType: 'engine',
      handlerName: 'bad-engine',
      startedAt: now,
      endedAt: now,
      status: 'error',
      error: 'Something went wrong',
    });

    const dispatches = listDispatches(home, { eventId });
    assert.equal(dispatches[0]!.status, 'error');
    assert.equal(dispatches[0]!.error, 'Something went wrong');
  });
});

// ── listEvents ────────────────────────────────────────────────────────

describe('listEvents', () => {
  it('returns all events newest first', () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    signalEvent(home, 'event.c', null, 'test');

    const events = listEvents(home);
    // Newest first (DESC by firedAt)
    assert.equal(events.length, 3);
    // All three names present
    const names = events.map(e => e.name);
    assert.ok(names.includes('event.a'));
    assert.ok(names.includes('event.b'));
    assert.ok(names.includes('event.c'));
  });

  it('filters by exact emitter', () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'vera');
    signalEvent(home, 'event.b', null, 'framework');
    signalEvent(home, 'event.c', null, 'vera');

    const events = listEvents(home, { emitter: 'vera' });
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.emitter === 'vera'));
  });

  it('filters by name LIKE pattern', () => {
    const home = setupTestGuild();
    signalEvent(home, 'writ.ready', null, 'framework');
    signalEvent(home, 'writ.completed', null, 'framework');
    signalEvent(home, 'session.started', null, 'framework');

    const events = listEvents(home, { name: 'writ.%' });
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.name.startsWith('writ.')));
  });

  it('filters pending: true returns only unprocessed', () => {
    const home = setupTestGuild();
    const id1 = signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    markEventProcessed(home, id1);

    const pending = listEvents(home, { pending: true });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.name, 'event.b');
  });

  it('filters pending: false returns only processed', () => {
    const home = setupTestGuild();
    const id1 = signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    markEventProcessed(home, id1);

    const processed = listEvents(home, { pending: false });
    assert.equal(processed.length, 1);
    assert.equal(processed[0]!.name, 'event.a');
  });

  it('respects limit', () => {
    const home = setupTestGuild();
    for (let i = 0; i < 5; i++) signalEvent(home, `event.${i}`, null, 'test');
    const events = listEvents(home, { limit: 3 });
    assert.equal(events.length, 3);
  });
});

// ── desugarOrder ─────────────────────────────────────────────────────

describe('desugarOrder', () => {
  it('passes run orders through unchanged', () => {
    const order: StandingOrder = { on: 'test.event', run: 'my-engine' };
    assert.deepEqual(desugarOrder(order), { on: 'test.event', run: 'my-engine' });
  });

  it('desugars summon to summon-engine with role', () => {
    const order = { on: 'mandate.ready', summon: 'artificer' } as StandingOrder;
    const result = desugarOrder(order);
    assert.equal(result.run, 'summon-engine');
    assert.equal(result.role, 'artificer');
    assert.equal(result.on, 'mandate.ready');
    assert.equal(result.summon, undefined);
  });

  it('preserves extra keys through desugar', () => {
    const order = { on: 'mandate.ready', summon: 'artificer', prompt: 'Do this', maxSessions: 3 } as unknown as StandingOrder;
    const result = desugarOrder(order);
    assert.equal(result.role, 'artificer');
    assert.equal(result.prompt, 'Do this');
    assert.equal(result.maxSessions, 3);
  });
});

// ── extractParams ─────────────────────────────────────────────────────

describe('extractParams', () => {
  it('returns empty object for pure structural order', () => {
    assert.deepEqual(extractParams({ on: 'test.event', run: 'my-engine' }), {});
  });

  it('extracts non-reserved keys', () => {
    const result = extractParams({
      on: 'test.event',
      run: 'circuit-breaker',
      maxAttempts: 3,
      environment: 'staging',
    });
    assert.deepEqual(result, { maxAttempts: 3, environment: 'staging' });
  });

  it('does not include reserved keys', () => {
    const result = extractParams({ on: 'x', run: 'y', summon: 'z', extra: true });
    assert.deepEqual(result, { extra: true });
  });
});

// ── clockTick ─────────────────────────────────────────────────────────

describe('clockTick', () => {
  it('returns null when queue is empty', async () => {
    const home = setupTestGuild();
    assert.equal(await clockTick(home), null);
  });

  it('processes the next pending event with no standing orders', async () => {
    const home = setupTestGuild();
    signalEvent(home, 'test.event', null, 'test');

    const result = await clockTick(home);
    assert.ok(result);
    assert.equal(result.eventName, 'test.event');
    assert.equal(result.dispatches.length, 0);

    // Queue is now empty
    assert.equal(readPendingEvents(home).length, 0);
  });

  it('processes a specific event by id', async () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'test');
    const id2 = signalEvent(home, 'event.b', null, 'test');

    const result = await clockTick(home, id2);
    assert.ok(result);
    assert.equal(result.eventName, 'event.b');

    // event.a should still be pending
    const pending = readPendingEvents(home);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.name, 'event.a');
  });

  it('throws on nonexistent event id', async () => {
    const home = setupTestGuild();
    await assert.rejects(
      () => clockTick(home, 'evt-nonexistent'),
      /Event "evt-nonexistent" not found/,
    );
  });

  it('marks processed event in Books after tick', async () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test');
    await clockTick(home);
    const event = readEvent(home, id);
    assert.ok(event);
    assert.equal(event.processed, true);
  });
});

// ── clockRun ──────────────────────────────────────────────────────────

describe('clockRun', () => {
  it('returns empty result when queue is empty', async () => {
    const home = setupTestGuild();
    const result = await clockRun(home);
    assert.equal(result.totalEvents, 0);
    assert.equal(result.processed.length, 0);
  });

  it('drains all pending events', async () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    signalEvent(home, 'event.c', null, 'test');

    const result = await clockRun(home);
    assert.equal(result.totalEvents, 3);
    assert.equal(result.processed.length, 3);
    assert.equal(readPendingEvents(home).length, 0);
  });

  it('processes standing-order.failed events without cascading', async () => {
    // A standing-order.failed triggered by another standing-order.failed
    // should be processed (marked done) without dispatching further.
    const home = setupTestGuild();
    signalEvent(home, 'standing-order.failed', {
      standingOrder: { on: 'test.event', run: 'bad-engine' },
      triggeringEvent: { id: 'evt-abc', name: 'standing-order.failed' },
      error: 'cascaded failure',
    }, 'framework');

    const result = await clockRun(home);
    // The event should be processed (loop guard fires, no dispatches)
    assert.equal(result.processed.length, 1);
    assert.equal(result.processed[0]!.dispatches.length, 0);
    assert.equal(readPendingEvents(home).length, 0);
  });
});

// ── Tool handlers ─────────────────────────────────────────────────────

function setupGuildAccessor(home: string): void {
  setGuild({
    home,
    apparatus: () => { throw new Error('not available in test'); },
    config: () => ({}) as never,
    guildConfig: () => ({}) as never,
    kits: () => [],
    apparatuses: () => [],
  });
}

describe('signal tool', async () => {
  const { default: signalTool } = await import('./tools/signal.ts');

  it('signals a declared custom event and returns eventId', () => {
    const home = setupTestGuild({
      events: { 'code.reviewed': {} },
    });
    setupGuildAccessor(home);
    const result = signalTool.handler(
      { name: 'code.reviewed', payload: { reviewer: 'alice' } },
    );
    assert.ok(typeof (result as { eventId: string }).eventId === 'string');
    assert.equal((result as { name: string }).name, 'code.reviewed');
    assert.equal(readPendingEvents(home).length, 1);
  });

  it('rejects undeclared events without force', () => {
    const home = setupTestGuild({ events: {} });
    assert.throws(
      () => { setupGuildAccessor(home); return signalTool.handler({ name: 'unknown.event' }); },
      /not declared/,
    );
  });

  it('allows framework events with force: true', () => {
    const home = setupTestGuild();
    setupGuildAccessor(home);
    const result = signalTool.handler(
      { name: 'writ.ready', force: true },
    );
    assert.ok(typeof (result as { eventId: string }).eventId === 'string');
  });
});

describe('event-list tool', async () => {
  const { default: eventListTool } = await import('./tools/event-list.ts');

  it('returns events sorted newest first', () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');

    setupGuildAccessor(home);
    const result = eventListTool.handler({ limit: 20 }) as { name: string }[];
    assert.equal(result.length, 2);
  });

  it('filters by pending', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    markEventProcessed(home, id);

    setupGuildAccessor(home);
    const pending = eventListTool.handler({ limit: 20, pending: true }) as { name: string }[];
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.name, 'event.b');
  });
});

describe('event-show tool', async () => {
  const { default: eventShowTool } = await import('./tools/event-show.ts');

  it('returns event with dispatches array', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', { key: 'val' }, 'framework');
    const now = new Date().toISOString();
    recordDispatch(home, {
      eventId: id,
      handlerType: 'engine',
      handlerName: 'my-engine',
      startedAt: now,
      endedAt: now,
      status: 'success',
    });

    setupGuildAccessor(home);
    const result = eventShowTool.handler({ id }) as {
      name: string;
      dispatches: { handlerName: string }[];
    };
    assert.equal(result.name, 'test.event');
    assert.equal(result.dispatches.length, 1);
    assert.equal(result.dispatches[0]!.handlerName, 'my-engine');
  });

  it('throws for nonexistent event id', () => {
    const home = setupTestGuild();
    assert.throws(
      () => { setupGuildAccessor(home); return eventShowTool.handler({ id: 'evt-nope' }); },
      /not found/,
    );
  });
});
