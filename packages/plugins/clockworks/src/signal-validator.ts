/**
 * Shared `signal` validator — used by both the anima-facing `signal`
 * tool and the hand-written `nsg signal` framework CLI command so both
 * surfaces reject the same set of event names with identical messages.
 *
 * The validator performs three checks, in order:
 *
 *   1. Reject any name whose prefix matches one of the seven catalogued
 *      reserved framework namespaces. Comparison is case-sensitive per
 *      commission decision D10.
 *   2. Reject any name matching a writ-lifecycle pattern —
 *      `<type>.{ready,completed,stuck,failed}` for every type returned
 *      by `ClerkApi.listWritTypes()` (D3). Suffix-only matching would
 *      over-reject custom events that legitimately end in those
 *      suffixes.
 *   3. Reject any name not declared under `clockworks.events` in
 *      `guild.json`.
 *
 * The validator throws plain `Error` instances with descriptive
 * messages (D7). It does not pre-check payload serializability —
 * `ClockworksApi.emit` owns that check (D11).
 */

/**
 * The seven reserved framework namespaces catalogued in
 * `docs/reference/core-api.md`'s `isFrameworkEvent` section. Writ
 * lifecycle events deliberately live outside this list; they are
 * handled by the separate writ-lifecycle check in
 * {@link validateSignal} so custom events can coexist with user-defined
 * writ types.
 */
export const RESERVED_EVENT_NAMESPACES: readonly string[] = Object.freeze([
  'anima.',
  'commission.',
  'tool.',
  'migration.',
  'guild.',
  'standing-order.',
  'session.',
]);

/**
 * The four lifecycle suffixes that the framework owns for every writ
 * type. Operators may declare arbitrary writ types, but the Clerk's
 * phase machine is the only authorized emitter of these events.
 */
export const WRIT_LIFECYCLE_SUFFIXES: readonly string[] = Object.freeze([
  'ready',
  'completed',
  'stuck',
  'failed',
]);

/**
 * Validate a proposed signal name against the three-layer rule set.
 *
 * @param name            The proposed event name.
 * @param declaredEvents  `guild.json` → `clockworks.events`. The keys
 *                        are the declared event names; values are
 *                        declaration metadata but only the key set is
 *                        consulted here.
 * @param writTypes       Every writ type name returned by
 *                        `ClerkApi.listWritTypes()`.
 * @throws Error with a descriptive message when validation fails.
 */
export function validateSignal(
  name: string,
  declaredEvents: Readonly<Record<string, unknown>>,
  writTypes: readonly string[],
): void {
  // Layer 1: reserved framework namespaces (case-sensitive per D10).
  for (const prefix of RESERVED_EVENT_NAMESPACES) {
    if (name.startsWith(prefix)) {
      throw new Error(
        `signal: "${name}" is in the reserved framework namespace "${prefix}" ` +
          `and cannot be emitted via the signal tool. Reserved namespaces are ` +
          `owned by the framework.`,
      );
    }
  }

  // Layer 2: writ-lifecycle patterns per declared writ type (D3).
  for (const writType of writTypes) {
    for (const suffix of WRIT_LIFECYCLE_SUFFIXES) {
      if (name === `${writType}.${suffix}`) {
        throw new Error(
          `signal: "${name}" matches the framework-owned writ-lifecycle ` +
            `pattern "<type>.${suffix}" for writ type "${writType}". ` +
            `Writ lifecycle events are emitted by the Clerk.`,
        );
      }
    }
  }

  // Layer 3: must be declared in guild.json `clockworks.events`.
  if (!Object.prototype.hasOwnProperty.call(declaredEvents, name)) {
    throw new Error(
      `signal: "${name}" is not declared in guild.json under ` +
        `clockworks.events. Declare the event (and a human-readable ` +
        `description) before emitting it.`,
    );
  }
}
