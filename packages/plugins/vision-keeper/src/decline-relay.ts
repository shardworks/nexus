/**
 * `vision-keeper-on-decline` — decline-feedback relay.
 *
 * Wired into the apparatus's `supportKit.relays` so any guild that
 * installs the Vision-keeper alongside the Clockworks can author a
 * standing order of the shape:
 *
 *   {
 *     "on": "book.clerk.writs.updated",
 *     "run": "vision-keeper-on-decline"
 *   }
 *
 * The relay's job in v0 is narrow: log a single line whenever a writ
 * sourced by `vision-keeper.snapshot` transitions into `cancelled`
 * (the framework's signal for "petition declined"). It does not
 * re-emit, it does not hand a callback back to the keeper, and it
 * does not surface a configuration block — operators do not put a
 * `with:` parameter block in the standing order (D25).
 *
 * The standing-order schema does not currently support a top-level
 * filter; every event matching `on:` reaches every relay registered
 * under that name. The handler therefore narrows the payload itself
 * (D13):
 *
 *   1. The CDC change must be an `update` (no creates / deletes —
 *      only updates can carry a phase transition).
 *   2. The previous phase must NOT be `cancelled` (already-cancelled
 *      writs that are merely patched do not represent a transition).
 *   3. The current phase must be `cancelled`.
 *   4. The entry's `ext.reckoner.source` must equal the keeper's
 *      source id.
 *
 * When all four hold, the handler emits a single log line carrying the
 * writId, source, and the entry's `resolution` (the decline reason).
 * Otherwise the handler returns silently — both for the unrelated-event
 * case and the re-invocation case (idempotency). The handler holds no
 * mutable state beyond the call, so re-invoking with the same payload
 * produces an identical observable side effect (one extra log line)
 * with no other consequences. The Clockworks dispatch sweep is
 * not atomic across processes; the relay-handler contract requires
 * idempotency in the "no extra writes" sense, which this handler
 * trivially satisfies.
 *
 * See: docs/architecture/petitioner-registration.md §9 (Channel-1
 * standing-order feedback).
 */

import type { GuildEvent, RelayDefinition } from '@shardworks/clockworks-apparatus';
import { relay } from '@shardworks/clockworks-apparatus';

import { DECLINE_RELAY_NAME, VISION_KEEPER_SOURCE } from './constants.ts';

// ── CDC payload shape (read-only, narrowed in-handler) ──────────────

/**
 * Minimal shape of the writ entry the relay reads off the CDC payload.
 *
 * Importing `WritDoc` from `@shardworks/clerk-apparatus` would work,
 * but the relay only consults four fields and depends on a tiny slice
 * of the writ shape — keeping a local structural type keeps the
 * handler's dependency surface narrow and immune to upstream additions
 * to `WritDoc`.
 */
interface WritsCdcEntry {
  id: string;
  phase: string;
  ext?: Record<string, unknown> | undefined;
  resolution?: string | undefined;
  [key: string]: unknown;
}

/**
 * The Stacks CDC `update` change shape, narrowed to the fields the
 * relay reads. Defined locally for the same reason as `WritsCdcEntry`.
 */
interface WritsCdcUpdateChange {
  type: 'create' | 'update' | 'delete';
  ownerId: string;
  book: string;
  entry: WritsCdcEntry;
  prev?: WritsCdcEntry | undefined;
  [key: string]: unknown;
}

/** Reckoner-owned `ext.reckoner` slot shape — only `.source` is read. */
interface ReckonerExtSlice {
  source?: string;
}

// ── Filter (D13) ────────────────────────────────────────────────────

/**
 * Narrow a CDC event to the precise "vision-keeper petition just
 * declined" shape the relay reacts to. Returns the matching entry on
 * success and `null` otherwise.
 *
 * Pulled out of the handler so unit tests can drive the predicate
 * directly with synthetic payloads — the tests for the v0 commission
 * cover three negative cases (unrelated update, other-source decline,
 * idempotency re-invocation) plus the matching case.
 */
export function matchVisionKeeperDecline(
  event: GuildEvent | null,
): WritsCdcEntry | null {
  if (!event) return null;
  const payload = event.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const change = payload as Partial<WritsCdcUpdateChange>;
  if (change.type !== 'update') return null;
  const entry = change.entry;
  if (!entry || typeof entry !== 'object') return null;
  const prev = change.prev;
  // Both phase fields must be strings to make the transition assertion
  // meaningful. A missing `prev` (legacy or malformed CDC payload) is
  // treated as "no transition recorded" and the relay returns silently.
  if (typeof entry.phase !== 'string' || entry.phase !== 'cancelled') {
    return null;
  }
  if (!prev || typeof prev !== 'object') return null;
  if (typeof prev.phase !== 'string' || prev.phase === 'cancelled') {
    return null;
  }
  // Source-prefix check (D13) — the keeper's source is the contract
  // anchor, not the owner-book pair. The standing order is wired on
  // `book.clerk.writs.updated`, so any CDC event reaching this handler
  // has already been narrowed to writs-book updates.
  const ext = entry.ext;
  if (!ext || typeof ext !== 'object') return null;
  const reckonerSlot = ext.reckoner as ReckonerExtSlice | undefined;
  if (!reckonerSlot || reckonerSlot.source !== VISION_KEEPER_SOURCE) {
    return null;
  }
  return entry;
}

// ── Relay factory ───────────────────────────────────────────────────

/**
 * Build the `vision-keeper-on-decline` `RelayDefinition`. Exported so
 * the apparatus boot path can wire it into `supportKit.relays`, and
 * so unit tests can drive the handler directly.
 */
export function createDeclineRelay(): RelayDefinition {
  return relay({
    name: DECLINE_RELAY_NAME,
    description:
      'Logs a line whenever a vision-keeper.snapshot writ transitions into cancelled.',
    handler: (event, _context) => {
      const entry = matchVisionKeeperDecline(event);
      if (entry === null) return;
      // Log-only: the brief hedges re-emit as "possibly", and the
      // post-decline "adjusted context" is undefined in v0 (D14). We
      // stick with a single line carrying the writId, source, and the
      // declining-side resolution string so an operator can find the
      // decline in their guild log without cross-referencing the
      // writs book.
      const reason = entry.resolution ?? '(no resolution recorded)';
      console.log(
        `[vision-keeper] decline-feedback: writ ${entry.id} (source=${VISION_KEEPER_SOURCE}) was declined — ${reason}`,
      );
    },
  });
}
