import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { clockTick, clockRun } from './clockworks.ts';
import { desugarOrder, extractParams } from './clockworks.ts';
import { signalEvent, readPendingEvents } from './events.ts';
import type { StandingOrder } from './guild-config.ts';

/** Set up a minimal guild with Ledger including the clockworks tables. */
function setupTestGuild(clockworksConfig?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clockworks-runner-test-'));
  const nexusDir = path.join(home, '.nexus');
  fs.mkdirSync(nexusDir, { recursive: true });

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

// ── desugarOrder ──────────────────────────────────────────────────────

describe('desugarOrder', () => {
  it('passes through run orders unchanged', () => {
    const order: StandingOrder = { on: 'test.event', run: 'my-engine' };
    const result = desugarOrder(order);
    assert.deepEqual(result, { on: 'test.event', run: 'my-engine' });
  });

  it('desugars summon to summon-engine with role param', () => {
    const order = { on: 'mandate.ready', summon: 'artificer' } as StandingOrder;
    const result = desugarOrder(order);
    assert.equal(result.run, 'summon-engine');
    assert.equal(result.role, 'artificer');
    assert.equal(result.on, 'mandate.ready');
    assert.equal(result.summon, undefined);
  });

  it('preserves prompt and extra keys through desugar', () => {
    // Simulate a standing order with extra keys (from JSON parse)
    const order = { on: 'mandate.ready', summon: 'artificer', prompt: 'Hello {{writ.title}}', maxSessions: 3 } as unknown as StandingOrder;
    const result = desugarOrder(order);
    assert.equal(result.run, 'summon-engine');
    assert.equal(result.role, 'artificer');
    assert.equal(result.prompt, 'Hello {{writ.title}}');
    assert.equal(result.maxSessions, 3);
  });

  it('desugars brief to summon-engine with role param (legacy)', () => {
    const order = { on: 'code.reviewed', brief: 'steward' } as StandingOrder;
    const result = desugarOrder(order);
    assert.equal(result.run, 'summon-engine');
    assert.equal(result.role, 'steward');
    assert.equal(result.brief, undefined);
  });
});

// ── extractParams ─────────────────────────────────────────────────────

describe('extractParams', () => {
  it('returns empty object for order with only reserved keys', () => {
    const result = extractParams({ on: 'test.event', run: 'my-engine' });
    assert.deepEqual(result, {});
  });

  it('extracts non-reserved keys as params', () => {
    const result = extractParams({
      on: 'test.event',
      run: 'circuit-breaker',
      maxAttempts: 3,
      environment: 'staging',
    });
    assert.deepEqual(result, { maxAttempts: 3, environment: 'staging' });
  });

  it('extracts role and prompt from desugared summon order', () => {
    const desugared = desugarOrder(
      { on: 'mandate.ready', summon: 'artificer', prompt: 'Do the thing' } as unknown as StandingOrder,
    );
    const result = extractParams(desugared);
    assert.equal(result.role, 'artificer');
    assert.equal(result.prompt, 'Do the thing');
  });

  it('does not include reserved keys in params', () => {
    const result = extractParams({ on: 'x', run: 'y', summon: 'z', brief: 'w', extra: true });
    assert.deepEqual(result, { extra: true });
  });
});

// ── clockTick ─────────────────────────────────────────────────────────

describe('clockTick', () => {
  it('returns null when no pending events', async () => {
    const home = setupTestGuild();
    const result = await clockTick(home);
    assert.equal(result, null);
  });

  it('processes next pending event with no standing orders', async () => {
    const home = setupTestGuild();
    signalEvent(home, 'test.event', null, 'test');

    const result = await clockTick(home);
    assert.ok(result);
    assert.equal(result.eventName, 'test.event');
    assert.equal(result.dispatches.length, 0);

    // Event should be marked processed
    const pending = readPendingEvents(home);
    assert.equal(pending.length, 0);
  });

  it('processes specific event by id', async () => {
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
      /Event #evt-nonexistent not found/,
    );
  });

  it('desugars summon order and dispatches as engine', async () => {
    const home = setupTestGuild({
      events: { 'my.event': { description: 'test' } },
      standingOrders: [
        { on: 'my.event', summon: 'advisor' },
      ],
    });

    signalEvent(home, 'my.event', null, 'framework');
    const result = await clockTick(home);

    assert.ok(result);
    assert.equal(result.dispatches.length, 1);
    // After desugaring, summon becomes an engine dispatch for 'summon-engine'
    assert.equal(result.dispatches[0]!.handlerType, 'engine');
    assert.equal(result.dispatches[0]!.handlerName, 'summon-engine');
    // Engine not installed in test guild, so it errors
    assert.equal(result.dispatches[0]!.status, 'error');
    assert.ok(result.dispatches[0]!.error!.includes('not found in guild.json'));
  });

  it('errors on engine standing order for missing engine', async () => {
    const home = setupTestGuild({
      standingOrders: [
        { on: 'test.event', run: 'nonexistent-engine' },
      ],
    });

    signalEvent(home, 'test.event', null, 'framework');
    const result = await clockTick(home);

    assert.ok(result);
    assert.equal(result.dispatches.length, 1);
    assert.equal(result.dispatches[0]!.status, 'error');
    assert.ok(result.dispatches[0]!.error!.includes('not found in guild.json'));
  });
});

describe('clockRun', () => {
  it('returns empty when no pending events', async () => {
    const home = setupTestGuild();
    const result = await clockRun(home);
    assert.equal(result.processed.length, 0);
  });

  it('processes all pending events', async () => {
    const home = setupTestGuild();
    signalEvent(home, 'event.a', null, 'test');
    signalEvent(home, 'event.b', null, 'test');
    signalEvent(home, 'event.c', null, 'test');

    const result = await clockRun(home);
    assert.equal(result.processed.length, 3);

    const pending = readPendingEvents(home);
    assert.equal(pending.length, 0);
  });

  it('processes events generated during run (failure events)', async () => {
    const home = setupTestGuild({
      standingOrders: [
        { on: 'test.event', run: 'nonexistent-engine' },
      ],
    });

    signalEvent(home, 'test.event', null, 'framework');
    const result = await clockRun(home);

    // Should process the original event + the standing-order.failed event
    assert.ok(result.processed.length >= 2);
    const names = result.processed.map(p => p.eventName);
    assert.ok(names.includes('test.event'));
    assert.ok(names.includes('standing-order.failed'));
  });
});
