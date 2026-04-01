/**
 * Tier 4 — Edge Cases and Ergonomics conformance tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StacksBackend } from '../backend.ts';
import type { BookEntry } from '../types.ts';
import { createTestStacks, OWNER, BOOK, REF, type TestStacks } from './helpers.ts';

export function tier4EdgeCases(backendFactory: () => StacksBackend): void {
  describe('Tier 4 — Edge Cases and Ergonomics', () => {
    let t: TestStacks;

    beforeEach(() => {
      t = createTestStacks(backendFactory);
      t.ensureBook(OWNER, BOOK);
    });

    afterEach(() => {
      t.backend.close();
    });

    it('4.1 Cross-plugin read isolation', async () => {
      const writeHandle = t.stacks.book<BookEntry>(OWNER, BOOK);
      const readHandle = t.stacks.readBook<BookEntry>(OWNER, BOOK);

      await writeHandle.put({ id: 'a', title: 'test' });
      const result = await readHandle.get('a');
      assert.deepStrictEqual(result, { id: 'a', title: 'test' });

      // Read handle must NOT expose write methods
      assert.strictEqual((readHandle as any).put, undefined);
      assert.strictEqual((readHandle as any).patch, undefined);
      assert.strictEqual((readHandle as any).delete, undefined);
    });

    it('4.2 Books are isolated by owner + name', async () => {
      const ownerA = 'plugin-a';
      const ownerB = 'plugin-b';
      const bookName = 'items';
      t.ensureBook(ownerA, bookName);
      t.ensureBook(ownerB, bookName);

      const bookA = t.stacks.book<BookEntry>(ownerA, bookName);
      const bookB = t.stacks.book<BookEntry>(ownerB, bookName);

      await bookA.put({ id: 'x', name: 'A-item' });
      await bookB.put({ id: 'x', name: 'B-item' });

      const resultA = await bookA.get('x');
      const resultB = await bookB.get('x');
      assert.deepStrictEqual(resultA, { id: 'x', name: 'A-item' });
      assert.deepStrictEqual(resultB, { id: 'x', name: 'B-item' });
    });

    it('4.3 Watch registration after writes throws', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });

      assert.throws(
        () => t.stacks.watch(OWNER, BOOK, () => {}),
        /watch.*after.*writes|locked/i,
      );
    });

    it('4.4 Large document round-trip', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);

      // Generate a large nested structure (~100KB)
      const data: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        data[`key${i}`] = {
          nested: Array.from({ length: 100 }, (_, j) => ({
            index: j,
            value: `item-${i}-${j}`,
          })),
        };
      }

      const doc = { id: 'big', data };
      await book.put(doc);
      const result = await book.get('big');
      assert.deepStrictEqual(result, doc);
    });

    it('4.5 Special characters in string values', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      const doc = {
        id: 'a',
        name: "O'Brien",
        note: 'Line1\nLine2',
        data: '{"json":"in a string"}',
      };
      await book.put(doc);
      const result = await book.get('a');
      assert.deepStrictEqual(result, doc);
    });

    it('4.6 Boolean and numeric type fidelity in queries', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', active: true, count: 0 });
      await book.put({ id: 'b', active: false, count: 1 });

      const trueResults = await book.find({ where: [['active', '=', true]] });
      assert.strictEqual(trueResults.length, 1);
      assert.strictEqual(trueResults[0].id, 'a');

      const falseResults = await book.find({ where: [['active', '=', false]] });
      assert.strictEqual(falseResults.length, 1);
      assert.strictEqual(falseResults[0].id, 'b');

      const zeroResults = await book.find({ where: [['count', '=', 0]] });
      assert.strictEqual(zeroResults.length, 1);
      assert.strictEqual(zeroResults[0].id, 'a');
    });

    it('4.8 Empty book operations', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);

      const getResult = await book.get('nonexistent');
      assert.strictEqual(getResult, null);

      const findResult = await book.find({ where: [['status', '=', 'active']] });
      assert.deepStrictEqual(findResult, []);

      const listResult = await book.list();
      assert.deepStrictEqual(listResult, []);

      const countResult = await book.count();
      assert.strictEqual(countResult, 0);
    });

    it('4.9 Index creation is additive', async () => {
      t.backend.ensureBook(REF, { indexes: ['status'] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', createdAt: '2025-01-01' });

      t.backend.ensureBook(REF, { indexes: ['status', 'createdAt'] });

      // Original data must still be there
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', status: 'active', createdAt: '2025-01-01' });

      // Both index queries should work
      const byStatus = await book.find({ where: [['status', '=', 'active']] });
      assert.strictEqual(byStatus.length, 1);
    });

    it('4.9a ensureBook is idempotent', async () => {
      t.backend.ensureBook(REF, { indexes: ['status', 'createdAt'] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', createdAt: '2025-01-01' });

      // Same schema again — should be a no-op
      t.backend.ensureBook(REF, { indexes: ['status', 'createdAt'] });

      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', status: 'active', createdAt: '2025-01-01' });
    });

    it('4.9b Compound index declaration', async () => {
      t.backend.ensureBook(REF, { indexes: [['status', 'createdAt']] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', createdAt: '2025-01-01' });
      await book.put({ id: 'b', status: 'draft', createdAt: '2025-01-02' });
      await book.put({ id: 'c', status: 'active', createdAt: '2025-01-03' });

      const results = await book.find({
        where: [['status', '=', 'active']],
        orderBy: ['createdAt', 'asc'],
      });
      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results.map(d => d.id), ['a', 'c']);
    });

    it('4.9c Compound and single-field indexes coexist', async () => {
      t.backend.ensureBook(REF, { indexes: ['status', ['status', 'createdAt']] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', createdAt: '2025-01-01' });
      await book.put({ id: 'b', status: 'draft', createdAt: '2025-01-02' });

      const single = await book.find({ where: [['status', '=', 'active']] });
      assert.strictEqual(single.length, 1);
      assert.strictEqual(single[0].id, 'a');

      const compound = await book.find({
        where: [['status', '=', 'active']],
        orderBy: ['createdAt', 'asc'],
      });
      assert.strictEqual(compound.length, 1);
      assert.strictEqual(compound[0].id, 'a');
    });

    it('4.9d Additive compound indexes preserve data', async () => {
      t.backend.ensureBook(REF, { indexes: ['status'] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', createdAt: '2025-01-01' });

      t.backend.ensureBook(REF, { indexes: ['status', ['status', 'createdAt']] });

      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', status: 'active', createdAt: '2025-01-01' });

      const queryResult = await book.find({
        where: [['status', '=', 'active']],
        orderBy: ['createdAt', 'asc'],
      });
      assert.strictEqual(queryResult.length, 1);
    });

    it('4.9e Compound index with dot-notation fields', async () => {
      t.backend.ensureBook(REF, { indexes: [['status', 'parent.id']] });

      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', parent: { id: 'p1' } });
      await book.put({ id: 'b', status: 'active', parent: { id: 'p2' } });
      await book.put({ id: 'c', status: 'draft', parent: { id: 'p1' } });

      const results = await book.find({
        where: [['status', '=', 'active'], ['parent.id', '=', 'p1']],
      });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'a');
    });

    it('4.11 Result ordering without orderBy is stable', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'c', name: 'Charlie' });
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Bob' });

      const result1 = await book.find({ where: [['name', 'IS NOT NULL']] });
      const result2 = await book.find({ where: [['name', 'IS NOT NULL']] });
      assert.deepStrictEqual(
        result1.map(d => d.id),
        result2.map(d => d.id),
      );
    });
  });
}
