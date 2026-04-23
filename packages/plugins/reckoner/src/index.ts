/**
 * @shardworks/reckoner-apparatus — The Reckoner.
 *
 * A Phase 2 CDC observer on `clerk/writs` that emits Lattice pulses when
 * commissions stall, fail, or when the guild's work queue drains.
 *
 * See: docs/architecture/apparatus/reckoner.md
 */

import { createReckoner } from './reckoner.ts';

export {
  type QueueDrainedContext,
  type ReckonerApi,
  type WritFailedContext,
  type WritStuckContext,
  RECKONER_PLUGIN_ID,
  TRIGGER_QUEUE_DRAINED,
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
} from './types.ts';

export { createReckoner } from './reckoner.ts';

export default createReckoner();
