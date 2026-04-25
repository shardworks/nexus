/**
 * Relay SDK — unit tests.
 *
 * Exercises the factory contract and the structural type guard in
 * isolation from the apparatus. Registry / resolver behavior lives in
 * `clockworks.test.ts`.
 *
 * Coverage matches the brief's t3 acceptance:
 *   - relay() accepts a valid {name, handler} and preserves the optional
 *     description;
 *   - relay() throws synchronously on missing/empty/non-string name;
 *   - relay() throws synchronously on missing/non-function handler;
 *   - both async and sync handlers are accepted;
 *   - the returned value satisfies isRelayDefinition;
 *   - arbitrary non-matching shapes fail isRelayDefinition.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRelayDefinition, relay } from './relay.ts';
import type { GuildEvent, RelayContext } from './relay.ts';

// ── relay() factory ───────────────────────────────────────────────────

describe('relay()', () => {
  it('accepts a valid {name, handler} and returns a RelayDefinition', () => {
    const def = relay({
      name: 'log-event',
      handler: async (_event: GuildEvent, _ctx: RelayContext) => {},
    });

    assert.equal(def.name, 'log-event');
    assert.equal(typeof def.handler, 'function');
    assert.equal('description' in def, false, 'description is omitted when not supplied');
  });

  it('preserves an optional description when supplied', () => {
    const def = relay({
      name: 'log-event',
      description: 'Write the event to stdout.',
      handler: async () => {},
    });

    assert.equal(def.description, 'Write the event to stdout.');
  });

  it('accepts a synchronous handler returning void', () => {
    const def = relay({
      name: 'sync-handler',
      handler: () => {
        // no-op
      },
    });

    assert.equal(typeof def.handler, 'function');
    // The dispatcher always awaits — confirm the function call returns
    // something awaitable-safe (undefined is awaitable).
    const result = def.handler(
      { id: 'e-1', name: 't', payload: null, emitter: 'x', firedAt: 'now' },
      { home: '/tmp', params: {} },
    );
    assert.equal(result, undefined);
  });

  it('accepts an async handler returning a Promise<void>', async () => {
    const def = relay({
      name: 'async-handler',
      handler: async () => {},
    });

    const result = def.handler(
      { id: 'e-1', name: 't', payload: null, emitter: 'x', firedAt: 'now' },
      { home: '/tmp', params: {} },
    );
    assert.ok(result instanceof Promise, 'async handler returns a Promise');
    await result;
  });

  it('throws synchronously when name is missing', () => {
    assert.throws(
      () =>
        relay({
          handler: async () => {},
        } as unknown as Parameters<typeof relay>[0]),
      /name.*required.*non-empty string/i,
    );
  });

  it('throws synchronously when name is an empty string', () => {
    assert.throws(
      () =>
        relay({
          name: '',
          handler: async () => {},
        }),
      /name.*required.*non-empty string/i,
    );
  });

  it('throws synchronously when name is not a string', () => {
    assert.throws(
      () =>
        relay({
          name: 42 as unknown as string,
          handler: async () => {},
        }),
      /name.*required.*non-empty string/i,
    );
  });

  it('throws synchronously when handler is missing', () => {
    assert.throws(
      () =>
        relay({
          name: 'no-handler',
        } as unknown as Parameters<typeof relay>[0]),
      /handler.*required.*function/i,
    );
  });

  it('throws synchronously when handler is not a function', () => {
    assert.throws(
      () =>
        relay({
          name: 'bad-handler',
          handler: 'not a function' as unknown as () => void,
        }),
      /handler.*required.*function/i,
    );
  });

  it('mentions the relay name in the handler-validation error message', () => {
    assert.throws(
      () =>
        relay({
          name: 'my-relay',
          handler: undefined as unknown as () => void,
        }),
      /my-relay/,
    );
  });
});

// ── isRelayDefinition() type guard ────────────────────────────────────

describe('isRelayDefinition()', () => {
  it('returns true for a value produced by relay()', () => {
    const def = relay({
      name: 'log-event',
      handler: async () => {},
    });
    assert.equal(isRelayDefinition(def), true);
  });

  it('returns true for a structurally-equivalent plain object', () => {
    const def = {
      name: 'manual',
      handler: () => {},
    };
    assert.equal(isRelayDefinition(def), true);
  });

  it('returns true when an optional description is present', () => {
    const def = {
      name: 'manual',
      description: 'desc',
      handler: () => {},
    };
    assert.equal(isRelayDefinition(def), true);
  });

  it('returns false for null', () => {
    assert.equal(isRelayDefinition(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isRelayDefinition(undefined), false);
  });

  it('returns false for a non-object (string)', () => {
    assert.equal(isRelayDefinition('relay'), false);
  });

  it('returns false for a non-object (number)', () => {
    assert.equal(isRelayDefinition(123), false);
  });

  it('returns false when name is missing', () => {
    assert.equal(isRelayDefinition({ handler: () => {} }), false);
  });

  it('returns false when name is an empty string', () => {
    assert.equal(isRelayDefinition({ name: '', handler: () => {} }), false);
  });

  it('returns false when name is not a string', () => {
    assert.equal(isRelayDefinition({ name: 42, handler: () => {} }), false);
  });

  it('returns false when handler is missing', () => {
    assert.equal(isRelayDefinition({ name: 'r' }), false);
  });

  it('returns false when handler is not a function', () => {
    assert.equal(
      isRelayDefinition({ name: 'r', handler: 'not-a-function' }),
      false,
    );
  });

  it('returns false when description is present but not a string', () => {
    assert.equal(
      isRelayDefinition({ name: 'r', handler: () => {}, description: 42 }),
      false,
    );
  });
});
