import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteAdapter } from './sqlite-adapter.ts';
import { BookStore, booksTableName } from './book-store.ts';

// ── Helpers ────────────────────────────────────────────────────────────

async function makeStore<T extends { id: string }>(
  db: SqliteAdapter,
  table: string,
): Promise<BookStore<T>> {
  await db.execute(
    `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, content TEXT NOT NULL)`,
  );
  return new BookStore<T>(db, table);
}

// ── booksTableName ─────────────────────────────────────────────────────

describe('booksTableName', () => {
  it('leaves clean alphanumeric rig keys unchanged', () => {
    assert.equal(booksTableName('ledger', 'writs'), 'books_ledger_writs');
  });

  it('normalizes hyphens in rig key to underscores', () => {
    assert.equal(booksTableName('nexus-ledger', 'writs'), 'books_nexus_ledger_writs');
  });

  it('normalizes slash in rig key to double underscore', () => {
    assert.equal(booksTableName('acme/my-rig', 'data'), 'books_acme__my_rig_data');
  });

  it('normalizes dots in rig key to underscores', () => {
    assert.equal(booksTableName('my.rig', 'items'), 'books_my_rig_items');
  });

  it('distinguishes scope separator from hyphen', () => {
    // 'acme/my-rig' → 'acme__my_rig'; 'acme-my-rig' → 'acme_my_rig'
    const scoped = booksTableName('acme/my-rig', 'data');
    const flat   = booksTableName('acme-my-rig', 'data');
    assert.notEqual(scoped, flat);
    assert.equal(scoped, 'books_acme__my_rig_data');
    assert.equal(flat,   'books_acme_my_rig_data');
  });

  it('accepts book names with hyphens', () => {
    assert.equal(booksTableName('my-rig', 'my-book'), 'books_my_rig_my-book');
  });

  it('throws on book name with a space', () => {
    assert.throws(() => booksTableName('my-rig', 'bad name'), /unsafe book name/);
  });

  it('throws on book name with a slash', () => {
    assert.throws(() => booksTableName('my-rig', 'bad/name'), /unsafe book name/);
  });

  it('throws on book name with a double-quote', () => {
    assert.throws(() => booksTableName('my-rig', 'bad"name'), /unsafe book name/);
  });
});

// ── BookStore ──────────────────────────────────────────────────────────

type Widget = { id: string; name: string; status: string; score: number };

describe('BookStore', () => {
  let db: SqliteAdapter;
  let store: BookStore<Widget>;

  beforeEach(async () => {
    db = new SqliteAdapter(':memory:');
    store = await makeStore<Widget>(db, 'widgets');
  });

  // ── put / get ────────────────────────────────────────────────────────

  describe('put / get', () => {
    it('stores and retrieves a document by id', async () => {
      const w: Widget = { id: 'w1', name: 'Sprocket', status: 'active', score: 10 };
      await store.put(w);
      assert.deepEqual(await store.get('w1'), w);
    });

    it('returns null for an unknown id', async () => {
      assert.equal(await store.get('missing'), null);
    });

    it('upserts — second put replaces the first', async () => {
      await store.put({ id: 'w1', name: 'Old', status: 'active', score: 1 });
      await store.put({ id: 'w1', name: 'New', status: 'active', score: 99 });
      const result = await store.get('w1');
      assert.equal(result?.name, 'New');
      assert.equal(result?.score, 99);
    });
  });

  // ── delete ───────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a document', async () => {
      await store.put({ id: 'w1', name: 'X', status: 'active', score: 0 });
      await store.delete('w1');
      assert.equal(await store.get('w1'), null);
    });

    it('is a no-op for a missing id', async () => {
      await assert.doesNotReject(() => store.delete('nope'));
    });
  });

  // ── find ─────────────────────────────────────────────────────────────

  describe('find', () => {
    beforeEach(async () => {
      await store.put({ id: 'a', name: 'Alpha', status: 'active',   score: 3 });
      await store.put({ id: 'b', name: 'Beta',  status: 'inactive', score: 1 });
      await store.put({ id: 'c', name: 'Gamma', status: 'active',   score: 2 });
    });

    it('returns all documents when no query is given', async () => {
      const results = await store.find({});
      assert.equal(results.length, 3);
    });

    it('filters by a single where condition', async () => {
      const results = await store.find({ where: { status: 'active' } });
      assert.equal(results.length, 2);
      assert.ok(results.every((w) => w.status === 'active'));
    });

    it('filters by multiple where conditions (AND)', async () => {
      const results = await store.find({ where: { status: 'active', score: 3 } });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, 'a');
    });

    it('returns empty array when no documents match', async () => {
      const results = await store.find({ where: { status: 'deleted' } });
      assert.equal(results.length, 0);
    });

    it('orders ascending by field', async () => {
      const results = await store.find({ orderBy: 'score', order: 'asc' });
      assert.deepEqual(results.map((w) => w.id), ['b', 'c', 'a']);
    });

    it('orders descending by field', async () => {
      const results = await store.find({ orderBy: 'score', order: 'desc' });
      assert.deepEqual(results.map((w) => w.id), ['a', 'c', 'b']);
    });

    it('defaults to ascending order when order is omitted', async () => {
      const results = await store.find({ orderBy: 'score' });
      assert.deepEqual(results.map((w) => w.id), ['b', 'c', 'a']);
    });

    it('respects limit', async () => {
      const results = await store.find({ orderBy: 'score', order: 'asc', limit: 2 });
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((w) => w.id), ['b', 'c']);
    });

    it('respects offset', async () => {
      const results = await store.find({ orderBy: 'score', order: 'asc', limit: 100, offset: 1 });
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((w) => w.id), ['c', 'a']);
    });

    it('respects limit and offset together', async () => {
      const results = await store.find({ orderBy: 'score', order: 'asc', limit: 1, offset: 1 });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, 'c');
    });

    it('throws on an unsafe field name in where (injection guard)', async () => {
      await assert.rejects(
        () => store.find({ where: { "bad'field": 'x' } }),
        /unsafe field name/,
      );
    });

    it('throws on an unsafe orderBy value (injection guard)', async () => {
      await assert.rejects(
        () => store.find({ orderBy: "score; DROP TABLE widgets--" }),
        /unsafe field name/,
      );
    });
  });

  // ── list ─────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all documents', async () => {
      await store.put({ id: 'x', name: 'X', status: 'active', score: 0 });
      await store.put({ id: 'y', name: 'Y', status: 'active', score: 0 });
      const results = await store.list();
      assert.equal(results.length, 2);
    });

    it('returns empty array for an empty store', async () => {
      assert.deepEqual(await store.list(), []);
    });
  });

  // ── count ────────────────────────────────────────────────────────────

  describe('count', () => {
    beforeEach(async () => {
      await store.put({ id: 'a', name: 'A', status: 'active',   score: 1 });
      await store.put({ id: 'b', name: 'B', status: 'inactive', score: 2 });
    });

    it('counts all documents when no filter is given', async () => {
      assert.equal(await store.count(), 2);
    });

    it('counts documents matching a where filter', async () => {
      assert.equal(await store.count({ status: 'active' }), 1);
    });

    it('returns 0 for an empty store', async () => {
      const empty = await makeStore<Widget>(db, 'empty_widgets');
      assert.equal(await empty.count(), 0);
    });
  });
});
