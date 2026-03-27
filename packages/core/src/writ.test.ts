import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  createWrit,
  readWrit,
  listWrits,
  activateWrit,
  completeWrit,
  failWrit,
  cancelWrit,
  interruptWrit,
  getWritChildren,
  rollupParent,
  buildProgressAppendix,
  hydratePromptTemplate,
  validateWritType,
  BUILTIN_WRIT_TYPES,
} from './writ.ts';
import { listEvents } from './events.ts';

/**
 * Set up a minimal guild with Ledger including writs tables.
 * Accepts optional writTypes and standingOrders for guild.json.
 */
function setupTestGuild(opts?: {
  writTypes?: Record<string, unknown>;
  standingOrders?: unknown[];
}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'writ-test-'));
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
    writTypes: opts?.writTypes ?? {},
  };
  if (opts?.standingOrders) {
    config.clockworks = { standingOrders: opts.standingOrders };
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

  return home;
}

// ── Create & Validate ──────────────────────────────────────────────────

describe('createWrit', () => {
  it('creates a writ with built-in type (summon)', () => {
    const home = setupTestGuild();
    const writ = createWrit(home, { type: 'summon', title: 'Test summon' });

    assert.ok(writ.id.startsWith('wrt-'));
    assert.equal(writ.type, 'summon');
    assert.equal(writ.title, 'Test summon');
    assert.equal(writ.status, 'ready');
    assert.equal(writ.parentId, null);
    assert.equal(writ.sessionId, null);
    assert.equal(writ.workshop, null);
    assert.equal(writ.sourceType, 'engine');
    assert.equal(writ.sourceId, null);
  });

  it('creates a writ with guild-defined type', () => {
    const home = setupTestGuild({ writTypes: { task: { description: 'A task' } } });
    const writ = createWrit(home, { type: 'task', title: 'Test task' });
    assert.equal(writ.type, 'task');
  });

  it('throws on unknown type', () => {
    const home = setupTestGuild();
    assert.throws(
      () => createWrit(home, { type: 'unknown', title: 'Bad' }),
      /not declared in guild.json/,
    );
  });

  it('creates a writ with description and parent', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const child = createWrit(home, {
      type: 'summon',
      title: 'Child',
      description: 'Some description',
      parentId: parent.id,
    });

    assert.equal(child.description, 'Some description');
    assert.equal(child.parentId, parent.id);
  });

  it('creates a writ with explicit workshop', () => {
    const home = setupTestGuild();
    const writ = createWrit(home, {
      type: 'summon',
      title: 'Workshop writ',
      workshop: 'my-app',
    });
    assert.equal(writ.workshop, 'my-app');
  });

  it('inherits workshop from parent when omitted', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, {
      type: 'summon',
      title: 'Parent',
      workshop: 'my-app',
    });
    const child = createWrit(home, {
      type: 'summon',
      title: 'Child',
      parentId: parent.id,
    });
    assert.equal(child.workshop, 'my-app');
  });

  it('workshop is null when no parent and not specified', () => {
    const home = setupTestGuild();
    const writ = createWrit(home, { type: 'summon', title: 'No workshop' });
    assert.equal(writ.workshop, null);
  });

  it('sets sourceType and sourceId', () => {
    const home = setupTestGuild();
    const writ = createWrit(home, {
      type: 'summon',
      title: 'Patron writ',
      sourceType: 'patron',
      sourceId: null,
    });
    assert.equal(writ.sourceType, 'patron');
    assert.equal(writ.sourceId, null);
  });

  it('defaults sourceType to engine', () => {
    const home = setupTestGuild();
    const writ = createWrit(home, { type: 'summon', title: 'Default source' });
    assert.equal(writ.sourceType, 'engine');
  });
});

describe('readWrit', () => {
  it('reads an existing writ', () => {
    const home = setupTestGuild();
    const created = createWrit(home, { type: 'summon', title: 'Read me' });
    const read = readWrit(home, created.id);
    assert.ok(read);
    assert.equal(read.id, created.id);
    assert.equal(read.title, 'Read me');
  });

  it('returns null for nonexistent writ', () => {
    const home = setupTestGuild();
    assert.equal(readWrit(home, 'wrt-nonexistent'), null);
  });
});

describe('listWrits', () => {
  it('lists all writs', () => {
    const home = setupTestGuild({ writTypes: { task: { description: 'A task' } } });
    createWrit(home, { type: 'task', title: 'A' });
    createWrit(home, { type: 'summon', title: 'B' });
    const all = listWrits(home);
    assert.equal(all.length, 2);
  });

  it('filters by type', () => {
    const home = setupTestGuild({ writTypes: { task: { description: 'A task' } } });
    createWrit(home, { type: 'task', title: 'A' });
    createWrit(home, { type: 'summon', title: 'B' });
    const tasks = listWrits(home, { type: 'task' });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.type, 'task');
  });

  it('filters by status', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'A' });
    createWrit(home, { type: 'summon', title: 'B' });
    activateWrit(home, w.id, 'ses-1');

    const ready = listWrits(home, { status: 'ready' });
    assert.equal(ready.length, 1);
    const active = listWrits(home, { status: 'active' });
    assert.equal(active.length, 1);
  });

  it('filters by parentId', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });
    createWrit(home, { type: 'summon', title: 'Orphan' });

    const children = listWrits(home, { parentId: parent.id });
    assert.equal(children.length, 1);
    assert.equal(children[0]!.title, 'Child');

    const roots = listWrits(home, { parentId: null as unknown as undefined });
    assert.equal(roots.length, 2); // parent + orphan
  });

  it('filters by workshop', () => {
    const home = setupTestGuild();
    createWrit(home, { type: 'summon', title: 'A', workshop: 'ws-a' });
    createWrit(home, { type: 'summon', title: 'B', workshop: 'ws-b' });
    createWrit(home, { type: 'summon', title: 'C' }); // no workshop

    const wsA = listWrits(home, { workshop: 'ws-a' });
    assert.equal(wsA.length, 1);
    assert.equal(wsA[0]!.title, 'A');
  });
});

// ── Status Transitions ─────────────────────────────────────────────────

describe('activateWrit', () => {
  it('transitions ready → active', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Activate me' });
    const result = activateWrit(home, w.id, 'ses-1');
    assert.equal(result.status, 'active');
    assert.equal(result.sessionId, 'ses-1');
  });

  it('throws on non-ready writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    activateWrit(home, w.id, 'ses-1');
    assert.throws(
      () => activateWrit(home, w.id, 'ses-2'),
      /expected "ready"/,
    );
  });

  it('throws on nonexistent writ', () => {
    const home = setupTestGuild();
    assert.throws(
      () => activateWrit(home, 'wrt-nope', 'ses-1'),
      /not found/,
    );
  });
});

describe('completeWrit', () => {
  it('completes active writ with no children', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Complete me' });
    activateWrit(home, w.id, 'ses-1');
    const result = completeWrit(home, w.id);
    assert.equal(result.status, 'completed');
  });

  it('completes active writ with all children completed', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    // Complete the child first
    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    // Now complete the parent
    activateWrit(home, parent.id, 'ses-p');
    const result = completeWrit(home, parent.id);
    assert.equal(result.status, 'completed');
  });

  it('transitions to pending when children are incomplete', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    activateWrit(home, parent.id, 'ses-p');
    const result = completeWrit(home, parent.id);
    assert.equal(result.status, 'pending');
    assert.equal(result.sessionId, null);
  });

  it('treats cancelled children as complete for pending check', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    cancelWrit(home, child.id);
    activateWrit(home, parent.id, 'ses-p');
    const result = completeWrit(home, parent.id);
    assert.equal(result.status, 'completed');
  });

  it('throws on non-active writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    assert.throws(
      () => completeWrit(home, w.id),
      /expected "active"/,
    );
  });
});

describe('failWrit', () => {
  it('fails an active writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Fail me' });
    activateWrit(home, w.id, 'ses-1');
    const result = failWrit(home, w.id);
    assert.equal(result.status, 'failed');
  });

  it('fails a ready writ (not yet active)', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    assert.equal(w.status, 'ready');
    const result = failWrit(home, w.id);
    assert.equal(result.status, 'failed');
  });

  it('throws on terminal writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    activateWrit(home, w.id, 'ses-1');
    failWrit(home, w.id);
    assert.throws(
      () => failWrit(home, w.id),
      /terminal/,
    );
  });
});

describe('cancelWrit', () => {
  it('cancels a ready writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Cancel me' });
    const result = cancelWrit(home, w.id);
    assert.equal(result.status, 'cancelled');
  });

  it('cancels an active writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    activateWrit(home, w.id, 'ses-1');
    const result = cancelWrit(home, w.id);
    assert.equal(result.status, 'cancelled');
  });

  it('cancels a pending writ', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });
    activateWrit(home, parent.id, 'ses-1');
    completeWrit(home, parent.id); // → pending

    const result = cancelWrit(home, parent.id);
    assert.equal(result.status, 'cancelled');
  });

  it('throws on terminal writ (completed)', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    activateWrit(home, w.id, 'ses-1');
    completeWrit(home, w.id);
    assert.throws(
      () => cancelWrit(home, w.id),
      /terminal/,
    );
  });

  it('throws on terminal writ (failed)', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    activateWrit(home, w.id, 'ses-1');
    failWrit(home, w.id);
    assert.throws(
      () => cancelWrit(home, w.id),
      /terminal/,
    );
  });
});

describe('interruptWrit', () => {
  it('interrupts active → ready', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Interrupt me' });
    activateWrit(home, w.id, 'ses-1');
    const result = interruptWrit(home, w.id);
    assert.equal(result.status, 'ready');
    assert.equal(result.sessionId, null);
  });

  it('throws on non-active writ', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    assert.throws(
      () => interruptWrit(home, w.id),
      /expected "active"/,
    );
  });
});

// ── Children-aware Interruption (summon-engine step 9 pattern) ─────────

describe('children-aware session-end', () => {
  it('completeWrit (→ pending) when active writ has incomplete children', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    createWrit(home, { type: 'summon', title: 'Child in ready', parentId: parent.id });

    activateWrit(home, parent.id, 'ses-p');

    // Simulate summon-engine step 9: check children before deciding
    const children = getWritChildren(home, parent.id);
    const hasIncomplete = children.some(c =>
      c.status !== 'completed' && c.status !== 'cancelled',
    );
    assert.ok(hasIncomplete, 'should detect incomplete child');

    // With incomplete children → completeWrit (transitions to pending)
    const result = completeWrit(home, parent.id);
    assert.equal(result.status, 'pending');
    assert.equal(result.sessionId, null);
  });

  it('interruptWrit (→ ready) when active writ has no children', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'No children' });
    activateWrit(home, w.id, 'ses-1');

    const children = getWritChildren(home, w.id);
    const hasIncomplete = children.some(c =>
      c.status !== 'completed' && c.status !== 'cancelled',
    );
    assert.ok(!hasIncomplete, 'should have no incomplete children');

    const result = interruptWrit(home, w.id);
    assert.equal(result.status, 'ready');
  });

  it('interruptWrit (→ ready) when all children are completed', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Done child', parentId: parent.id });

    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    activateWrit(home, parent.id, 'ses-p');

    const children = getWritChildren(home, parent.id);
    const hasIncomplete = children.some(c =>
      c.status !== 'completed' && c.status !== 'cancelled',
    );
    assert.ok(!hasIncomplete, 'all children should be complete');

    const result = interruptWrit(home, parent.id);
    assert.equal(result.status, 'ready');
  });
});

// ── Completion Rollup ──────────────────────────────────────────────────

describe('rollupParent', () => {
  it('auto-completes parent when no standing order exists for type', () => {
    const home = setupTestGuild({ writTypes: { feature: { description: 'A feature' } } });
    const parent = createWrit(home, { type: 'feature', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    // Get parent to pending state
    activateWrit(home, parent.id, 'ses-p');
    completeWrit(home, parent.id); // → pending (child incomplete)

    // Complete child → triggers rollup
    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    // Parent should auto-complete (no standing order for feature.ready)
    const result = readWrit(home, parent.id);
    assert.ok(result);
    assert.equal(result.status, 'completed');
  });

  it('transitions parent to ready when standing order exists for type', () => {
    const home = setupTestGuild({
      writTypes: { feature: { description: 'A feature' } },
      standingOrders: [{ on: 'feature.ready', summon: 'artificer' }],
    });

    const parent = createWrit(home, { type: 'feature', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    activateWrit(home, parent.id, 'ses-p');
    completeWrit(home, parent.id); // → pending

    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    // Parent should be ready (standing order exists for feature.ready)
    const result = readWrit(home, parent.id);
    assert.ok(result);
    assert.equal(result.status, 'ready');
  });

  it('does nothing when parent is not pending', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    // Parent is still ready (not activated, not pending)
    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    const result = readWrit(home, parent.id);
    assert.ok(result);
    assert.equal(result.status, 'ready'); // unchanged
  });

  it('multi-level rollup: grandchild → child → parent', () => {
    const home = setupTestGuild({
      writTypes: { feature: { description: 'A feature' } },
    });

    const grandparent = createWrit(home, { type: 'feature', title: 'GP' });
    const parent = createWrit(home, { type: 'summon', title: 'P', parentId: grandparent.id });
    const child = createWrit(home, { type: 'summon', title: 'C', parentId: parent.id });

    // Get grandparent and parent to pending
    activateWrit(home, grandparent.id, 'ses-gp');
    completeWrit(home, grandparent.id); // → pending (parent incomplete)
    activateWrit(home, parent.id, 'ses-p');
    completeWrit(home, parent.id); // → pending (child incomplete)

    // Complete child → should cascade rollup up
    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id);

    // Parent should auto-complete (no standing order for summon.ready)
    const parentResult = readWrit(home, parent.id);
    assert.ok(parentResult);
    assert.equal(parentResult.status, 'completed');

    // Grandparent should auto-complete (no standing order for feature.ready)
    const gpResult = readWrit(home, grandparent.id);
    assert.ok(gpResult);
    assert.equal(gpResult.status, 'completed');
  });
});

// ── Cascade Cancellation ───────────────────────────────────────────────

describe('cascade cancellation', () => {
  it('cancels ready/pending children when parent fails', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const readyChild = createWrit(home, { type: 'summon', title: 'Ready', parentId: parent.id });
    const completedChild = createWrit(home, { type: 'summon', title: 'Done', parentId: parent.id });

    // Complete one child
    activateWrit(home, completedChild.id, 'ses-c');
    completeWrit(home, completedChild.id);

    // Fail parent
    activateWrit(home, parent.id, 'ses-p');
    failWrit(home, parent.id);

    // Ready child should be cancelled
    assert.equal(readWrit(home, readyChild.id)!.status, 'cancelled');
    // Completed child should be preserved
    assert.equal(readWrit(home, completedChild.id)!.status, 'completed');
  });

  it('leaves active children alone when parent fails', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const activeChild = createWrit(home, { type: 'summon', title: 'Active', parentId: parent.id });

    activateWrit(home, activeChild.id, 'ses-ac');
    activateWrit(home, parent.id, 'ses-p');
    failWrit(home, parent.id);

    // Active child should still be active
    assert.equal(readWrit(home, activeChild.id)!.status, 'active');
  });

  it('cascades cancellation to nested children', () => {
    const home = setupTestGuild();
    const root = createWrit(home, { type: 'summon', title: 'Root' });
    const mid = createWrit(home, { type: 'summon', title: 'Mid', parentId: root.id });
    const leaf = createWrit(home, { type: 'summon', title: 'Leaf', parentId: mid.id });

    activateWrit(home, root.id, 'ses-r');
    failWrit(home, root.id);

    assert.equal(readWrit(home, mid.id)!.status, 'cancelled');
    assert.equal(readWrit(home, leaf.id)!.status, 'cancelled');
  });
});

// ── Progress Appendix ──────────────────────────────────────────────────

describe('buildProgressAppendix', () => {
  it('returns null when writ has no children', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'Solo' });
    assert.equal(buildProgressAppendix(home, w.id), null);
  });

  it('builds markdown appendix with child statuses', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const done = createWrit(home, { type: 'summon', title: 'Done task', parentId: parent.id });
    createWrit(home, { type: 'summon', title: 'Pending task', parentId: parent.id });

    activateWrit(home, done.id, 'ses-1');
    completeWrit(home, done.id);

    const appendix = buildProgressAppendix(home, parent.id);
    assert.ok(appendix);
    assert.ok(appendix.includes('Prior Progress'));
    assert.ok(appendix.includes('Done task'));
    assert.ok(appendix.includes('Pending task'));
  });

  it('includes nested child counts in summary', () => {
    const home = setupTestGuild({ writTypes: { task: { description: 'A task' } } });
    const parent = createWrit(home, { type: 'summon', title: 'Parent' });
    const mid = createWrit(home, { type: 'task', title: 'Mid', parentId: parent.id });
    createWrit(home, { type: 'summon', title: 'Leaf 1', parentId: mid.id });
    createWrit(home, { type: 'summon', title: 'Leaf 2', parentId: mid.id });

    const appendix = buildProgressAppendix(home, parent.id);
    assert.ok(appendix);
    // Mid has 2 children, 0 completed
    assert.ok(appendix.includes('2 tasks'));
  });
});

// ── Prompt Template Hydration ──────────────────────────────────────────

describe('hydratePromptTemplate', () => {
  it('returns null when no template provided', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    assert.equal(hydratePromptTemplate(home, undefined, {}, w.id), null);
  });

  it('substitutes payload fields', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    const result = hydratePromptTemplate(
      home,
      'Hello {{name}}, workshop is {{workshop}}',
      { name: 'Alice', workshop: 'my-app' },
      w.id,
    );
    assert.equal(result, 'Hello Alice, workshop is my-app');
  });

  it('substitutes writ fields', () => {
    const home = setupTestGuild();
    const w = createWrit(home, {
      type: 'summon',
      title: 'Build feature X',
      description: 'Detailed spec here',
    });
    const result = hydratePromptTemplate(
      home,
      'Task: {{writ.title}}\n\n{{writ.description}}',
      {},
      w.id,
    );
    assert.equal(result, 'Task: Build feature X\n\nDetailed spec here');
  });

  it('substitutes writ.parent fields', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { type: 'summon', title: 'Parent Title' });
    const child = createWrit(home, { type: 'summon', title: 'Child', parentId: parent.id });

    const result = hydratePromptTemplate(
      home,
      'Parent: {{writ.parent.title}}, Self: {{writ.title}}',
      {},
      child.id,
    );
    assert.equal(result, 'Parent: Parent Title, Self: Child');
  });

  it('replaces missing values with empty string', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { type: 'summon', title: 'X' });
    const result = hydratePromptTemplate(
      home,
      '{{nonexistent}} and {{writ.parent.title}}',
      {},
      w.id,
    );
    assert.equal(result, ' and ');
  });
});

// ── Type Validation ────────────────────────────────────────────────────

describe('validateWritType', () => {
  it('accepts built-in types', () => {
    const home = setupTestGuild();
    for (const t of BUILTIN_WRIT_TYPES) {
      assert.doesNotThrow(() => validateWritType(home, t));
    }
  });

  it('accepts guild-defined types', () => {
    const home = setupTestGuild({ writTypes: { epic: { description: 'An epic' } } });
    assert.doesNotThrow(() => validateWritType(home, 'epic'));
  });

  it('rejects unknown types', () => {
    const home = setupTestGuild();
    assert.throws(
      () => validateWritType(home, 'unknown'),
      /not declared in guild.json/,
    );
  });

  it('rejects mandate type (no longer built-in)', () => {
    const home = setupTestGuild();
    assert.throws(
      () => validateWritType(home, 'mandate'),
      /not declared in guild.json/,
    );
  });
});

// ── Duplicate Event Prevention ─────────────────────────────────────────

describe('duplicate writ.completed prevention', () => {
  it('fires writ.completed exactly once for type=writ writs', () => {
    const home = setupTestGuild();
    const w = createWrit(home, { title: 'Type-writ writ' });
    activateWrit(home, w.id, 'ses-1');
    completeWrit(home, w.id);

    // Count writ.completed events for this writ
    const events = listEvents(home, { name: 'writ.completed' });
    const matching = events.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p?.writId === w.id;
    });
    assert.equal(matching.length, 1,
      'Expected exactly one writ.completed event for a type=writ writ');
  });

  it('fires both type-specific and generic events for custom types', () => {
    const home = setupTestGuild({ writTypes: { task: { description: 'A task' } } });
    const w = createWrit(home, { type: 'task', title: 'Custom type writ' });
    activateWrit(home, w.id, 'ses-1');
    completeWrit(home, w.id);

    // Should have task.completed AND writ.completed
    const taskEvents = listEvents(home, { name: 'task.completed' });
    const writEvents = listEvents(home, { name: 'writ.completed' });
    const taskMatching = taskEvents.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p?.writId === w.id;
    });
    const writMatching = writEvents.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p?.writId === w.id;
    });
    assert.equal(taskMatching.length, 1, 'Expected one task.completed event');
    assert.equal(writMatching.length, 1, 'Expected one writ.completed event');
  });

  it('rollupParent auto-complete fires writ.completed exactly once for type=writ parent', () => {
    const home = setupTestGuild();
    const parent = createWrit(home, { title: 'Parent' });
    const child = createWrit(home, { title: 'Child', parentId: parent.id });

    activateWrit(home, parent.id, 'ses-p');
    completeWrit(home, parent.id); // → pending (child incomplete)

    activateWrit(home, child.id, 'ses-c');
    completeWrit(home, child.id); // → triggers rollup → parent auto-completes

    // Count writ.completed events for the PARENT
    const events = listEvents(home, { name: 'writ.completed' });
    const parentEvents = events.filter(e => {
      const p = e.payload as Record<string, unknown> | null;
      return p?.writId === parent.id;
    });
    assert.equal(parentEvents.length, 1,
      'Expected exactly one writ.completed event for auto-completed parent');
  });
});
