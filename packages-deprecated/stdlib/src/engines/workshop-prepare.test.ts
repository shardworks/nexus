import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import workshopPrepare from './workshop-prepare.ts';
import { worktreesPath, workshopBarePath } from '@shardworks/nexus-core';
import { createWrit, readWrit, setupWorktree, listEvents } from '@shardworks/nexus-core/legacy/1';
import type { GuildEvent, EngineContext } from '@shardworks/nexus-core/legacy/1';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Create a minimal test guild with Ledger tables and a workshop bare repo.
 * Returns { home, remotePath }.
 */
function createTestGuild(tmpDir: string, opts?: { withWorkshop?: boolean }): { home: string; remotePath: string | null } {
  const home = path.join(tmpDir, 'guild');
  const nexusDir = path.join(home, '.nexus');
  fs.mkdirSync(path.join(nexusDir, 'workshops'), { recursive: true });
  fs.mkdirSync(path.join(nexusDir, 'worktrees'), { recursive: true });

  // guild.json
  const config: Record<string, unknown> = {
    name: 'test-guild',
    nexus: '0.1.0',
    model: 'test',
    workshops: {},
    roles: {},
    baseTools: [],
    tools: {},
    engines: {},
    curricula: {},
    temperaments: {},
    writTypes: {},
    clockworks: {
      standingOrders: [
        { on: 'writ.ready', run: 'workshop-prepare' },
        { on: 'writ.workspace-ready', summon: 'artificer' },
        { on: 'writ.completed', run: 'workshop-merge' },
      ],
    },
  };

  let remotePath: string | null = null;

  if (opts?.withWorkshop !== false) {
    // Create a bare remote and register it as a workshop
    remotePath = path.join(tmpDir, 'remote-repo.git');
    fs.mkdirSync(remotePath, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: remotePath, stdio: 'pipe' });

    const tmpCheckout = path.join(tmpDir, 'tmp-checkout');
    fs.mkdirSync(tmpCheckout);
    git(['init', '-b', 'main'], tmpCheckout);
    git(['config', 'user.email', 'test@test.com'], tmpCheckout);
    git(['config', 'user.name', 'Test'], tmpCheckout);
    fs.writeFileSync(path.join(tmpCheckout, 'README.md'), '# Test\n');
    git(['add', '-A'], tmpCheckout);
    git(['commit', '-m', 'initial'], tmpCheckout);
    git(['remote', 'add', 'origin', remotePath], tmpCheckout);
    git(['push', 'origin', 'main'], tmpCheckout);
    fs.rmSync(tmpCheckout, { recursive: true });

    // Clone into the workshop bare path
    const barePath = workshopBarePath(home, 'test-ws');
    execFileSync('git', ['clone', '--bare', remotePath, barePath], { stdio: 'pipe' });

    (config.workshops as Record<string, unknown>)['test-ws'] = {
      remoteUrl: remotePath,
      addedAt: new Date().toISOString(),
    };
  }

  fs.writeFileSync(path.join(home, 'guild.json'), JSON.stringify(config, null, 2));

  // Create Ledger database
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
    CREATE TABLE writs (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'ready'
                  CHECK(status IN ('ready', 'active', 'pending', 'completed', 'failed', 'cancelled')),
      parent_id   TEXT REFERENCES writs(id),
      session_id  TEXT,
      workshop    TEXT,
      source_type TEXT NOT NULL DEFAULT 'engine'
                  CHECK(source_type IN ('patron', 'anima', 'engine')),
      source_id   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_writs_parent ON writs(parent_id);
    CREATE INDEX idx_writs_status ON writs(status);
    CREATE INDEX idx_writs_type_status ON writs(type, status);
    CREATE INDEX idx_writs_workshop ON writs(workshop);

    CREATE TABLE audit_log (
      id          TEXT PRIMARY KEY,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      detail      TEXT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.close();

  return { home, remotePath };
}

/** Build a fake GuildEvent for testing. */
function fakeEvent(name: string, payload: Record<string, unknown>): GuildEvent {
  return {
    id: `evt-test-${Date.now()}`,
    name,
    payload,
    emitter: 'framework',
    firedAt: new Date().toISOString(),
  };
}

/** Find events by name from the ledger. */
function findEvents(home: string, name: string): Array<{ name: string; payload: Record<string, unknown> | null }> {
  return listEvents(home).filter(e => e.name === name) as Array<{ name: string; payload: Record<string, unknown> | null }>;
}

describe('workshop-prepare engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-prepare-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates worktree for a new writ with workshop', async () => {
    const { home } = createTestGuild(tmpDir);
    const writ = createWrit(home, {
      title: 'Test writ',
      workshop: 'test-ws',
      sourceType: 'patron',
    });

    const event = fakeEvent('writ.ready', { writId: writ.id });
    await workshopPrepare.handler(event, { home, params: {} });

    // Worktree should exist
    const branch = `writ-${writ.id}`;
    const worktreeDir = path.join(worktreesPath(home), 'test-ws', branch);
    assert.ok(fs.existsSync(worktreeDir), 'worktree directory should be created');

    // writ.workspace-ready should have been signaled
    const readyEvents = findEvents(home, 'writ.workspace-ready');
    assert.equal(readyEvents.length, 1, 'should signal writ.workspace-ready');
    const payload = readyEvents[0]!.payload!;
    assert.equal(payload.writId, writ.id);
    assert.equal(payload.workshop, 'test-ws');
    assert.equal(payload.worktreePath, worktreeDir);
  });

  it('is idempotent — skips git setup if worktree already exists', async () => {
    const { home } = createTestGuild(tmpDir);
    const writ = createWrit(home, {
      title: 'Interrupted writ',
      workshop: 'test-ws',
      sourceType: 'patron',
    });

    // Pre-create the worktree (simulating a previous dispatch)
    setupWorktree({ home, workshop: 'test-ws', writId: writ.id });

    const branch = `writ-${writ.id}`;
    const worktreeDir = path.join(worktreesPath(home), 'test-ws', branch);
    assert.ok(fs.existsSync(worktreeDir), 'worktree should already exist');

    // Run workshop-prepare again (as if re-dispatched after interrupt)
    const event = fakeEvent('writ.ready', { writId: writ.id });
    await workshopPrepare.handler(event, { home, params: {} });

    // Should still signal writ.workspace-ready without crashing
    const readyEvents = findEvents(home, 'writ.workspace-ready');
    assert.equal(readyEvents.length, 1, 'should signal writ.workspace-ready for existing worktree');
    const payload = readyEvents[0]!.payload!;
    assert.equal(payload.writId, writ.id);
    assert.equal(payload.worktreePath, worktreeDir);
  });

  it('handles workshopless writs — signals workspace-ready with null worktreePath', async () => {
    const { home } = createTestGuild(tmpDir, { withWorkshop: true });
    const writ = createWrit(home, {
      title: 'Knowledge writ',
      sourceType: 'patron',
      // No workshop
    });

    const event = fakeEvent('writ.ready', { writId: writ.id });
    await workshopPrepare.handler(event, { home, params: {} });

    // Should signal writ.workspace-ready with null workshop and worktreePath
    const readyEvents = findEvents(home, 'writ.workspace-ready');
    assert.equal(readyEvents.length, 1);
    const payload = readyEvents[0]!.payload!;
    assert.equal(payload.writId, writ.id);
    assert.equal(payload.workshop, null);
    assert.equal(payload.worktreePath, null);
  });

  it('child writs dispatch through writ.ready', async () => {
    const { home } = createTestGuild(tmpDir);

    // Create parent writ
    const parent = createWrit(home, {
      title: 'Parent writ',
      workshop: 'test-ws',
      sourceType: 'patron',
    });

    // Create child writ (inherits workshop from parent)
    const child = createWrit(home, {
      title: 'Child writ',
      parentId: parent.id,
      sourceType: 'anima',
    });

    // Verify child inherited workshop
    const childRecord = readWrit(home, child.id);
    assert.equal(childRecord!.workshop, 'test-ws');

    // Run workshop-prepare for the child (triggered by writ.ready)
    const event = fakeEvent('writ.ready', { writId: child.id });
    await workshopPrepare.handler(event, { home, params: {} });

    // Child worktree should exist
    const branch = `writ-${child.id}`;
    const worktreeDir = path.join(worktreesPath(home), 'test-ws', branch);
    assert.ok(fs.existsSync(worktreeDir), 'child worktree should be created');

    // writ.workspace-ready should have been signaled
    const readyEvents = findEvents(home, 'writ.workspace-ready');
    assert.equal(readyEvents.length, 1);
    const payload = readyEvents[0]!.payload!;
    assert.equal(payload.writId, child.id);
  });

  it('throws on missing writId in payload', async () => {
    const { home } = createTestGuild(tmpDir);

    const event = fakeEvent('writ.ready', {});
    await assert.rejects(
      () => workshopPrepare.handler(event, { home, params: {} }),
      /expected payload with.*writId/i,
    );
  });

  it('throws on null event', async () => {
    const { home } = createTestGuild(tmpDir);

    await assert.rejects(
      () => workshopPrepare.handler(null, { home, params: {} }),
      /requires an event/,
    );
  });

  it('throws on nonexistent writ', async () => {
    const { home } = createTestGuild(tmpDir);

    const event = fakeEvent('writ.ready', { writId: 'wrt-nonexistent' });
    await assert.rejects(
      () => workshopPrepare.handler(event, { home, params: {} }),
      /not found/,
    );
  });
});
