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

export { createClockworks } from './clockworks.ts';

// Re-export the CLI stub tools so integration tests (and scripted
// surfaces that run them programmatically) can import them without
// reaching into the package's internals.
export { clockList, clockStatus } from './tools/index.ts';

export default createClockworks();
