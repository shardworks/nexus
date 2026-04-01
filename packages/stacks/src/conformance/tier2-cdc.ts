/**
 * Tier 2 — CDC Behavioral Correctness conformance tests.
 *
 * Failures here mean the CDC contract is violated.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StacksBackend } from '../backend.ts';
import type { BookEntry } from '../types.ts';
import {
  createTestStacks,
  collectEvents,
  seedDocument,
  spyingBackendFactory,
  OWNER,
  BOOK,
  REF,
  type TestStacks,
} from './helpers.ts';

export function tier2Cdc(backendFactory: () => StacksBackend): void {
  describe('Tier 2 — CDC Behavioral Correctness', () => {
    let t: TestStacks;

    beforeEach(() => {
      t = createTestStacks(backendFactory);
      t.ensureBook(OWNER, BOOK);
    });

    afterEach(() => {
      t.backend.close();
    });

    it('2.1 Put (new document) fires create event', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'create');
      assert.deepStrictEqual(events[0].entry, { id: 'a', name: 'Alice' });
    });

    it('2.2 Put (existing document) fires update event with prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Bob' });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'update');
      if (events[0].type === 'update') {
        assert.deepStrictEqual(events[0].entry, { id: 'a', name: 'Bob' });
        assert.deepStrictEqual(events[0].prev, { id: 'a', name: 'Alice' });
      }
    });

    it('2.3 Patch fires update event with prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice', score: 10 });
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.patch('a', { score: 20 });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'update');
      if (events[0].type === 'update') {
        assert.deepStrictEqual(events[0].entry, { id: 'a', name: 'Alice', score: 20 });
        assert.deepStrictEqual(events[0].prev, { id: 'a', name: 'Alice', score: 10 });
      }
    });

    it('2.4 Delete fires delete event with prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.delete('a');

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'delete');
      if (events[0].type === 'delete') {
        assert.strictEqual(events[0].id, 'a');
        assert.deepStrictEqual(events[0].prev, { id: 'a', name: 'Alice' });
      }
    });

    it('2.5 Delete of nonexistent document fires no event', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.delete('nonexistent');

      assert.strictEqual(events.length, 0);
    });

    it('2.6 No pre-read when no handlers are registered', async () => {
      // Use a spying backend to verify put() is called with withPrev: false
      const spy = spyingBackendFactory(backendFactory);
      const spyT = createTestStacks(spy.factory);
      spyT.ensureBook(OWNER, BOOK);

      // No watch() calls — no handlers registered
      const book = spyT.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      // The put should have been called with withPrev: false (no pre-read needed)
      const putCalls = spy.putCalls.filter(
        c => c.ref.ownerId === OWNER && c.ref.book === BOOK,
      );
      assert.strictEqual(putCalls.length, 1);
      assert.strictEqual(putCalls[0].withPrev, false);

      spyT.backend.close();
    });

    it('2.6a Put with identical document fires update event', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK);
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'update');
      if (events[0].type === 'update') {
        assert.deepStrictEqual(events[0].entry, { id: 'a', name: 'Alice' });
        assert.deepStrictEqual(events[0].prev, { id: 'a', name: 'Alice' });
      }
    });

    it('2.6b CDC events include ownerId and book fields — create', async () => {
      const owner = 'my-plugin';
      const bookName = 'tasks';
      t.ensureBook(owner, bookName);

      const events = collectEvents(t.stacks, owner, bookName);
      const book = t.stacks.book<BookEntry>(owner, bookName);

      await book.put({ id: 'a', title: 'test' });
      assert.strictEqual(events[0].type, 'create');
      assert.strictEqual(events[0].ownerId, owner);
      assert.strictEqual(events[0].book, bookName);
    });

    it('2.6b CDC events include ownerId and book fields — update', async () => {
      const owner = 'my-plugin';
      const bookName = 'tasks';
      t.ensureBook(owner, bookName);

      // Seed via backend to avoid tripping the CDC lock
      seedDocument(t.backend, { ownerId: owner, book: bookName }, { id: 'a', title: 'test' });

      const events = collectEvents(t.stacks, owner, bookName);
      const book = t.stacks.book<BookEntry>(owner, bookName);

      await book.put({ id: 'a', title: 'updated' });
      assert.strictEqual(events[0].type, 'update');
      assert.strictEqual(events[0].ownerId, owner);
      assert.strictEqual(events[0].book, bookName);
    });

    it('2.6b CDC events include ownerId and book fields — delete', async () => {
      const owner = 'my-plugin';
      const bookName = 'tasks';
      t.ensureBook(owner, bookName);

      seedDocument(t.backend, { ownerId: owner, book: bookName }, { id: 'a', title: 'test' });

      const events = collectEvents(t.stacks, owner, bookName);
      const book = t.stacks.book<BookEntry>(owner, bookName);

      await book.delete('a');
      assert.strictEqual(events[0].type, 'delete');
      assert.strictEqual(events[0].ownerId, owner);
      assert.strictEqual(events[0].book, bookName);
    });

    it('2.7 Phase 1 handler error rolls back the triggering write', async () => {
      t.stacks.watch(OWNER, BOOK, async () => {
        throw new Error('cascade failed');
      }, { failOnError: true });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await assert.rejects(
        () => book.put({ id: 'a', name: 'Alice' }),
        /cascade failed/,
      );

      const result = await book.get('a');
      assert.strictEqual(result, null);
    });

    it('2.8 Phase 2 handler error does not roll back the write', async () => {
      t.stacks.watch(OWNER, BOOK, async () => {
        throw new Error('notification failed');
      }, { failOnError: false });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice' });
    });

    it('2.9 Phase 1 handlers fire before Phase 2 handlers', async () => {
      const order: string[] = [];
      t.stacks.watch(OWNER, BOOK, () => { order.push('phase1'); }, { failOnError: true });
      t.stacks.watch(OWNER, BOOK, () => { order.push('phase2'); }, { failOnError: false });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      assert.deepStrictEqual(order, ['phase1', 'phase2']);
    });

    it('2.10 Multiple handlers fire in registration order within each phase', async () => {
      const order: string[] = [];
      t.stacks.watch(OWNER, BOOK, () => { order.push('p1-first'); }, { failOnError: true });
      t.stacks.watch(OWNER, BOOK, () => { order.push('p1-second'); }, { failOnError: true });
      t.stacks.watch(OWNER, BOOK, () => { order.push('p2-first'); }, { failOnError: false });
      t.stacks.watch(OWNER, BOOK, () => { order.push('p2-second'); }, { failOnError: false });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      assert.deepStrictEqual(order, ['p1-first', 'p1-second', 'p2-first', 'p2-second']);
    });

    it('2.11 Phase 1 handler writes are atomic with the trigger', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);

      t.stacks.watch(OWNER, bookNameA, async () => {
        const booksB = t.stacks.book<BookEntry>(OWNER, bookNameB);
        await booksB.put({ id: 'derived', source: 'a' });
      }, { failOnError: true });

      const booksA = t.stacks.book<BookEntry>(OWNER, bookNameA);
      await booksA.put({ id: 'a', name: 'Alice' });

      const resultA = await booksA.get('a');
      const resultB = await t.stacks.book<BookEntry>(OWNER, bookNameB).get('derived');
      assert.notStrictEqual(resultA, null);
      assert.notStrictEqual(resultB, null);
    });

    it('2.12 Phase 1 handler failure rolls back handler writes AND trigger', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);

      t.stacks.watch(OWNER, bookNameA, async () => {
        const booksB = t.stacks.book<BookEntry>(OWNER, bookNameB);
        await booksB.put({ id: 'derived', source: 'a' });
        throw new Error('cascade failed');
      }, { failOnError: true });

      const booksA = t.stacks.book<BookEntry>(OWNER, bookNameA);
      await assert.rejects(() => booksA.put({ id: 'a', name: 'Alice' }));

      const resultA = await booksA.get('a');
      const resultB = await t.stacks.book<BookEntry>(OWNER, bookNameB).get('derived');
      assert.strictEqual(resultA, null);
      assert.strictEqual(resultB, null);
    });

    it('2.12a Phase 2 handler writes are NOT atomic with the trigger', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);

      t.stacks.watch(OWNER, bookNameA, async (event) => {
        const booksB = t.stacks.book<BookEntry>(OWNER, bookNameB);
        await booksB.put({ id: 'derived', source: (event as any).entry?.id });
        throw new Error('phase 2 error');
      }, { failOnError: false });

      const booksA = t.stacks.book<BookEntry>(OWNER, bookNameA);
      await booksA.put({ id: 'a', name: 'Alice' });

      const resultA = await booksA.get('a');
      const resultB = await t.stacks.book<BookEntry>(OWNER, bookNameB).get('derived');
      assert.notStrictEqual(resultA, null);
      assert.notStrictEqual(resultB, null);
    });

    it('2.13 Cascade handler triggers recursive Phase 1 handlers', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      const bookNameC = 'booksc';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);
      t.ensureBook(OWNER, bookNameC);

      t.stacks.watch(OWNER, bookNameA, async () => {
        await t.stacks.book<BookEntry>(OWNER, bookNameB).put({ id: 'b1', from: 'a' });
      }, { failOnError: true });

      t.stacks.watch(OWNER, bookNameB, async () => {
        await t.stacks.book<BookEntry>(OWNER, bookNameC).put({ id: 'c1', from: 'b' });
      }, { failOnError: true });

      await t.stacks.book<BookEntry>(OWNER, bookNameA).put({ id: 'a1' });

      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameA).get('a1'), null);
      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameB).get('b1'), null);
      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameC).get('c1'), null);
    });

    it('2.13a Legitimate deep cascade succeeds within depth limit', async () => {
      const books = ['booksa', 'booksb', 'booksc', 'booksd', 'bookse'];
      for (const b of books) t.ensureBook(OWNER, b);

      for (let i = 0; i < books.length - 1; i++) {
        const src = books[i];
        const dst = books[i + 1];
        const dstId = `${dst[dst.length - 1]}1`;
        t.stacks.watch(OWNER, src, async () => {
          await t.stacks.book<BookEntry>(OWNER, dst).put({ id: dstId, from: src });
        }, { failOnError: true });
      }

      await t.stacks.book<BookEntry>(OWNER, books[0]).put({ id: 'a1' });

      for (const b of books) {
        const id = b === books[0] ? 'a1' : `${b[b.length - 1]}1`;
        assert.notStrictEqual(
          await t.stacks.book<BookEntry>(OWNER, b).get(id),
          null,
          `Document in ${b} should exist`,
        );
      }
    });

    it('2.14 Recursive cascade failure rolls back entire chain', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      const bookNameC = 'booksc';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);
      t.ensureBook(OWNER, bookNameC);

      t.stacks.watch(OWNER, bookNameA, async () => {
        await t.stacks.book<BookEntry>(OWNER, bookNameB).put({ id: 'b1', from: 'a' });
      }, { failOnError: true });

      t.stacks.watch(OWNER, bookNameB, async () => {
        await t.stacks.book<BookEntry>(OWNER, bookNameC).put({ id: 'c1', from: 'b' });
        throw new Error('deep cascade failed');
      }, { failOnError: true });

      await assert.rejects(
        () => t.stacks.book<BookEntry>(OWNER, bookNameA).put({ id: 'a1' }),
      );

      assert.strictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameA).get('a1'), null);
      assert.strictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameB).get('b1'), null);
      assert.strictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameC).get('c1'), null);
    });

    it('2.14a Cascade depth limiting prevents infinite recursion', async () => {
      seedDocument(t.backend, REF, { id: 'a', counter: 0 });

      t.stacks.watch(OWNER, BOOK, async (event) => {
        if (event.type !== 'delete') {
          const book = t.stacks.book<BookEntry>(OWNER, BOOK);
          await book.put({ ...event.entry, counter: ((event.entry as any).counter ?? 0) + 1 });
        }
      }, { failOnError: true });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await assert.rejects(
        () => book.put({ id: 'a', counter: 1 }),
        /cascade depth|Maximum cascade depth/,
      );

      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', counter: 0 });
    });

    it('2.14b Transaction context survives across await boundaries in Phase 1 handlers', async () => {
      const bookNameA = 'booksa';
      const bookNameB = 'booksb';
      const bookNameC = 'booksc';
      t.ensureBook(OWNER, bookNameA);
      t.ensureBook(OWNER, bookNameB);
      t.ensureBook(OWNER, bookNameC);

      t.stacks.watch(OWNER, bookNameA, async () => {
        const booksB = t.stacks.book<BookEntry>(OWNER, bookNameB);
        await booksB.put({ id: 'b1', from: 'a' });

        const readBack = await booksB.get('b1');
        assert.notStrictEqual(readBack, null, 'read-your-writes must work across awaits');

        const booksC = t.stacks.book<BookEntry>(OWNER, bookNameC);
        await booksC.put({ id: 'c1', from: 'a', confirmed: readBack!.id });
      }, { failOnError: true });

      await t.stacks.book<BookEntry>(OWNER, bookNameA).put({ id: 'a1' });

      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameA).get('a1'), null);
      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameB).get('b1'), null);
      const c1 = await t.stacks.book<BookEntry>(OWNER, bookNameC).get('c1');
      assert.notStrictEqual(c1, null);
      assert.strictEqual((c1 as any).confirmed, 'b1');
    });

    // ── Coalescing tests ──────────────────────────────────────────────

    it('2.15 Coalescing: create alone (inside explicit transaction)', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'create');
      if (events[0].type === 'create') {
        assert.deepStrictEqual(events[0].entry, { id: 'a', name: 'Alice' });
      }
    });

    it('2.16 Coalescing: create → update produces create with final state', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });
        await book.put({ id: 'a', name: 'Bob' });
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'create');
      if (events[0].type === 'create') {
        assert.strictEqual(events[0].entry.name, 'Bob');
      }
    });

    it('2.17 Coalescing: create → update → update produces create with final state', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', status: 'draft' });
        await book.put({ id: 'a', status: 'active' });
        await book.put({ id: 'a', status: 'completed' });
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'create');
      if (events[0].type === 'create') {
        assert.strictEqual(events[0].entry.status, 'completed');
      }
    });

    it('2.18 Coalescing: create → delete produces no event', async () => {
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });
        await book.delete('a');
      });

      assert.strictEqual(events.length, 0);
    });

    it('2.19 Coalescing: update (single) produces update with pre-transaction prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Bob' });
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'update');
      if (events[0].type === 'update') {
        assert.strictEqual(events[0].prev.name, 'Alice');
        assert.strictEqual(events[0].entry.name, 'Bob');
      }
    });

    it('2.20 Coalescing: update → update produces single update with pre-transaction prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Bob' });
        await book.put({ id: 'a', name: 'Charlie' });
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'update');
      if (events[0].type === 'update') {
        assert.strictEqual(events[0].prev.name, 'Alice');
        assert.strictEqual(events[0].entry.name, 'Charlie');
      }
    });

    it('2.21 Coalescing: update → delete produces delete with pre-transaction prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Bob' });
        await book.delete('a');
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'delete');
      if (events[0].type === 'delete') {
        assert.strictEqual(events[0].prev.name, 'Alice');
      }
    });

    it('2.22 Coalescing: delete (single, existing doc) produces delete with pre-transaction prev', async () => {
      seedDocument(t.backend, REF, { id: 'a', name: 'Alice' });
      const events = collectEvents(t.stacks, OWNER, BOOK, { failOnError: false });

      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.delete('a');
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'delete');
      if (events[0].type === 'delete') {
        assert.strictEqual(events[0].prev.name, 'Alice');
      }
    });
  });
}
