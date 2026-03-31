import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteAdapter, booksPath } from './sqlite-adapter.ts';

// ── booksPath ──────────────────────────────────────────────────────────

describe('booksPath', () => {
  it('returns .nexus/nexus.db under the guild root', () => {
    assert.equal(booksPath('/home/guild'), '/home/guild/.nexus/nexus.db');
    assert.equal(booksPath('/var/my-guild'), '/var/my-guild/.nexus/nexus.db');
  });
});

// ── SqliteAdapter ──────────────────────────────────────────────────────

describe('SqliteAdapter', () => {
  it('SELECT returns rows and column names', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (a TEXT, b INTEGER)');
    await db.execute('INSERT INTO t VALUES (?, ?)', ['hello', 42]);

    const result = await db.execute('SELECT a, b FROM t');

    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0], { a: 'hello', b: 42 });
    assert.deepEqual(result.columns, ['a', 'b']);
    assert.equal(result.rowsAffected, 0);
    assert.equal(result.lastInsertRowid, undefined);
  });

  it('SELECT with no matches returns empty rows', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (id TEXT)');

    const result = await db.execute('SELECT id FROM t');

    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.columns, ['id']);
  });

  it('INSERT returns rowsAffected and lastInsertRowid', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');

    const result = await db.execute('INSERT INTO t (val) VALUES (?)', ['x']);

    assert.equal(result.rows.length, 0);
    assert.deepEqual(result.columns, []);
    assert.equal(result.rowsAffected, 1);
    assert.equal(result.lastInsertRowid, 1n);
  });

  it('UPDATE returns rowsAffected', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (id TEXT PRIMARY KEY, val TEXT)');
    await db.execute('INSERT INTO t VALUES (?, ?)', ['a', 'old']);
    await db.execute('INSERT INTO t VALUES (?, ?)', ['b', 'old']);

    const result = await db.execute('UPDATE t SET val = ? WHERE val = ?', ['new', 'old']);

    assert.equal(result.rowsAffected, 2);
    // SQLite carries the last INSERT rowid on the connection — not meaningful
    // for UPDATE, but always a bigint (never undefined).
    assert.equal(typeof result.lastInsertRowid, 'bigint');
  });

  it('DELETE returns rowsAffected', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
    await db.execute('INSERT INTO t VALUES (?)', ['a']);
    await db.execute('INSERT INTO t VALUES (?)', ['b']);

    const result = await db.execute('DELETE FROM t WHERE id = ?', ['a']);

    assert.equal(result.rowsAffected, 1);
  });

  it('executes a statement with no args', async () => {
    const db = new SqliteAdapter(':memory:');
    await db.execute('CREATE TABLE t (id TEXT)');

    const result = await db.execute('SELECT id FROM t');
    assert.equal(result.rows.length, 0);
  });

  it('returns a Promise', async () => {
    const db = new SqliteAdapter(':memory:');
    const result = db.execute('SELECT 1 AS n');
    assert.ok(result instanceof Promise);
    const resolved = await result;
    assert.equal(resolved.rows[0]?.n, 1);
  });
});
