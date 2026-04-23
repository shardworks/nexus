/**
 * @shardworks/lattice-apparatus — The Lattice.
 *
 * Notification substrate for the guild: owns the `lattice/pulses` book,
 * exposes a small `LatticeApi` for emitters, consumes a `latticeChannels`
 * kit contribution type (channel factories), and dispatches pulses via a
 * Phase 2 CDC watcher.
 *
 * See: docs/architecture/apparatus/lattice.md
 */

import { createLattice } from './lattice.ts';

export {
  type DeliveryOutcome,
  type EmitPulseRequest,
  type LatticeApi,
  type LatticeChannel,
  type LatticeChannelFactory,
  type LatticeChannelInstanceConfig,
  type LatticeConfig,
  type LatticeKit,
  type PulseDeliveryState,
  type PulseDoc,
  type PulseFilters,
} from './types.ts';

export { createLattice } from './lattice.ts';

// Re-export the CLI tools so integration tests (and any downstream
// surface that wants to run them programmatically) can import them
// without reaching into the package's internals.
export { pulseList, pulseShow } from './tools/index.ts';

export default createLattice();
