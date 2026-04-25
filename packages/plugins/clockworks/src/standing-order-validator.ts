/**
 * Shared standing-order validator — used by the Clockworks dispatcher
 * (and any future config-write hook or operator-facing CLI linter) so
 * every load-time check rejects the same set of malformed standing
 * orders with the same messages.
 *
 * The validator is pure: it takes the raw `clockworks.standingOrders`
 * array off `guild.json`, walks every entry, aggregates every
 * violation, and throws a single descriptive `Error` whose message
 * lists every offender's index and reason (commission decisions
 * D4, D26).
 *
 * The canonical shape is exactly one of:
 *   - `{ on: string; run: string; with?: Record<string, unknown> }`
 *     for event-driven orders, or
 *   - `{ schedule: string; run: string; with?: Record<string, unknown> }`
 *     for time-driven orders (D1 — the XOR rule lives here, not in
 *     the TypeScript type).
 *
 * `on:` and `schedule:` are mutually exclusive: exactly one must be
 * present. `schedule:` values are parse-checked at load time against
 * the shared `schedule-parser` so malformed cron / `@every` strings
 * fail loud at boot (D17). Any other top-level key, missing required
 * field, or non-plain-object `with:` value is rejected. The dropped
 * sugar forms (`summon:` / `brief:`) and flat-spread param shapes are
 * called out by name in the error message so operators editing legacy
 * configs know exactly what changed.
 *
 * Mirrors the pure-module + descriptive-Error shape of
 * `signal-validator.ts` so future operator-facing surfaces (lint
 * commands, write-hooks) can reuse the validator without booting any
 * apparatus.
 */

import { parseSchedule } from './schedule-parser.ts';

/**
 * The canonical top-level keys a standing order may declare. Anything
 * else is a load-time error — reserving keys that this commission
 * does not actually wire (`id`, `enabled`, `description`, …) would
 * silently swallow typos. Future commissions that add such keys will
 * extend this allowlist.
 */
export const ALLOWED_STANDING_ORDER_KEYS: readonly string[] = Object.freeze([
  'on',
  'schedule',
  'run',
  'with',
]);

/**
 * The dropped sugar fields. Their presence at the top level produces a
 * dedicated error message that names the dropped form so legacy
 * configs are easy to migrate.
 */
const DROPPED_SUGAR_KEYS: readonly string[] = Object.freeze([
  'summon',
  'brief',
  'prompt',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/**
 * Validate every entry in a `clockworks.standingOrders` array.
 *
 * Aggregates all violations into a single thrown Error. The message is
 * a header line followed by one bullet per offender naming its index
 * and the reason. If the input itself is not an array (the schema
 * surfaces it as `StandingOrder[] | undefined`) the validator throws a
 * structural error.
 *
 * @param orders The current standing-order array (typically
 *               `g.guildConfig().clockworks?.standingOrders ?? []`).
 * @throws Error with an aggregated descriptive message when any
 *         violation is found.
 */
export function validateStandingOrders(orders: readonly unknown[]): void {
  if (!Array.isArray(orders)) {
    throw new Error(
      `clockworks: standingOrders must be an array, got ${describeValue(orders)}.`,
    );
  }

  const errors: string[] = [];

  orders.forEach((order, index) => {
    const issue = validateSingleOrder(order, index);
    if (issue !== null) {
      errors.push(`  - standing order #${index}: ${issue}`);
    }
  });

  if (errors.length > 0) {
    const header =
      errors.length === 1
        ? 'clockworks: invalid standing order in guild.json:'
        : `clockworks: ${errors.length} invalid standing orders in guild.json:`;
    throw new Error([header, ...errors].join('\n'));
  }
}

/**
 * Validate one entry. Returns null on success or a human-readable
 * reason on failure. Aggregation is owned by the caller.
 *
 * The check order matters for message clarity: structural shape first,
 * then the dropped-sugar callouts (so legacy configs get the dedicated
 * migration message), then unknown-key rejection, then the per-field
 * shape rules.
 */
function validateSingleOrder(order: unknown, _index: number): string | null {
  if (!isPlainObject(order)) {
    return `expected a plain object, got ${describeValue(order)}.`;
  }

  // Surface dropped-sugar usage as its own dedicated message — operators
  // migrating from earlier shapes need to see the dropped key by name,
  // not just an "unknown key" line.
  for (const droppedKey of DROPPED_SUGAR_KEYS) {
    if (Object.prototype.hasOwnProperty.call(order, droppedKey)) {
      return (
        `the "${droppedKey}:" sugar form has been removed; rewrite the order ` +
        `as { on, run, with? } and invoke a relay instead.`
      );
    }
  }

  // Reject any other unknown top-level key. This catches typos
  // (`idd:`, `runn:`) and flat-spread param shapes
  // (`{ on, run, foo: 1, bar: 2 }`) — both surface as unknown keys.
  const unknownKeys = Object.keys(order).filter(
    (key) => !ALLOWED_STANDING_ORDER_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    return (
      `unknown top-level key(s) ${unknownKeys
        .map((k) => `"${k}"`)
        .join(', ')}; allowed keys are ${ALLOWED_STANDING_ORDER_KEYS.map(
        (k) => `"${k}"`,
      ).join(', ')} (params belong inside "with").`
    );
  }

  // Trigger-shape rule: exactly one of `on:` or `schedule:` must be
  // present. The XOR check sits before the per-field shape rules so
  // operators authoring an order with both keys see the dedicated
  // collision message rather than chained shape errors.
  const hasOn = 'on' in order && order.on !== undefined;
  const hasSchedule = 'schedule' in order && order.schedule !== undefined;
  if (!hasOn && !hasSchedule) {
    return (
      'missing trigger: declare exactly one of "on" (event name) or ' +
      '"schedule" (cron / @every expression).'
    );
  }
  if (hasOn && hasSchedule) {
    return (
      'cannot declare both "on" and "schedule": event triggers and ' +
      'time triggers are mutually exclusive — pick exactly one.'
    );
  }

  // `on:` (when present) must be a non-empty string.
  if (hasOn) {
    if (typeof order.on !== 'string' || order.on.length === 0) {
      return `"on" must be a non-empty string, got ${describeValue(order.on)}.`;
    }
  }

  // `schedule:` (when present) must be a non-empty string AND must
  // parse-check via the shared schedule parser (D17). Surfacing the
  // parser's structured error verbatim keeps the operator-facing
  // message identical to what the runtime would say if it tried to
  // evaluate the expression on first fire.
  if (hasSchedule) {
    if (typeof order.schedule !== 'string' || order.schedule.length === 0) {
      return `"schedule" must be a non-empty string, got ${describeValue(
        order.schedule,
      )}.`;
    }
    const parsed = parseSchedule(order.schedule);
    if (!parsed.ok) {
      return `"schedule" is invalid: ${parsed.error}`;
    }
  }

  // `run:` must be a non-empty string.
  if (!('run' in order)) {
    return 'missing required field "run" (the relay name to invoke).';
  }
  if (typeof order.run !== 'string' || order.run.length === 0) {
    return `"run" must be a non-empty string, got ${describeValue(order.run)}.`;
  }

  // `with:` is optional, but if present must be a plain object (D7).
  if ('with' in order && order.with !== undefined) {
    if (!isPlainObject(order.with)) {
      return `"with" must be a plain object when present, got ${describeValue(
        order.with,
      )}.`;
    }
  }

  return null;
}
