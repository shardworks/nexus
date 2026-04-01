import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  BookEntry,
  StacksApi,
  ChangeEvent,
} from './types.ts';
import type { StacksBackend, BookRef } from './backend.ts';
import { MemoryBackend } from './memory-backend.ts';
import { coalesceEvents } from './cdc.ts';

// ── Test types ────────────────────────────────────────────────────────

interface Writ extends BookEntry {
  id: string;
  title: string;
  status: string;
  parent?: { id: string };
}

// ── Helper: create a StacksApi from a backend ─────────────────────────

// We test through the public API by importing the implementation directly.
import { createStacksApparatus } from './stacks.ts';
import { setGuild } from '@shardworks/nexus-core';

function createTestStacks(backend: StacksBackend): StacksApi {
  const plugin = createStacksApparatus(backend);
  const apparatus = (plugin as { apparatus: { provides: StacksApi; start: (ctx: unknown) => void } }).apparatus;

  // Wire guild() singleton so start() can access config, home, etc.
  setGuild({
    home: '/tmp/test-guild',
    config: () => ({ autoMigrate: true }) as never,
    guildConfig: () => ({}) as never,
    apparatus: () => { throw new Error('not available in test'); },
    kits: () => [],
    apparatuses: () => [],
  });

  // StartupContext only needs on()
  apparatus.start({ on: () => {} });
  return apparatus.provides;
}

// ── Memory Backend Tests ──────────────────────────────────────────────

describe('MemoryBackend', () => {
  let backend: MemoryBackend;
  const ref: BookRef = { ownerId: 'test-plugin', book: 'items' };

  beforeEach(() => {
    backend = new MemoryBackend();
    backend.open({ home: '/tmp/test' });
    backend.ensureBook(ref, { indexes: ['status'] });
  });

  it('put creates a new document', () => {
    const tx = backend.beginTransaction();
    const result = tx.put(ref, { id: '1', name: 'first' });
    tx.commit();

    assert.equal(result.created, true);
  });

  it('put updates an existing document', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'first' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const result = tx2.put(ref, { id: '1', name: 'updated' }, { withPrev: true });
    tx2.commit();

    assert.equal(result.created, false);
    assert.deepEqual(result.prev, { id: '1', name: 'first' });
  });

  it('get returns null for missing document', () => {
    const tx = backend.beginTransaction();
    const result = tx.get(ref, 'missing');
    tx.commit();

    assert.equal(result, null);
  });

  it('get returns the document', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'first' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const result = tx2.get(ref, '1');
    tx2.commit();

    assert.deepEqual(result, { id: '1', name: 'first' });
  });

  it('delete removes a document', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'first' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const result = tx2.delete(ref, '1', { withPrev: true });
    tx2.commit();

    assert.equal(result.found, true);
    assert.deepEqual(result.prev, { id: '1', name: 'first' });

    const tx3 = backend.beginTransaction();
    assert.equal(tx3.get(ref, '1'), null);
    tx3.commit();
  });

  it('delete returns found: false for missing document', () => {
    const tx = backend.beginTransaction();
    const result = tx.delete(ref, 'missing');
    tx.commit();

    assert.equal(result.found, false);
  });

  it('patch merges fields', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'first', status: 'active' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const result = tx2.patch(ref, '1', { status: 'done' });
    tx2.commit();

    assert.deepEqual(result.entry, { id: '1', name: 'first', status: 'done' });
    assert.deepEqual(result.prev, { id: '1', name: 'first', status: 'active' });
  });

  it('patch throws for missing document', () => {
    const tx = backend.beginTransaction();
    assert.throws(() => tx.patch(ref, 'missing', { status: 'done' }), /not found/);
    tx.rollback();
  });

  it('find with equality filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', status: 'active' });
    tx1.put(ref, { id: '2', status: 'done' });
    tx1.put(ref, { id: '3', status: 'active' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, { where: [{ field: 'status', op: 'eq', value: 'active' }] });
    tx2.commit();

    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.id).sort(), ['1', '3']);
  });

  it('find with IN filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', status: 'a' });
    tx1.put(ref, { id: '2', status: 'b' });
    tx1.put(ref, { id: '3', status: 'c' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, { where: [{ field: 'status', op: 'in', values: ['a', 'c'] }] });
    tx2.commit();

    assert.equal(results.length, 2);
  });

  it('find with LIKE filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'commission.posted' });
    tx1.put(ref, { id: '2', name: 'commission.sealed' });
    tx1.put(ref, { id: '3', name: 'anima.started' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, { where: [{ field: 'name', op: 'like', value: 'commission.%' }] });
    tx2.commit();

    assert.equal(results.length, 2);
  });

  it('find with IS NULL filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', endedAt: null });
    tx1.put(ref, { id: '2', endedAt: '2026-01-01' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, { where: [{ field: 'endedAt', op: 'isNull' }] });
    tx2.commit();

    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, '1');
  });

  it('find with range filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', score: 10 });
    tx1.put(ref, { id: '2', score: 50 });
    tx1.put(ref, { id: '3', score: 90 });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, { where: [{ field: 'score', op: 'gt', value: 20 }] });
    tx2.commit();

    assert.equal(results.length, 2);
  });

  it('find with sorting and pagination', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', score: 30 });
    tx1.put(ref, { id: '2', score: 10 });
    tx1.put(ref, { id: '3', score: 50 });
    tx1.put(ref, { id: '4', score: 20 });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const results = tx2.find(ref, {
      orderBy: [{ field: 'score', dir: 'asc' }],
      limit: 2,
      offset: 1,
    });
    tx2.commit();

    assert.equal(results.length, 2);
    assert.equal(results[0]!.id, '4'); // score 20
    assert.equal(results[1]!.id, '1'); // score 30
  });

  it('count with filter', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', status: 'active' });
    tx1.put(ref, { id: '2', status: 'done' });
    tx1.put(ref, { id: '3', status: 'active' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    const n = tx2.count(ref, { where: [{ field: 'status', op: 'eq', value: 'active' }] });
    tx2.commit();

    assert.equal(n, 2);
  });

  it('transaction rollback restores state', () => {
    const tx1 = backend.beginTransaction();
    tx1.put(ref, { id: '1', name: 'original' });
    tx1.commit();

    const tx2 = backend.beginTransaction();
    tx2.put(ref, { id: '1', name: 'changed' });
    tx2.put(ref, { id: '2', name: 'new' });
    tx2.rollback();

    const tx3 = backend.beginTransaction();
    const doc1 = tx3.get(ref, '1');
    const doc2 = tx3.get(ref, '2');
    tx3.commit();

    assert.deepEqual(doc1, { id: '1', name: 'original' });
    assert.equal(doc2, null);
  });
});

// ── CDC Coalescing Tests ──────────────────────────────────────────────

describe('coalesceEvents', () => {
  it('create coalesces to create', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'create', entry: { id: '1', v: 1 } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'create');
  });

  it('create → update coalesces to create with final state', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'create', entry: { id: '1', v: 1 } },
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'update', entry: { id: '1', v: 2 }, prev: { id: '1', v: 1 } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'create');
    assert.deepEqual((events[0] as { entry: BookEntry }).entry, { id: '1', v: 2 });
  });

  it('create → delete produces no event', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'create', entry: { id: '1' } },
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'delete', prev: { id: '1' } },
    ]);
    assert.equal(events.length, 0);
  });

  it('update → update coalesces to single update', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'update', entry: { id: '1', v: 2 }, prev: { id: '1', v: 1 } },
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'update', entry: { id: '1', v: 3 }, prev: { id: '1', v: 2 } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'update');
    const e = events[0] as { prev: BookEntry; entry: BookEntry };
    assert.deepEqual(e.prev, { id: '1', v: 1 }); // first prev
    assert.deepEqual(e.entry, { id: '1', v: 3 }); // final entry
  });

  it('update → delete coalesces to delete with original prev', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'update', entry: { id: '1', v: 2 }, prev: { id: '1', v: 1 } },
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'delete', prev: { id: '1', v: 2 } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'delete');
    assert.deepEqual((events[0] as { prev: BookEntry }).prev, { id: '1', v: 1 });
  });

  it('independent documents produce separate events', () => {
    const events = coalesceEvents([
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '1', type: 'create', entry: { id: '1' } },
      { ref: 'p/b', ownerId: 'p', book: 'b', docId: '2', type: 'create', entry: { id: '2' } },
    ]);
    assert.equal(events.length, 2);
  });
});

// ── Stacks API Integration Tests ──────────────────────────────────────

describe('StacksApi (memory backend)', () => {
  let stacks: StacksApi;
  let backend: MemoryBackend;
  const ownerId = 'test-plugin';

  beforeEach(() => {
    backend = new MemoryBackend();
    backend.open({ home: '/tmp/test' });
    backend.ensureBook({ ownerId, book: 'writs' }, { indexes: ['status'] });
    backend.ensureBook({ ownerId, book: 'sessions' }, { indexes: ['writId'] });
    stacks = createTestStacks(backend);
  });

  it('put and get', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });

    const doc = await writs.get('w1');
    assert.deepEqual(doc, { id: 'w1', title: 'First', status: 'ready' });
  });

  it('put updates existing document', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });
    await writs.put({ id: 'w1', title: 'Updated', status: 'active' });

    const doc = await writs.get('w1');
    assert.equal(doc?.title, 'Updated');
    assert.equal(doc?.status, 'active');
  });

  it('get returns null for missing', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    const doc = await writs.get('missing');
    assert.equal(doc, null);
  });

  it('delete removes document', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });
    await writs.delete('w1');
    assert.equal(await writs.get('w1'), null);
  });

  it('delete is silent for missing document', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.delete('missing'); // should not throw
  });

  it('patch merges fields', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });

    const result = await writs.patch('w1', { status: 'active' });
    assert.equal(result.status, 'active');
    assert.equal(result.title, 'First'); // unchanged
  });

  it('patch throws for missing document', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await assert.rejects(() => writs.patch('missing', { status: 'done' }), /not found/);
  });

  it('find with query', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'A', status: 'ready' });
    await writs.put({ id: 'w2', title: 'B', status: 'active' });
    await writs.put({ id: 'w3', title: 'C', status: 'ready' });

    const results = await writs.find({
      where: [['status', '=', 'ready']],
    });

    assert.equal(results.length, 2);
  });

  it('list returns all documents', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'A', status: 'ready' });
    await writs.put({ id: 'w2', title: 'B', status: 'active' });

    const all = await writs.list();
    assert.equal(all.length, 2);
  });

  it('count with filter', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'A', status: 'ready' });
    await writs.put({ id: 'w2', title: 'B', status: 'active' });
    await writs.put({ id: 'w3', title: 'C', status: 'ready' });

    const n = await writs.count([['status', '=', 'ready']]);
    assert.equal(n, 2);
  });

  it('readBook is read-only (no write methods)', () => {
    const readOnly = stacks.readBook<Writ>(ownerId, 'writs');
    assert.equal(typeof readOnly.get, 'function');
    assert.equal(typeof readOnly.find, 'function');
    assert.equal(typeof readOnly.list, 'function');
    assert.equal(typeof readOnly.count, 'function');
    // Write methods should not exist on the readonly book
    assert.equal(typeof (readOnly as any).put, 'undefined');
    assert.equal(typeof (readOnly as any).delete, 'undefined');
    assert.equal(typeof (readOnly as any).patch, 'undefined');
  });

  it('explicit transaction commits atomically', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');

    await stacks.transaction(async (tx) => {
      const txWrits = tx.book<Writ>(ownerId, 'writs');
      await txWrits.put({ id: 'w1', title: 'A', status: 'ready' });
      await txWrits.put({ id: 'w2', title: 'B', status: 'ready' });
    });

    const all = await writs.list();
    assert.equal(all.length, 2);
  });

  it('explicit transaction rolls back on error', async () => {
    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'existing', title: 'Pre', status: 'ready' });

    await assert.rejects(async () => {
      await stacks.transaction(async (tx) => {
        const txWrits = tx.book<Writ>(ownerId, 'writs');
        await txWrits.put({ id: 'new1', title: 'A', status: 'ready' });
        await txWrits.put({ id: 'existing', title: 'Changed', status: 'active' });
        throw new Error('simulated failure');
      });
    }, /simulated failure/);

    // new1 should not exist (rolled back)
    assert.equal(await writs.get('new1'), null);
    // existing should be unchanged
    const doc = await writs.get('existing');
    assert.equal(doc?.title, 'Pre');
  });

  it('CDC Phase 1 handler fires and can cascade', async () => {
    const events: ChangeEvent<BookEntry>[] = [];

    // Register a Phase 1 handler (failOnError: true by default)
    stacks.watch<Writ>(ownerId, 'writs', async (event) => {
      events.push(event);
    });

    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'create');
  });

  it('CDC Phase 1 handler rollback on error', async () => {
    stacks.watch<Writ>(ownerId, 'writs', async () => {
      throw new Error('handler failed');
    });

    const writs = stacks.book<Writ>(ownerId, 'writs');
    await assert.rejects(() =>
      writs.put({ id: 'w1', title: 'First', status: 'ready' }),
      /handler failed/,
    );

    // Document should not exist (transaction rolled back)
    assert.equal(await writs.get('w1'), null);
  });

  it('CDC Phase 2 handler fires after commit, errors logged not thrown', async () => {
    const events: ChangeEvent<BookEntry>[] = [];
    let phase2Error = false;

    stacks.watch<Writ>(ownerId, 'writs', async () => {
      phase2Error = true;
      throw new Error('phase 2 error');
    }, { failOnError: false });

    // Also register a tracker to verify event was fired
    stacks.watch<Writ>(ownerId, 'writs', async (event) => {
      events.push(event);
    }, { failOnError: false });

    const writs = stacks.book<Writ>(ownerId, 'writs');
    await writs.put({ id: 'w1', title: 'First', status: 'ready' });

    // Document should exist (Phase 2 errors don't roll back)
    const doc = await writs.get('w1');
    assert.equal(doc?.title, 'First');
    assert.equal(phase2Error, true);
    assert.equal(events.length, 1);
  });

  it('cascade: Phase 1 handler writes join the transaction', async () => {
    // Register cascade handler: when a writ is cancelled, cancel children
    stacks.watch<Writ>(ownerId, 'writs', async (event) => {
      if (event.type !== 'update') return;
      if (event.entry.status !== 'cancelled' || event.prev.status === 'cancelled') return;

      const writs = stacks.book<Writ>(ownerId, 'writs');
      const children = await writs.find({
        where: [['parent.id', '=', event.entry.id]],
      });
      for (const child of children) {
        if (child.status !== 'cancelled') {
          await writs.put({ ...child, status: 'cancelled' });
        }
      }
    });

    const writs = stacks.book<Writ>(ownerId, 'writs');

    // Create parent and children
    await writs.put({ id: 'parent', title: 'Parent', status: 'active' });
    await writs.put({ id: 'child1', title: 'C1', status: 'active', parent: { id: 'parent' } });
    await writs.put({ id: 'child2', title: 'C2', status: 'active', parent: { id: 'parent' } });

    // Cancel the parent — cascade should cancel children
    await writs.put({ id: 'parent', title: 'Parent', status: 'cancelled' });

    const c1 = await writs.get('child1');
    const c2 = await writs.get('child2');
    assert.equal(c1?.status, 'cancelled');
    assert.equal(c2?.status, 'cancelled');
  });
});
