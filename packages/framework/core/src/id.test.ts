import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateId, shortId } from './id.ts';

describe('generateId', () => {
  it('returns a string matching {prefix}-{base36_ts}-{hex_random}', () => {
    const id = generateId('foo');
    assert.match(id, /^foo-[a-z0-9]+-[a-f0-9]+$/);
  });

  it('includes prefix verbatim', () => {
    assert.ok(generateId('ses').startsWith('ses-'));
    assert.ok(generateId('w').startsWith('w-'));
  });

  it('default random suffix is 12 hex characters (6 bytes)', () => {
    const id = generateId('x');
    const parts = id.split('-');
    // parts: ['x', base36ts, hexrand]
    assert.equal(parts.length, 3);
    assert.match(parts[2]!, /^[a-f0-9]{12}$/);
  });

  it('custom randomByteCount produces 2×N hex characters', () => {
    const id4 = generateId('x', 4);
    const id8 = generateId('x', 8);
    assert.match(id4.split('-')[2]!, /^[a-f0-9]{8}$/);
    assert.match(id8.split('-')[2]!, /^[a-f0-9]{16}$/);
  });

  it('two calls produce different IDs', () => {
    const a = generateId('x');
    const b = generateId('x');
    assert.notEqual(a, b);
  });

  it('IDs are lexicographically sortable by creation time', async () => {
    const first = generateId('x');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generateId('x');
    assert.ok(second > first, `expected "${second}" > "${first}"`);
  });
});

describe('shortId', () => {
  it('returns the first two segments of a well-formed three-segment id', () => {
    assert.equal(shortId('w-abc123-deadbeef'), 'w-abc123');
  });

  it('returns a single-token id unchanged', () => {
    assert.equal(shortId('solo'), 'solo');
  });

  it('returns the empty string for an empty input', () => {
    assert.equal(shortId(''), '');
  });

  it('returns the empty-then-empty pair for a lone hyphen', () => {
    assert.equal(shortId('-'), '-');
  });

  it('round-trips as the shape resolveId() accepts as a unique prefix', () => {
    const full = generateId('w');
    const short = shortId(full);
    assert.ok(full.startsWith(short + '-'), `expected "${full}" to start with "${short}-"`);
    assert.equal(short.split('-').length, 2);
  });
});
