/**
 * @shardworks/sentinel-apparatus — The Sentinel.
 *
 * A Phase 2 CDC observer on `clerk/writs` that emits Lattice pulses when
 * commissions stall, fail, or when the guild's work queue drains.
 *
 * Historical artefacts in this source still carry the literal string
 * `'reckoner'` (`RECKONER_PLUGIN_ID`, the `reckoner.writ-stuck` /
 * `reckoner.writ-failed` / `reckoner.queue-drained` trigger ids) because
 * those strings are baked into Lattice channel configurations and on-
 * disk pulse rows. Renaming them is deferred to a separate scoped
 * commission.
 *
 * See: docs/architecture/apparatus/sentinel.md
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
