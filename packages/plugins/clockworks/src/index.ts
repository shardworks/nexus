/**
 * @shardworks/clockworks-apparatus — The Clockworks.
 *
 * Skeleton for Pillar 5: event substrate and standing-order engine.
 * This package currently only declares books, publishes the shared
 * type surface, and claims the `nsg clock` CLI namespace. Runtime
 * behavior (emission, dispatch, the relay SDK, the runner, CDC
 * auto-wiring, the daemon) arrives in later commissions.
 *
 * See: docs/architecture/clockworks.md
 */

import { createClockworks } from './clockworks.ts';

export {
  type ClockworksApi,
  type ClockworksConfig,
  type ClockworksKit,
  type EventDeclaration,
  type EventDispatchDoc,
  type EventDoc,
  type StandingOrder,
} from './types.ts';

// Relay authoring SDK — the public contract third-party kits use to
// contribute relay handlers under the `relays` kit type.
export {
  isRelayDefinition,
  relay,
  type GuildEvent,
  type RelayContext,
  type RelayDefinition,
} from './relay.ts';

export { createClockworks } from './clockworks.ts';

// Re-export the tools so integration tests (and scripted surfaces that
// run them programmatically) can import them without reaching into the
// package's internals.
export { clockList, clockStatus, signal } from './tools/index.ts';

// Re-export the shared signal validator so the framework CLI's
// hand-written `nsg signal` command can call the exact same three-layer
// validation path as the anima-facing tool.
export {
  RESERVED_EVENT_NAMESPACES,
  WRIT_LIFECYCLE_SUFFIXES,
  validateSignal,
} from './signal-validator.ts';

export default createClockworks();
