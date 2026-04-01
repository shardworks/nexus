/**
 * Tier 2.5 — Transaction Semantics conformance tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StacksBackend } from '../backend.ts';
import type { BookEntry } from '../types.ts';
import { createTestStacks, OWNER, BOOK, type TestStacks } from './helpers.ts';

export function tier25Transactions(backendFactory: () => StacksBackend): void {
  describe('Tier 2.5 — Transaction Semantics', () => {
    let t: TestStacks;

    beforeEach(() => {
      t = createTestStacks(backendFactory);
      t.ensureBook(OWNER, BOOK);
    });

    afterEach(() => {
      t.backend.close();
    });

    it('2.23 Explicit transaction: all writes are atomic', async () => {
      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });
        await book.put({ id: 'b', name: 'Bob' });
        await book.put({ id: 'c', name: 'Charlie' });
      });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      assert.notStrictEqual(await book.get('a'), null);
      assert.notStrictEqual(await book.get('b'), null);
      assert.notStrictEqual(await book.get('c'), null);
    });

    it('2.24 Explicit transaction: error rolls back all writes', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);

      await assert.rejects(async () => {
        await t.stacks.transaction(async (tx) => {
          const txBook = tx.book<BookEntry>(OWNER, BOOK);
          await txBook.put({ id: 'a', name: 'Alice' });
          await txBook.put({ id: 'b', name: 'Bob' });
          throw new Error('abort');
        });
      });

      assert.strictEqual(await book.get('a'), null);
      assert.strictEqual(await book.get('b'), null);
    });

    it('2.25 Read-your-writes inside a transaction', async () => {
      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });

        const result = await book.get('a');
        assert.deepStrictEqual(result, { id: 'a', name: 'Alice' });

        const found = await book.find({ where: [['name', '=', 'Alice']] });
        assert.strictEqual(found.length, 1);

        const count = await book.count([['name', '=', 'Alice']]);
        assert.strictEqual(count, 1);
      });
    });

    it('2.25a OR queries see uncommitted writes inside a transaction', async () => {
      await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', status: 'active', role: 'admin' });
        await book.put({ id: 'b', status: 'draft', role: 'user' });

        const found = await book.find({
          where: { or: [
            [['status', '=', 'active']],
            [['role', '=', 'user']],
          ] },
        });
        assert.strictEqual(found.length, 2);

        const n = await book.count({ or: [
            [['status', '=', 'active']],
            [['role', '=', 'user']],
        ] });
        assert.strictEqual(n, 2);
      });
    });

    it('2.27 Implicit transaction spans write + Phase 1 handlers', async () => {
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

      assert.notStrictEqual(await booksA.get('a'), null);
      assert.notStrictEqual(await t.stacks.book<BookEntry>(OWNER, bookNameB).get('derived'), null);
    });

    it('2.28 Nested explicit transactions are flattened into the outer transaction', async () => {
      await t.stacks.transaction(async (outerTx) => {
        const outerBook = outerTx.book<BookEntry>(OWNER, BOOK);
        await outerBook.put({ id: 'a', name: 'Alice' });

        // Nested transaction — should be flattened
        await t.stacks.transaction(async (innerTx) => {
          const innerBook = innerTx.book<BookEntry>(OWNER, BOOK);
          await innerBook.put({ id: 'b', name: 'Bob' });
        });

        // Both writes should be visible inside the outer transaction
        assert.notStrictEqual(await outerBook.get('a'), null);
        assert.notStrictEqual(await outerBook.get('b'), null);
      });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      assert.notStrictEqual(await book.get('a'), null);
      assert.notStrictEqual(await book.get('b'), null);
    });

    it('2.29 Transaction return value is propagated', async () => {
      const result = await t.stacks.transaction(async (tx) => {
        const book = tx.book<BookEntry>(OWNER, BOOK);
        await book.put({ id: 'a', name: 'Alice' });
        return 42;
      });

      assert.strictEqual(result, 42);
    });
  });
}
