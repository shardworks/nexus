/**
 * Standing-order validator unit tests.
 *
 * Mirrors the rule matrix in `standing-order-validator.ts`:
 *   - canonical happy path (single order, multiple orders, with `with:`
 *     present and absent)
 *   - non-array input rejection
 *   - non-object entry rejection
 *   - missing / non-string `on:` and `run:` rejection
 *   - dropped-sugar (`summon:`, `brief:`, `prompt:`) rejection
 *   - unknown / typo / flat-spread top-level key rejection
 *   - non-object `with:` (null, array, primitive) rejection
 *   - aggregation across multiple offenders in a single throw
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateStandingOrders } from './standing-order-validator.ts';

describe('validateStandingOrders — happy paths', () => {
  it('accepts an empty array', () => {
    assert.doesNotThrow(() => validateStandingOrders([]));
  });

  it('accepts a single canonical order without `with:`', () => {
    assert.doesNotThrow(() =>
      validateStandingOrders([{ on: 'demo.thing', run: 'log-event' }]),
    );
  });

  it('accepts a single canonical order with empty `with:`', () => {
    assert.doesNotThrow(() =>
      validateStandingOrders([
        { on: 'demo.thing', run: 'log-event', with: {} },
      ]),
    );
  });

  it('accepts a canonical order with a populated `with:` block', () => {
    assert.doesNotThrow(() =>
      validateStandingOrders([
        {
          on: 'demo.thing',
          run: 'log-event',
          with: { level: 'info', target: 'stdout' },
        },
      ]),
    );
  });

  it('accepts multiple canonical orders mixed with and without `with:`', () => {
    assert.doesNotThrow(() =>
      validateStandingOrders([
        { on: 'a.x', run: 'r1' },
        { on: 'a.y', run: 'r2', with: { foo: 1 } },
        { on: 'a.z', run: 'r1', with: {} },
      ]),
    );
  });

  it('accepts an explicit `with: undefined` (treated as absent)', () => {
    assert.doesNotThrow(() =>
      validateStandingOrders([
        { on: 'demo.thing', run: 'log-event', with: undefined },
      ]),
    );
  });
});

describe('validateStandingOrders — structural rejection', () => {
  it('rejects a non-array top-level value', () => {
    assert.throws(
      () => validateStandingOrders({ on: 'a', run: 'b' } as never),
      /standingOrders must be an array/,
    );
  });

  it('rejects a non-object entry (null)', () => {
    assert.throws(
      () => validateStandingOrders([null]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /expected a plain object/.test(err.message),
    );
  });

  it('rejects a non-object entry (string)', () => {
    assert.throws(
      () => validateStandingOrders(['oops']),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /expected a plain object/.test(err.message),
    );
  });

  it('rejects an array entry', () => {
    assert.throws(
      () => validateStandingOrders([['on', 'a']]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /expected a plain object/.test(err.message),
    );
  });
});

describe('validateStandingOrders — required-field rejection', () => {
  it('rejects an order missing `on`', () => {
    assert.throws(
      () => validateStandingOrders([{ run: 'r' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /missing required field "on"/.test(err.message),
    );
  });

  it('rejects an order missing `run`', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'e' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /missing required field "run"/.test(err.message),
    );
  });

  it('rejects an order whose `on` is not a string', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 42, run: 'r' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /"on" must be a non-empty string/.test(err.message),
    );
  });

  it('rejects an order whose `on` is an empty string', () => {
    assert.throws(
      () => validateStandingOrders([{ on: '', run: 'r' }]),
      (err: Error) =>
        /"on" must be a non-empty string/.test(err.message),
    );
  });

  it('rejects an order whose `run` is not a string', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'e', run: 7 }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /"run" must be a non-empty string/.test(err.message),
    );
  });

  it('rejects an order whose `run` is an empty string', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'e', run: '' }]),
      (err: Error) =>
        /"run" must be a non-empty string/.test(err.message),
    );
  });
});

describe('validateStandingOrders — dropped sugar rejection', () => {
  it('rejects the `summon:` sugar form by name', () => {
    assert.throws(
      () =>
        validateStandingOrders([{ on: 'a', summon: 'reviewer', prompt: 'go' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /"summon:" sugar form has been removed/.test(err.message),
    );
  });

  it('rejects the `brief:` sugar form by name', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', brief: '/path/to/brief.md' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /"brief:" sugar form has been removed/.test(err.message),
    );
  });

  it('rejects a stray `prompt:` even alongside `run`', () => {
    // `prompt:` belonged to the `summon:` sugar form; flagging it
    // explicitly catches half-migrated configs.
    assert.throws(
      () =>
        validateStandingOrders([
          { on: 'a', run: 'r', prompt: 'leftover prompt' },
        ]),
      (err: Error) =>
        /"prompt:" sugar form has been removed/.test(err.message),
    );
  });
});

describe('validateStandingOrders — unknown-key rejection', () => {
  it('rejects a typo at the top level (`runn:` vs `run:`)', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', runn: 'r' }]),
      (err: Error) =>
        /standing order #0/.test(err.message) &&
        /unknown top-level key/.test(err.message) &&
        /"runn"/.test(err.message),
    );
  });

  it('rejects flat-spread params (params at the top level)', () => {
    assert.throws(
      () =>
        validateStandingOrders([
          { on: 'a', run: 'r', level: 'info', target: 'stdout' },
        ]),
      (err: Error) =>
        /unknown top-level key/.test(err.message) &&
        /params belong inside "with"/.test(err.message),
    );
  });

  it('rejects future-reserved keys until they are wired (e.g. `schedule:`)', () => {
    assert.throws(
      () =>
        validateStandingOrders([
          { on: 'a', run: 'r', schedule: 'every 5m' },
        ]),
      /unknown top-level key/,
    );
  });
});

describe('validateStandingOrders — `with:` shape rejection', () => {
  it('rejects `with: null`', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', run: 'r', with: null }]),
      (err: Error) =>
        /"with" must be a plain object when present/.test(err.message) &&
        /null/.test(err.message),
    );
  });

  it('rejects `with: []`', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', run: 'r', with: [] }]),
      (err: Error) =>
        /"with" must be a plain object when present/.test(err.message) &&
        /array/.test(err.message),
    );
  });

  it('rejects a string `with:` value', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', run: 'r', with: 'oops' }]),
      /"with" must be a plain object when present/,
    );
  });

  it('rejects a numeric `with:` value', () => {
    assert.throws(
      () => validateStandingOrders([{ on: 'a', run: 'r', with: 42 }]),
      /"with" must be a plain object when present/,
    );
  });
});

describe('validateStandingOrders — aggregation', () => {
  it('aggregates multiple offenders into a single thrown Error', () => {
    let captured: Error | null = null;
    try {
      validateStandingOrders([
        { on: 'a', run: 'r' }, // ok
        { on: 'b' }, // missing run
        { brief: '/x' }, // dropped sugar
        { on: 'c', run: 'q', with: 'oops' }, // bad with
        { on: 'd', run: 'q', schedule: 'every 5m' }, // unknown key
      ]);
    } catch (err) {
      captured = err as Error;
    }
    assert.ok(captured, 'validator should throw on aggregated input');
    const msg = captured!.message;
    // Header reflects the count.
    assert.match(msg, /4 invalid standing orders/);
    // Each offending index is named.
    assert.match(msg, /standing order #1/);
    assert.match(msg, /standing order #2/);
    assert.match(msg, /standing order #3/);
    assert.match(msg, /standing order #4/);
    // The valid order at index 0 is not mentioned.
    assert.doesNotMatch(msg, /standing order #0/);
    // Per-offender reasons appear.
    assert.match(msg, /missing required field "run"/);
    assert.match(msg, /"brief:" sugar form has been removed/);
    assert.match(msg, /"with" must be a plain object/);
    assert.match(msg, /unknown top-level key/);
  });

  it('uses a singular header when exactly one order is invalid', () => {
    let captured: Error | null = null;
    try {
      validateStandingOrders([
        { on: 'a', run: 'r' },
        { on: 'b' }, // the only offender
      ]);
    } catch (err) {
      captured = err as Error;
    }
    assert.ok(captured);
    assert.match(captured!.message, /^clockworks: invalid standing order in guild\.json:/);
    assert.doesNotMatch(captured!.message, /\d+ invalid standing orders/);
  });
});
