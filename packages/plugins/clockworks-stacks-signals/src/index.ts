/**
 * @shardworks/clockworks-stacks-signals-apparatus —
 * The Clockworks↔Stacks signals bridge.
 *
 * Translates Stacks change-data-capture (CDC) row mutations into
 * Clockworks `book.<ownerId>.<book>.<verb>` events. The bridge is the
 * canonical home for the cross-plugin observer-translator pattern;
 * Clockworks does not reach into Stacks at startup.
 *
 * See: README.md
 */

export { createClockworksStacksSignals } from './clockworks-stacks-signals.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createClockworksStacksSignals } from './clockworks-stacks-signals.ts';
export default createClockworksStacksSignals();
