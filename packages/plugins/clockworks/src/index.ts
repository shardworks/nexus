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
  type RelayHandler,
} from './relay.ts';

// Stdlib `summon-relay` factory. Re-exported so unit tests and any
// downstream tooling that needs to drive the relay directly can pull it
// without reaching into the package's internals.
export { createSummonRelay } from './summon-relay.ts';

export { createClockworks } from './clockworks.ts';

// Re-export the tools so integration tests (and scripted surfaces that
// run them programmatically) can import them without reaching into the
// package's internals.
export { clockStatusTool, signal } from './tools/index.ts';

// Re-export the shared signal validator so the framework CLI's
// hand-written `nsg signal` command can call the exact same three-layer
// validation path as the anima-facing tool.
export {
  RESERVED_EVENT_NAMESPACES,
  WRIT_LIFECYCLE_SUFFIXES,
  validateSignal,
} from './signal-validator.ts';

// Re-export the standing-order validator so future config-write hooks,
// CLI linters, and other operator-facing surfaces can run the exact
// same load-time validation path as the dispatcher.
export {
  ALLOWED_STANDING_ORDER_KEYS,
  validateStandingOrders,
} from './standing-order-validator.ts';

// Daemon lifecycle — the unattended Clockworks daemon. Standalone
// functions on the apparatus's public surface (commission decision D1):
// `clockStart` / `clockStop` / `clockStatus` are the thin lifecycle
// helpers, `runForegroundDaemon` is the inline daemon body the
// detached spawn re-execs into, and `runForegroundDaemonFromGuild`
// is the convenience wrapper the CLI's `--foreground` handler calls.
export {
  clockStart,
  clockStatus,
  clockStop,
  formatDispatchLogLine,
  runForegroundDaemon,
  runForegroundDaemonFromGuild,
  validateInterval,
  type ClockStartOptions,
  type ClockStartResult,
  type ClockStatus,
  type ClockStopResult,
  type ForegroundDaemonInputs,
} from './daemon.ts';

export default createClockworks();
