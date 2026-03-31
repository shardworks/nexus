import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteAdapter } from './sqlite-adapter.ts';
import { reconcileBooks } from './reconcile-books.ts';
import type { LoadedRig } from '../arbor.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeDb(): SqliteAdapter {
  return new SqliteAdapter(':memory:');
}

function makeRig(
  id: string,
  books: Record<string, { indexes?: string[] }> = {},
): LoadedRig {
  return {
    packageName: `@test/${id}`,
    id,
    version: '0.0.0',
    instance: { books },
    tools: [],
  };
}

async function tableExists(db: SqliteAdapter, name: string): Promise<boolean> {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return result.rows.length > 0;
}

async function indexExists(db: SqliteAdapter, name: string): Promise<boolean> {
  const result = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    [name],
  );
  return result.rows.length > 0;
}

// ── reconcileBooks ─────────────────────────────────────────────────────

describe('reconcileBooks', () => {
  it('creates a table for each declared book', async () => {
    const db = makeDb();
    await reconcileBooks(db, [makeRig('nexus-ledger', { writs: {} })]);
    assert.ok(await tableExists(db, 'books_nexus_ledger_writs'));
  });

  it('creates an index for each declared field', async () => {
    const db = makeDb();
    await reconcileBooks(db, [
      makeRig('nexus-ledger', { writs: { indexes: ['status', 'createdAt'] } }),
    ]);
    assert.ok(await indexExists(db, 'idx_books_nexus_ledger_writs_status'));
    assert.ok(await indexExists(db, 'idx_books_nexus_ledger_writs_createdAt'));
  });

  it('creates an index for a dot-notation nested field', async () => {
    const db = makeDb();
    await reconcileBooks(db, [
      makeRig('nexus-ledger', { writs: { indexes: ['parent.id'] } }),
    ]);
    assert.ok(await indexExists(db, 'idx_books_nexus_ledger_writs_parent_id'));
  });

  it('is idempotent — safe to call twice with the same rigs', async () => {
    const db = makeDb();
    const rig = makeRig('nexus-ledger', { writs: { indexes: ['status'] } });
    await reconcileBooks(db, [rig]);
    await assert.doesNotReject(() => reconcileBooks(db, [rig]));
  });

  it('handles multiple rigs and creates a table for each', async () => {
    const db = makeDb();
    await reconcileBooks(db, [
      makeRig('nexus-ledger', { writs: {} }),
      makeRig('my-rig', { items: {} }),
    ]);
    assert.ok(await tableExists(db, 'books_nexus_ledger_writs'));
    assert.ok(await tableExists(db, 'books_my_rig_items'));
  });

  it('uses normalizeRigId — slash becomes double underscore', async () => {
    const db = makeDb();
    await reconcileBooks(db, [makeRig('acme/my-rig', { data: {} })]);
    assert.ok(await tableExists(db, 'books_acme__my_rig_data'));
  });

  it('handles a rig with multiple books', async () => {
    const db = makeDb();
    await reconcileBooks(db, [
      makeRig('my-rig', { widgets: {}, sessions: {} }),
    ]);
    assert.ok(await tableExists(db, 'books_my_rig_widgets'));
    assert.ok(await tableExists(db, 'books_my_rig_sessions'));
  });

  it('is a no-op for a rig with no books', async () => {
    const db = makeDb();
    const rig: LoadedRig = {
      packageName: '@test/empty',
      id: 'empty',
      version: '0.0.0',
      instance: {},
      tools: [],
    };
    await assert.doesNotReject(() => reconcileBooks(db, [rig]));
  });

  it('is a no-op for an empty rig list', async () => {
    const db = makeDb();
    await assert.doesNotReject(() => reconcileBooks(db, []));
  });

  it('throws on an unsafe field name in indexes (injection guard)', async () => {
    const db = makeDb();
    await assert.rejects(
      () => reconcileBooks(db, [
        makeRig('my-rig', { widgets: { indexes: ["bad'field"] } }),
      ]),
      /unsafe field name/,
    );
  });
});
