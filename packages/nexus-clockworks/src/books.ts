/**
 * Book schema declarations for the nexus-clockworks rig.
 *
 * Arbor reads these at startup and creates the backing SQLite tables
 * and indexes if they don't exist. Additive only — no destructive migrations.
 *
 * Table names (derived by arbor from rig ID + book name):
 *   events    → books_nexus_clockworks_events
 *   dispatches → books_nexus_clockworks_dispatches
 */

import type { BookOptions } from '@shardworks/nexus-core';

export const books: Record<string, BookOptions> = {
  /**
   * The event queue. Each document is an EventDoc.
   *
   * Query patterns:
   *   - pending events: where { processed: false }, order by firedAt asc
   *   - filter by name: where { name: '...' } or LIKE pattern (via listEvents)
   *   - filter by emitter: where { emitter: '...' }
   *   - get by id: direct get()
   */
  events: {
    indexes: ['name', 'emitter', 'processed', 'firedAt'],
  },

  /**
   * Dispatch records. Each document is a DispatchDoc.
   *
   * Query patterns:
   *   - dispatches for an event: where { eventId: '...' }
   *   - filter by handler: where { handlerType, handlerName }
   *   - filter by status: where { status: 'error' }
   */
  dispatches: {
    indexes: ['eventId', 'handlerType', 'handlerName', 'status'],
  },
};
