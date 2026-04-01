/**
 * Tier 1 — Data Integrity conformance tests.
 *
 * Failures here mean data loss or corruption. Non-negotiable.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StacksBackend } from '../backend.ts';
import type { BookEntry } from '../types.ts';
import { createTestStacks, OWNER, BOOK, type TestStacks } from './helpers.ts';

export function tier1DataIntegrity(backendFactory: () => StacksBackend): void {
  describe('Tier 1 — Data Integrity', () => {
    let t: TestStacks;

    beforeEach(() => {
      t = createTestStacks(backendFactory);
      t.ensureBook(OWNER, BOOK);
    });

    afterEach(() => {
      t.backend.close();
    });

    it('1.1 Basic CRUD round-trip', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice' });
    });

    it('1.2 Put is full-replace, not merge', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice', role: 'admin' });
      await book.put({ id: 'a', name: 'Alice' });
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice' });
      assert.strictEqual((result as any).role, undefined);
    });

    it('1.3 Document field type preservation', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', count: 0, flag: false, label: '', items: null });
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', count: 0, flag: false, label: '', items: null });
    });

    it('1.4 Nested object preservation', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      const doc = { id: 'a', meta: { tags: ['x', 'y'], nested: { deep: true } } };
      await book.put(doc);
      const result = await book.get('a');
      assert.deepStrictEqual(result, doc);
    });

    it('1.5 Delete removes the document', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.delete('a');
      const result = await book.get('a');
      assert.strictEqual(result, null);
    });

    it('1.6 Delete is idempotent', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      // Should not throw
      await book.delete('nonexistent-id');
    });

    it('1.7 Patch applies top-level fields only', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice', role: 'admin', score: 10 });
      await book.patch('a', { score: 20 });
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice', role: 'admin', score: 20 });
    });

    it('1.8 Patch throws on missing document', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await assert.rejects(
        () => book.patch('nonexistent', { name: 'Bob' }),
        /not found/,
      );
    });

    it('1.9 Patch returns the updated document', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice', score: 10 });
      const result = await book.patch('a', { score: 20 });
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice', score: 20 });
    });

    it('1.10 Put with identical document is a no-op write (but still valid)', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'a', name: 'Alice' });
      const result = await book.get('a');
      assert.deepStrictEqual(result, { id: 'a', name: 'Alice' });
    });

    it('1.11 Patch with id in fields does not change document identity', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.patch('a', { id: 'b', name: 'Bob' } as any);
      const resultA = await book.get('a');
      const resultB = await book.get('b');
      assert.deepStrictEqual(resultA, { id: 'a', name: 'Bob' });
      assert.strictEqual(resultB, null);
    });
  });
}
