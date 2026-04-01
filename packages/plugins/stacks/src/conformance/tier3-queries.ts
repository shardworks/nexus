/**
 * Tier 3 — Query Correctness conformance tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StacksBackend } from '../backend.ts';
import type { BookEntry } from '../types.ts';
import { createTestStacks, OWNER, BOOK, type TestStacks } from './helpers.ts';

export function tier3Queries(backendFactory: () => StacksBackend): void {
  describe('Tier 3 — Query Correctness', () => {
    let t: TestStacks;

    beforeEach(() => {
      t = createTestStacks(backendFactory);
      t.ensureBook(OWNER, BOOK);
    });

    afterEach(() => {
      t.backend.close();
    });

    it('3.1 Equality filter', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });
      await book.put({ id: 'b', status: 'cancelled' });

      const results = await book.find({ where: [['status', '=', 'active']] });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'a');
    });

    it('3.2 Inequality filter', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });
      await book.put({ id: 'b', status: 'cancelled' });

      const results = await book.find({ where: [['status', '!=', 'active']] });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'b');
    });

    it('3.3 Range operators with numbers', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', score: 10 });
      await book.put({ id: 'b', score: 20 });
      await book.put({ id: 'c', score: 30 });

      const gt15 = await book.find({ where: [['score', '>', 15]] });
      assert.strictEqual(gt15.length, 2);
      assert.deepStrictEqual(gt15.map(d => d.id).sort(), ['b', 'c']);

      const gte20 = await book.find({ where: [['score', '>=', 20]] });
      assert.strictEqual(gte20.length, 2);
      assert.deepStrictEqual(gte20.map(d => d.id).sort(), ['b', 'c']);

      const lt20 = await book.find({ where: [['score', '<', 20]] });
      assert.strictEqual(lt20.length, 1);
      assert.strictEqual(lt20[0].id, 'a');

      const lte20 = await book.find({ where: [['score', '<=', 20]] });
      assert.strictEqual(lte20.length, 2);
      assert.deepStrictEqual(lte20.map(d => d.id).sort(), ['a', 'b']);
    });

    it('3.4 Range operators with strings (lexicographic)', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Bob' });
      await book.put({ id: 'c', name: 'Charlie' });

      const gtBob = await book.find({ where: [['name', '>', 'Bob']] });
      assert.strictEqual(gtBob.length, 1);
      assert.strictEqual(gtBob[0].name, 'Charlie');

      const gteBob = await book.find({ where: [['name', '>=', 'Bob']] });
      assert.strictEqual(gteBob.length, 2);
      const names = gteBob.map(d => d.name).sort();
      assert.deepStrictEqual(names, ['Bob', 'Charlie']);
    });

    it('3.5 LIKE operator', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Alison' });
      await book.put({ id: 'c', name: 'Bob' });

      const aliPercent = await book.find({ where: [['name', 'LIKE', 'Ali%']] });
      assert.strictEqual(aliPercent.length, 2);
      assert.deepStrictEqual(aliPercent.map(d => d.id).sort(), ['a', 'b']);

      const underscore = await book.find({ where: [['name', 'LIKE', '_ob']] });
      assert.strictEqual(underscore.length, 1);
      assert.strictEqual(underscore[0].id, 'c');
    });

    it('3.6 IN operator', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });
      await book.put({ id: 'b', status: 'draft' });
      await book.put({ id: 'c', status: 'cancelled' });

      const results = await book.find({ where: [['status', 'IN', ['active', 'cancelled']]] });
      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results.map(d => d.id).sort(), ['a', 'c']);
    });

    it('3.7 Empty IN list returns no results', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });

      const results = await book.find({ where: [['status', 'IN', []]] });
      assert.strictEqual(results.length, 0);
    });

    it('3.8 IS NULL / IS NOT NULL', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', label: null });
      await book.put({ id: 'b', label: 'tagged' });

      const nullResults = await book.find({ where: [['label', 'IS NULL']] });
      assert.strictEqual(nullResults.length, 1);
      assert.strictEqual(nullResults[0].id, 'a');

      const notNullResults = await book.find({ where: [['label', 'IS NOT NULL']] });
      assert.strictEqual(notNullResults.length, 1);
      assert.strictEqual(notNullResults[0].id, 'b');
    });

    it('3.9 IS NULL for missing fields', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' }); // no 'label' field

      const results = await book.find({ where: [['label', 'IS NULL']] });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'a');
    });

    it('3.9a IS NOT NULL excludes documents with absent fields', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });       // no 'label'
      await book.put({ id: 'b', label: 'tagged' });
      await book.put({ id: 'c', label: null });

      const results = await book.find({ where: [['label', 'IS NOT NULL']] });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'b');
    });

    it('3.10 Multiple conditions are AND-ed', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', score: 30 });
      await book.put({ id: 'b', status: 'active', score: 10 });
      await book.put({ id: 'c', status: 'draft', score: 30 });

      const results = await book.find({
        where: [['status', '=', 'active'], ['score', '>', 20]],
      });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'a');
    });

    it('3.11 Dot-notation for nested fields', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', parent: { id: 'p1' } });
      await book.put({ id: 'b', parent: { id: 'p2' } });

      const results = await book.find({ where: [['parent.id', '=', 'p1']] });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'a');
    });

    // ── OR query tests ──────────────────────────────────────────────

    it('3.12 OR with non-overlapping branches returns the union', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', role: 'admin' });
      await book.put({ id: 'b', status: 'draft', role: 'user' });
      await book.put({ id: 'c', status: 'cancelled', role: 'admin' });

      const results = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [['status', '=', 'cancelled']],
        ] },
      });
      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results.map(d => d.id).sort(), ['a', 'c']);
    });

    it('3.13 OR with overlapping branches deduplicates by id', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', role: 'admin' });
      await book.put({ id: 'b', status: 'draft', role: 'admin' });
      await book.put({ id: 'c', status: 'active', role: 'user' });

      const results = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [['role', '=', 'admin']],
        ] },
      });
      assert.strictEqual(results.length, 3);
      assert.deepStrictEqual(results.map(d => d.id).sort(), ['a', 'b', 'c']);
    });

    it('3.14 OR results respect orderBy and pagination', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', score: 30 });
      await book.put({ id: 'b', status: 'draft', score: 10 });
      await book.put({ id: 'c', status: 'active', score: 20 });
      await book.put({ id: 'd', status: 'draft', score: 40 });

      const results = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [['status', '=', 'draft']],
        ] },
        orderBy: ['score', 'asc'],
        limit: 2,
        offset: 1,
      });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].id, 'c'); // score 20
      assert.strictEqual(results[1].id, 'a'); // score 30
    });

    it('3.15 OR with empty branches array returns no results', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });

      const results = await book.find({ where: { or: [] } });
      assert.strictEqual(results.length, 0);
    });

    it('3.16 OR with one empty branch matches all documents', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });
      await book.put({ id: 'b', status: 'draft' });
      await book.put({ id: 'c', status: 'cancelled' });

      const results = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [],
        ] },
      });
      assert.strictEqual(results.length, 3);
    });

    it('3.17 count() with OR predicate returns deduplicated count', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', role: 'admin' });
      await book.put({ id: 'b', status: 'draft', role: 'admin' });
      await book.put({ id: 'c', status: 'active', role: 'user' });

      const n = await book.count({ or: [
        [['status', '=', 'active']],
        [['role', '=', 'admin']],
      ] });
      assert.strictEqual(n, 3);
    });

    it('3.17a OR with dot-notation and range operators', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', parent: { id: 'p1' }, score: 10 });
      await book.put({ id: 'b', parent: { id: 'p2' }, score: 50 });
      await book.put({ id: 'c', parent: { id: 'p1' }, score: 90 });

      const results = await book.find({
        where: { or: [
          [['parent.id', '=', 'p2']],
          [['score', '>', 80]],
        ] },
      });
      assert.strictEqual(results.length, 2);
      assert.deepStrictEqual(results.map(d => d.id).sort(), ['b', 'c']);
    });

    it('3.17b OR with orderBy on a field absent from some documents', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', score: 30 });
      await book.put({ id: 'b', status: 'draft' }); // no 'score' field
      await book.put({ id: 'c', status: 'active', score: 10 });

      const results = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [['status', '=', 'draft']],
        ] },
        orderBy: ['score', 'asc'],
      });

      // All three should be returned
      assert.strictEqual(results.length, 3);

      // Run the same query again — order must be deterministic
      const results2 = await book.find({
        where: { or: [
          [['status', '=', 'active']],
          [['status', '=', 'draft']],
        ] },
        orderBy: ['score', 'asc'],
      });

      assert.deepStrictEqual(
        results.map(d => d.id),
        results2.map(d => d.id),
      );
    });

    // ── Sort and pagination ─────────────────────────────────────────

    it('3.18 Sort ascending and descending', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', score: 30 });
      await book.put({ id: 'b', score: 10 });
      await book.put({ id: 'c', score: 20 });

      const asc = await book.find({ orderBy: ['score', 'asc'] });
      assert.deepStrictEqual(asc.map(d => d.id), ['b', 'c', 'a']);

      const desc = await book.find({ orderBy: ['score', 'desc'] });
      assert.deepStrictEqual(desc.map(d => d.id), ['a', 'c', 'b']);
    });

    it('3.19 Multi-field sort', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active', score: 20 });
      await book.put({ id: 'b', status: 'active', score: 10 });
      await book.put({ id: 'c', status: 'draft', score: 30 });

      const results = await book.find({
        orderBy: [['status', 'asc'], ['score', 'desc']],
      });
      assert.deepStrictEqual(results.map(d => d.id), ['a', 'b', 'c']);
    });

    it('3.20 Pagination: limit', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      for (let i = 0; i < 5; i++) {
        await book.put({ id: `doc-${i}`, value: i });
      }

      const results = await book.find({ limit: 2 });
      assert.strictEqual(results.length, 2);
    });

    it('3.21 Pagination: limit + offset', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', score: 10 });
      await book.put({ id: 'b', score: 20 });
      await book.put({ id: 'c', score: 30 });

      const results = await book.find({
        orderBy: ['score', 'asc'],
        limit: 2,
        offset: 1,
      });
      assert.deepStrictEqual(results.map(d => d.id), ['b', 'c']);
    });

    it('3.22 Count without predicate', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Bob' });
      await book.put({ id: 'c', name: 'Charlie' });

      const n = await book.count();
      assert.strictEqual(n, 3);
    });

    it('3.23 Count with predicate', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', status: 'active' });
      await book.put({ id: 'b', status: 'draft' });
      await book.put({ id: 'c', status: 'active' });

      const n = await book.count([['status', '=', 'active']]);
      assert.strictEqual(n, 2);
    });

    it('3.24 List returns all documents', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Bob' });
      await book.put({ id: 'c', name: 'Charlie' });

      const results = await book.list();
      assert.strictEqual(results.length, 3);
    });

    it('3.25 List respects orderBy and pagination', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);
      await book.put({ id: 'c', name: 'Charlie' });
      await book.put({ id: 'a', name: 'Alice' });
      await book.put({ id: 'b', name: 'Bob' });

      const results = await book.list({ orderBy: ['id', 'asc'], limit: 2 });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].id, 'a');
      assert.strictEqual(results[1].id, 'b');
    });

    it('3.26 Field name validation rejects dangerous input', async () => {
      const book = t.stacks.book<BookEntry>(OWNER, BOOK);

      await assert.rejects(
        () => book.find({ where: [['status; DROP TABLE--', '=', 'x']] }),
        /Unsafe field name/,
      );

      await assert.rejects(
        () => book.find({ where: [['name"', '=', 'x']] }),
        /Unsafe field name/,
      );

      // Valid field names should not throw
      await book.find({ where: [['valid.field', '=', 'x']] });
      await book.find({ where: [['under_score', '=', 'x']] });
    });
  });
}
