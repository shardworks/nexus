/**
 * sqlite-backend.test.ts — Unit tests for SqliteBackend internals.
 *
 * Covers the `bindScalar` helper directly to exercise the arms that the
 * conformance suite does not reach (bigint, Buffer, and the throw path for
 * unsupported types).  These tests were added to hold the global function-
 * coverage ratio above the 53% CI floor after bindScalar was introduced to
 * fix the better-sqlite3 boolean-bind regression.
 *
 * Regression context: Clockworks dispatcher.ts queried the events book with
 *   [['processed', '=', false]]
 * better-sqlite3 rejects boolean bind parameters with
 *   "SQLite3 can only bind numbers, strings, bigints, buffers, and null"
 * bindScalar coerces true→1 / false→0 at the bind site, matching
 * json_extract's integer representation of JSON booleans.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindScalar } from './sqlite-backend.ts';

// ── Happy paths ───────────────────────────────────────────────────────

describe('bindScalar — accepted types pass through unchanged or coerced', () => {
  it('passes null through as null', () => {
    assert.strictEqual(bindScalar('f', null), null);
  });

  it('passes a string through unchanged', () => {
    assert.strictEqual(bindScalar('f', 'hello'), 'hello');
  });

  it('passes a number through unchanged', () => {
    assert.strictEqual(bindScalar('f', 42), 42);
  });

  it('passes a bigint through unchanged', () => {
    assert.strictEqual(bindScalar('f', 1n), 1n);
  });

  it('passes a Buffer through as the same reference', () => {
    const buf = Buffer.from([1, 2, 3]);
    assert.strictEqual(bindScalar('f', buf), buf);
  });

  it('maps boolean true to 1 (json_extract returns 1 for JSON true)', () => {
    assert.strictEqual(bindScalar('f', true), 1);
  });

  it('maps boolean false to 0 (json_extract returns 0 for JSON false)', () => {
    assert.strictEqual(bindScalar('f', false), 0);
  });
});

// ── Error paths ───────────────────────────────────────────────────────

describe('bindScalar — unsupported types throw with the field name and type', () => {
  it('throws on undefined, naming the field and the type "undefined"', () => {
    assert.throws(
      () => bindScalar('myField', undefined),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('myField'),
          `expected field name in message; got: ${err.message}`,
        );
        assert.ok(
          err.message.includes('undefined'),
          `expected type "undefined" in message; got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws on a plain object, naming the field and the type "object"', () => {
    assert.throws(
      () => bindScalar('myField', {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('myField'),
          `expected field name in message; got: ${err.message}`,
        );
        assert.ok(
          err.message.includes('object'),
          `expected type "object" in message; got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws on an array (also "object" typeof)', () => {
    assert.throws(
      () => bindScalar('arr', [1, 2, 3]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('arr'));
        return true;
      },
    );
  });
});
