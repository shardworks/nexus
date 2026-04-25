/**
 * Schedule-parser unit tests.
 *
 * Mirrors the rule matrix in `schedule-parser.ts`:
 *   - happy paths for `@every` (s/m/h units)
 *   - happy paths for standard 5-field cron
 *   - non-string / blank-string rejection
 *   - sub-second / non-integer / negative `@every` rejection
 *   - unsupported `@every` units (d, w) rejection
 *   - unsupported `@daily`/`@hourly` aliases
 *   - 6-field cron rejection (cron-parser would otherwise accept)
 *   - garbage-cron rejection (delegated to cron-parser, error surface
 *     is required to quote the offending value)
 *   - computeNextFireTime semantics — D8 (every) and D9 (cron)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeNextFireTime, parseSchedule } from './schedule-parser.ts';

describe('parseSchedule — @every happy paths', () => {
  it('accepts seconds', () => {
    const r = parseSchedule('@every 30s');
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.parsed, {
      kind: 'every',
      durationMs: 30_000,
      original: '@every 30s',
    });
  });

  it('accepts minutes', () => {
    const r = parseSchedule('@every 5m');
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.parsed, {
      kind: 'every',
      durationMs: 5 * 60_000,
      original: '@every 5m',
    });
  });

  it('accepts hours', () => {
    const r = parseSchedule('@every 2h');
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.parsed, {
      kind: 'every',
      durationMs: 2 * 3_600_000,
      original: '@every 2h',
    });
  });

  it('accepts the minimal 1s value', () => {
    const r = parseSchedule('@every 1s');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.parsed.kind, 'every');
    assert.equal(r.ok && r.parsed.durationMs, 1_000);
  });
});

describe('parseSchedule — @every rejection', () => {
  it('rejects @every 0s (zero interval)', () => {
    const r = parseSchedule('@every 0s');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /positive integer/);
  });

  it('rejects fractional values', () => {
    const r = parseSchedule('@every 1.5m');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /must match "@every <N><unit>"/);
  });

  it('rejects unsupported units (days)', () => {
    const r = parseSchedule('@every 1d');
    assert.equal(r.ok, false);
    assert.match(
      (r as { error: string }).error,
      /must match "@every <N><unit>"/,
    );
  });

  it('rejects unsupported units (weeks)', () => {
    const r = parseSchedule('@every 1w');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /must match "@every/);
  });

  it('rejects compound durations', () => {
    const r = parseSchedule('@every 1m30s');
    assert.equal(r.ok, false);
  });

  it('rejects @every with no unit', () => {
    const r = parseSchedule('@every 30');
    assert.equal(r.ok, false);
  });

  it('rejects @every with leading whitespace inside the count', () => {
    const r = parseSchedule('@every  5m');
    assert.equal(r.ok, false);
  });

  it('rejects @every with negative interval', () => {
    const r = parseSchedule('@every -5m');
    assert.equal(r.ok, false);
  });

  it('quotes the offending value in the error', () => {
    const r = parseSchedule('@every 1d');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /"@every 1d"/);
  });
});

describe('parseSchedule — cron happy paths', () => {
  it('accepts the canonical "every 5 minutes" expression', () => {
    const r = parseSchedule('*/5 * * * *');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.parsed.kind, 'cron');
    assert.equal(r.ok && r.parsed.kind === 'cron' && r.parsed.expression, '*/5 * * * *');
  });

  it('accepts a fully-specified expression', () => {
    const r = parseSchedule('0 9 * * 1');
    assert.equal(r.ok, true);
  });

  it('accepts a star-only expression', () => {
    const r = parseSchedule('* * * * *');
    assert.equal(r.ok, true);
  });

  it('accepts ranges and lists', () => {
    const r = parseSchedule('0,15,30,45 9-17 * * 1-5');
    assert.equal(r.ok, true);
  });
});

describe('parseSchedule — cron rejection', () => {
  it('rejects 6-field cron (with seconds)', () => {
    const r = parseSchedule('0 */5 * * * *');
    assert.equal(r.ok, false);
    assert.match(
      (r as { error: string }).error,
      /exactly 5 space-separated fields/,
    );
  });

  it('rejects 4-field cron (too few)', () => {
    const r = parseSchedule('* * * *');
    assert.equal(r.ok, false);
    assert.match(
      (r as { error: string }).error,
      /exactly 5 space-separated fields/,
    );
  });

  it('rejects garbage-cron via cron-parser surface (5-field but invalid)', () => {
    // Five tokens but none of them are valid cron — the field count
    // check passes, cron-parser rejects on field content.
    const r = parseSchedule('not a cron at all');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /invalid cron expression/i);
  });

  it('rejects malformed 5-field cron (cron-parser surface)', () => {
    const r = parseSchedule('xx * * * *');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /invalid cron expression/i);
  });

  it('quotes the offending expression in the error', () => {
    const r = parseSchedule('xx * * * *');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /"xx \* \* \* \*"/);
  });
});

describe('parseSchedule — input shape rejection', () => {
  it('rejects non-string values (number)', () => {
    const r = parseSchedule(42 as unknown);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /must be a string/);
  });

  it('rejects non-string values (null)', () => {
    const r = parseSchedule(null);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /must be a string/);
    assert.match((r as { error: string }).error, /null/);
  });

  it('rejects empty strings', () => {
    const r = parseSchedule('');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /non-empty/);
  });

  it('rejects @daily / other @ aliases', () => {
    const r = parseSchedule('@daily');
    assert.equal(r.ok, false);
    assert.match(
      (r as { error: string }).error,
      /unsupported schedule alias/,
    );
  });

  it('rejects @hourly', () => {
    const r = parseSchedule('@hourly');
    assert.equal(r.ok, false);
    assert.match(
      (r as { error: string }).error,
      /unsupported schedule alias/,
    );
  });
});

describe('computeNextFireTime — @every', () => {
  it('returns reference + duration (D8 startup contract)', () => {
    const r = parseSchedule('@every 30s');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const start = new Date('2024-01-01T00:00:00Z');
    const next = computeNextFireTime(r.parsed, start);
    assert.equal(next.toISOString(), '2024-01-01T00:00:30.000Z');
  });

  it('returns reference + duration regardless of millisecond offset', () => {
    const r = parseSchedule('@every 5m');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const start = new Date('2024-01-01T00:00:01.234Z');
    const next = computeNextFireTime(r.parsed, start);
    assert.equal(next.toISOString(), '2024-01-01T00:05:01.234Z');
  });

  it('produces a strictly-after value (not equal)', () => {
    const r = parseSchedule('@every 1s');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const start = new Date('2024-01-01T00:00:00Z');
    const next = computeNextFireTime(r.parsed, start);
    assert.ok(next.getTime() > start.getTime());
  });
});

describe('computeNextFireTime — cron', () => {
  it('returns the next 5-minute boundary after a non-boundary reference (D9)', () => {
    const r = parseSchedule('*/5 * * * *');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Reference falls between 12:02 and 12:05 — next boundary is 12:05.
    const ref = new Date('2024-01-01T12:02:30Z');
    const next = computeNextFireTime(r.parsed, ref);
    assert.equal(next.toISOString(), '2024-01-01T12:05:00.000Z');
  });

  it('returns the *next* boundary when reference lies exactly on a boundary', () => {
    const r = parseSchedule('*/5 * * * *');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Reference at 12:00:00 — cron-parser treats next() as strictly
    // greater, so we expect 12:05, not 12:00.
    const ref = new Date('2024-01-01T12:00:00Z');
    const next = computeNextFireTime(r.parsed, ref);
    assert.equal(next.toISOString(), '2024-01-01T12:05:00.000Z');
  });

  it('chains successive calls correctly', () => {
    const r = parseSchedule('*/5 * * * *');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    let cursor = new Date('2024-01-01T12:00:00Z');
    cursor = computeNextFireTime(r.parsed, cursor);
    cursor = computeNextFireTime(r.parsed, cursor);
    cursor = computeNextFireTime(r.parsed, cursor);
    assert.equal(cursor.toISOString(), '2024-01-01T12:15:00.000Z');
  });
});
