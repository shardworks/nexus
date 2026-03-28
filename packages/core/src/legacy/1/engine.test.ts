import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { engine, isClockworkEngine, resolveEngineFromExport } from './engine.ts';

describe('engine SDK', () => {
  it('creates a definition with name, __clockwork brand, and handler', () => {
    const def = engine({
      name: 'test-engine',
      handler: async () => {},
    });

    assert.equal(def.name, 'test-engine');
    assert.equal(def.__clockwork, true);
    assert.equal(typeof def.handler, 'function');
  });

  it('handler receives event and context', async () => {
    let receivedEvent: unknown;
    let receivedCtx: unknown;

    const def = engine({
      name: 'event-test',
      handler: async (event, ctx) => {
        receivedEvent = event;
        receivedCtx = ctx;
      },
    });

    const testEvent = {
      id: '1',
      name: 'test.event',
      payload: { key: 'value' },
      emitter: 'test',
      firedAt: '2026-03-24T00:00:00Z',
    };

    await def.handler(testEvent, { home: '/tmp/test', params: {} });
    assert.deepEqual(receivedEvent, testEvent);
    assert.deepEqual(receivedCtx, { home: '/tmp/test', params: {} });
  });

  it('handler accepts null event for direct invocation', async () => {
    let receivedEvent: unknown = 'sentinel';

    const def = engine({
      name: 'null-event-test',
      handler: async (event) => {
        receivedEvent = event;
      },
    });

    await def.handler(null, { home: '/tmp/test', params: {} });
    assert.equal(receivedEvent, null);
  });
});

describe('isClockworkEngine', () => {
  it('returns true for engine() output', () => {
    const def = engine({ name: 'test', handler: async () => {} });
    assert.equal(isClockworkEngine(def), true);
  });

  it('returns false for plain objects', () => {
    assert.equal(isClockworkEngine({}), false);
    assert.equal(isClockworkEngine({ handler: async () => {} }), false);
    assert.equal(isClockworkEngine(null), false);
    assert.equal(isClockworkEngine(undefined), false);
    assert.equal(isClockworkEngine('string'), false);
  });

  it('returns false for objects with wrong __clockwork value', () => {
    assert.equal(isClockworkEngine({ __clockwork: false, handler: async () => {} }), false);
  });
});

describe('resolveEngineFromExport', () => {
  const engineA = engine({
    name: 'alpha',
    handler: async () => {},
  });

  const engineB = engine({
    name: 'beta',
    handler: async () => {},
  });

  it('resolves a single engine export by name', () => {
    const result = resolveEngineFromExport(engineA, 'alpha');
    assert.equal(result, engineA);
  });

  it('resolves a single engine export without name', () => {
    const result = resolveEngineFromExport(engineA);
    assert.equal(result, engineA);
  });

  it('returns null for single engine when name does not match', () => {
    const result = resolveEngineFromExport(engineA, 'wrong-name');
    assert.equal(result, null);
  });

  it('resolves an engine from an array by name', () => {
    const result = resolveEngineFromExport([engineA, engineB], 'beta');
    assert.equal(result, engineB);
  });

  it('returns null for array when name does not match', () => {
    const result = resolveEngineFromExport([engineA, engineB], 'gamma');
    assert.equal(result, null);
  });

  it('returns the only engine from a single-element array without name', () => {
    const result = resolveEngineFromExport([engineA]);
    assert.equal(result, engineA);
  });

  it('returns null for multi-element array without name', () => {
    const result = resolveEngineFromExport([engineA, engineB]);
    assert.equal(result, null);
  });

  it('returns null for non-engine values', () => {
    assert.equal(resolveEngineFromExport(null), null);
    assert.equal(resolveEngineFromExport('string'), null);
    assert.equal(resolveEngineFromExport(42), null);
  });
});
