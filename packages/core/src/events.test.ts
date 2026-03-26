import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  signalEvent,
  readPendingEvents,
  readEvent,
  markEventProcessed,
  recordDispatch,
  validateCustomEvent,
  isFrameworkEvent,
} from './events.ts';

/** Set up a minimal guild with Ledger including the clockworks tables. */
function setupTestGuild(clockworksConfig?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clockworks-test-'));
  const nexusDir = path.join(home, '.nexus');
  fs.mkdirSync(nexusDir, { recursive: true });

  // Write guild.json
  const config: Record<string, unknown> = {
    name: 'test-guild',
    nexus: '0.1.15',
    model: 'test',
    workshops: {},
    roles: {},
    baseTools: [],
    tools: {},
    engines: {},
    curricula: {},
    temperaments: {},
  };
  if (clockworksConfig) {
    config.clockworks = clockworksConfig;
  }
  fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify(config, null, 2));

  // Create Ledger with clockworks tables
  const dbPath = path.join(nexusDir, 'nexus.db');
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE events (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      payload    TEXT,
      emitter    TEXT NOT NULL,
      fired_at   TEXT NOT NULL DEFAULT (datetime('now')),
      processed  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE event_dispatches (
      id           TEXT PRIMARY KEY,
      event_id     TEXT NOT NULL REFERENCES events(id),
      handler_type TEXT NOT NULL,
      handler_name TEXT NOT NULL,
      target_role  TEXT,
      notice_type  TEXT,
      started_at   TEXT,
      ended_at     TEXT,
      status       TEXT,
      error        TEXT
    );
  `);
  db.close();

  return home;
}

describe('isFrameworkEvent', () => {
  it('identifies framework namespaces', () => {
    assert.equal(isFrameworkEvent('anima.instantiated'), true);
    assert.equal(isFrameworkEvent('commission.sealed'), true);
    assert.equal(isFrameworkEvent('mandate.ready'), true);
    assert.equal(isFrameworkEvent('mandate.completed'), true);
    assert.equal(isFrameworkEvent('summon.completed'), true);
    assert.equal(isFrameworkEvent('tool.installed'), true);
    assert.equal(isFrameworkEvent('migration.applied'), true);
    assert.equal(isFrameworkEvent('guild.initialized'), true);
    assert.equal(isFrameworkEvent('standing-order.failed'), true);
    assert.equal(isFrameworkEvent('session.started'), true);
  });

  it('rejects custom events', () => {
    assert.equal(isFrameworkEvent('code.reviewed'), false);
    assert.equal(isFrameworkEvent('deploy.approved'), false);
    assert.equal(isFrameworkEvent('my.custom.event'), false);
  });
});

describe('validateCustomEvent', () => {
  it('rejects framework events', () => {
    const home = setupTestGuild({ events: {} });
    assert.throws(
      () => validateCustomEvent(home, 'anima.instantiated'),
      /reserved framework namespace/,
    );
  });

  it('rejects undeclared events', () => {
    const home = setupTestGuild({ events: {} });
    assert.throws(
      () => validateCustomEvent(home, 'code.reviewed'),
      /not declared in guild.json/,
    );
  });

  it('accepts declared custom events', () => {
    const home = setupTestGuild({
      events: { 'code.reviewed': { description: 'Code review done' } },
    });
    assert.doesNotThrow(() => validateCustomEvent(home, 'code.reviewed'));
  });

  it('works when clockworks config is missing', () => {
    const home = setupTestGuild();
    assert.throws(
      () => validateCustomEvent(home, 'code.reviewed'),
      /not declared/,
    );
  });
});

describe('signalEvent', () => {
  it('persists an event and returns its id', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', { key: 'value' }, 'test-emitter');

    assert.equal(typeof id, 'string');
    assert.ok(id.startsWith('evt-'));
  });

  it('persists with null payload', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'test-emitter');
    const event = readEvent(home, id);
    assert.equal(event!.payload, null);
  });

  it('persists multiple events with sequential ids', () => {
    const home = setupTestGuild();
    const id1 = signalEvent(home, 'event.a', null, 'emitter');
    const id2 = signalEvent(home, 'event.b', null, 'emitter');
    assert.notEqual(id1, id2);
  });
});

describe('readPendingEvents', () => {
  it('returns empty array when no events', () => {
    const home = setupTestGuild();
    const events = readPendingEvents(home);
    assert.equal(events.length, 0);
  });

  it('returns unprocessed events in order', () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', { n: 1 }, 'emitter');
    signalEvent(home, 'event.b', { n: 2 }, 'emitter');

    const events = readPendingEvents(home);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.name, 'event.a');
    assert.equal(events[1]!.name, 'event.b');
  });

  it('excludes processed events', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'event.a', null, 'emitter');
    signalEvent(home, 'event.b', null, 'emitter');
    markEventProcessed(home, id);

    const events = readPendingEvents(home);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, 'event.b');
  });
});

describe('readEvent', () => {
  it('reads an event by id', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', { key: 'value' }, 'test-emitter');
    const event = readEvent(home, id);

    assert.ok(event);
    assert.equal(event.id, id);
    assert.equal(event.name, 'test.event');
    assert.deepEqual(event.payload, { key: 'value' });
    assert.equal(event.emitter, 'test-emitter');
  });

  it('returns null for nonexistent id', () => {
    const home = setupTestGuild();
    assert.equal(readEvent(home, 'evt-nonexistent'), null);
  });
});

describe('markEventProcessed', () => {
  it('marks event as processed', () => {
    const home = setupTestGuild();
    const id = signalEvent(home, 'test.event', null, 'emitter');

    markEventProcessed(home, id);

    const pending = readPendingEvents(home);
    assert.equal(pending.length, 0);
  });
});

describe('recordDispatch', () => {
  it('records an engine dispatch', () => {
    const home = setupTestGuild();
    const eventId = signalEvent(home, 'test.event', null, 'emitter');

    recordDispatch(home, {
      eventId,
      handlerType: 'engine',
      handlerName: 'test-engine',
      startedAt: '2026-03-24T00:00:00Z',
      endedAt: '2026-03-24T00:00:01Z',
      status: 'success',
    });

    // Verify in database
    const db = new Database(path.join(home, '.nexus', 'nexus.db'));
    const row = db.prepare('SELECT * FROM event_dispatches WHERE event_id = ?').get(eventId) as Record<string, unknown>;
    db.close();

    assert.equal(row.handler_type, 'engine');
    assert.equal(row.handler_name, 'test-engine');
    assert.equal(row.status, 'success');
    assert.equal(row.target_role, null);
    assert.equal(row.notice_type, null);
  });

  it('records an anima dispatch with role and notice type', () => {
    const home = setupTestGuild();
    const eventId = signalEvent(home, 'test.event', null, 'emitter');

    recordDispatch(home, {
      eventId,
      handlerType: 'anima',
      handlerName: 'advisor-alpha',
      targetRole: 'advisor',
      noticeType: 'summon',
      startedAt: '2026-03-24T00:00:00Z',
      endedAt: '2026-03-24T00:00:01Z',
      status: 'success',
    });

    const db = new Database(path.join(home, '.nexus', 'nexus.db'));
    const row = db.prepare('SELECT * FROM event_dispatches WHERE event_id = ?').get(eventId) as Record<string, unknown>;
    db.close();

    assert.equal(row.handler_type, 'anima');
    assert.equal(row.target_role, 'advisor');
    assert.equal(row.notice_type, 'summon');
  });
});
