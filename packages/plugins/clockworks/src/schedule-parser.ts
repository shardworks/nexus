/**
 * Pure parsing for the `schedule:` value of a scheduled standing order.
 *
 * Two syntaxes are supported (commission decisions D6, D7):
 *
 *   - **Standard 5-field unix cron** (`m h dom mon dow`) — delegated to
 *     `cron-parser`. 6/7-field forms (with seconds or with year) and
 *     vendor cron extensions are rejected; the brief is explicit about
 *     scope.
 *   - **`@every <duration>`** — the literal prefix `@every ` followed
 *     by a positive integer and one of the unit suffixes `s`/`m`/`h`.
 *     Anything else is rejected.
 *
 * The module is pure plumbing: no apparatus imports, no `Date.now()`,
 * no global clock access. The validator (load-time) and the scheduler
 * (runtime) both consume the same two operations:
 *
 *   - {@link parseSchedule}: parse-and-validate a raw string into a
 *     handle, or surface a structured error.
 *   - {@link computeNextFireTime}: given a handle and a reference time,
 *     return the next fire time strictly after the reference (D8 for
 *     `@every`, D9 for cron — both fall out of the same boundary
 *     contract).
 *
 * No timezone configuration is exposed; cron expressions are evaluated
 * in the daemon's local time zone (brief: "standard unix cron evaluated
 * in the daemon's local time zone").
 */

import { CronExpressionParser, type CronExpression } from 'cron-parser';

// ── Public types ─────────────────────────────────────────────────────

/**
 * The handle produced by a successful {@link parseSchedule}. Both
 * variants carry the original verbatim string so error messages can
 * quote the operator-authored value.
 */
export type ParsedSchedule =
  | {
      readonly kind: 'every';
      /** Interval in milliseconds. Always positive. */
      readonly durationMs: number;
      /** The verbatim `@every …` source string. */
      readonly original: string;
    }
  | {
      readonly kind: 'cron';
      /** The verbatim 5-field cron source string. */
      readonly expression: string;
      /** The verbatim source string (== `expression` for cron). */
      readonly original: string;
    };

/**
 * Result of {@link parseSchedule}. Surfaced as a tagged union rather
 * than throwing so the standing-order validator can aggregate
 * per-order errors and report them together (matches the existing
 * validator aggregation contract).
 */
type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedSchedule }
  | { readonly ok: false; readonly error: string };

// ── @every parsing ────────────────────────────────────────────────────

/**
 * Strict regex for the `@every` form. Captures the integer count and
 * the single-character unit suffix. Anything outside this exact shape
 * is rejected — leading/trailing whitespace, fractional values,
 * compound durations (`@every 1m30s`), unsupported units (`d`, `w`),
 * or missing units.
 */
const EVERY_PATTERN = /^@every (\d+)([smh])$/;

/** Unit → millisecond multiplier table (D7). */
const EVERY_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
});

function parseEvery(value: string): ParseResult {
  const match = EVERY_PATTERN.exec(value);
  if (!match) {
    return {
      ok: false,
      error:
        `"@every" form must match "@every <N><unit>" with unit one of s/m/h ` +
        `(e.g. "@every 30s", "@every 5m", "@every 1h"); got ${JSON.stringify(value)}.`,
    };
  }
  const count = Number(match[1]);
  const unit = match[2]!;
  // Reject `@every 0s` etc. — a zero-interval order would fire every
  // tick, which is not what the brief promises and is almost certainly
  // a config bug. Surface fail-loud rather than silently spamming the
  // dispatch log.
  if (!Number.isInteger(count) || count <= 0) {
    return {
      ok: false,
      error:
        `"@every" interval must be a positive integer; got ${JSON.stringify(value)}.`,
    };
  }
  const multiplier = EVERY_UNIT_MS[unit];
  if (multiplier === undefined) {
    // Unreachable given the regex, but defensive — keeps the unit
    // table the single source of truth for valid suffixes.
    return {
      ok: false,
      error: `"@every" unit "${unit}" is not supported (use s/m/h).`,
    };
  }
  return {
    ok: true,
    parsed: {
      kind: 'every',
      durationMs: count * multiplier,
      original: value,
    },
  };
}

// ── cron parsing ──────────────────────────────────────────────────────

/**
 * Reject any cron expression whose field count is not exactly 5. The
 * brief restricts the apparatus to standard unix cron (`m h dom mon
 * dow`); cron-parser accepts both 5-field and 6-field (with seconds)
 * forms by default, so we gate the field count up-front.
 */
function isFiveFieldCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5;
}

function parseCron(value: string): ParseResult {
  if (!isFiveFieldCron(value)) {
    return {
      ok: false,
      error:
        `cron expression must have exactly 5 space-separated fields ` +
        `(minute hour day-of-month month day-of-week); got ${JSON.stringify(value)}.`,
    };
  }
  try {
    // Parse-validate: cron-parser throws on malformed expressions.
    // The reference time here is irrelevant — we only care that the
    // parser accepts the source.
    CronExpressionParser.parse(value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `invalid cron expression ${JSON.stringify(value)}: ${reason}`,
    };
  }
  return {
    ok: true,
    parsed: {
      kind: 'cron',
      expression: value,
      original: value,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Parse a `schedule:` value, returning either a handle or a structured
 * error. The validator and the scheduler call this; both surface the
 * `error` string verbatim in their own messages.
 *
 * Accepts:
 *   - `@every <N><s|m|h>` (D7)
 *   - 5-field unix cron (D6)
 *
 * Rejects: anything else, including 6/7-field cron, blank strings,
 * sub-second `@every` values, and non-string inputs.
 */
export function parseSchedule(value: unknown): ParseResult {
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `schedule expression must be a string; got ${describeValue(value)}.`,
    };
  }
  if (value.length === 0) {
    return {
      ok: false,
      error: 'schedule expression must be a non-empty string.',
    };
  }
  if (value.startsWith('@every ')) {
    return parseEvery(value);
  }
  // Treat any other `@`-prefixed expression as an unsupported alias —
  // cron-parser would otherwise expand `@yearly`/`@daily`/`@hourly`
  // implicitly, but the brief reserves `@every` as the only `@` form.
  if (value.startsWith('@')) {
    return {
      ok: false,
      error:
        `unsupported schedule alias ${JSON.stringify(value)}; only "@every <N><s|m|h>" ` +
        `and standard 5-field cron are supported.`,
    };
  }
  return parseCron(value);
}

/**
 * Compute the next fire time strictly after `after`.
 *
 * Contract — both variants honor "strictly after" so a fire at time
 * T advances to a time > T (not == T). This matches D8 for `@every`
 * (initial = now + duration, never the daemon-start instant itself)
 * and the universal cron contract (next boundary, not "this very
 * second" if `after` already lies on a boundary).
 *
 * Implementation:
 *   - `@every`: return `after + durationMs`.
 *   - `cron`: hand `currentDate: after` to cron-parser and pull
 *     `next()`. cron-parser's `next()` already returns the next
 *     boundary strictly greater than `currentDate`, so callers do not
 *     need to add a fudge factor.
 */
export function computeNextFireTime(
  parsed: ParsedSchedule,
  after: Date,
): Date {
  if (parsed.kind === 'every') {
    return new Date(after.getTime() + parsed.durationMs);
  }
  // cron — re-instantiate per call rather than caching the
  // CronExpression handle. The cost is negligible (microseconds) and
  // it sidesteps cron-parser's mutable internal cursor: each call gets
  // a fresh cursor anchored to `after`.
  const expr: CronExpression = CronExpressionParser.parse(parsed.expression, {
    currentDate: after,
  });
  return expr.next().toDate();
}

// ── Helpers ───────────────────────────────────────────────────────────

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
