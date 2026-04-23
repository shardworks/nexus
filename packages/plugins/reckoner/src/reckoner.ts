/**
 * The Reckoner — observer that emits Lattice pulses when commissions stall,
 * fail, or when the guild's work queue drains.
 *
 * A Phase 2 CDC watcher on `clerk/writs`. No persistent state, no config.
 * Install = on; uninstall = off.
 *
 * Three trigger types (D24):
 *
 *   - `reckoner.writ-stuck`  — a root writ enters `stuck` and the stuck
 *     is terminal non-success (clockworks-retry will not requeue it).
 *   - `reckoner.writ-failed` — a root writ enters `failed`.
 *   - `reckoner.queue-drained` — after any terminal writ transition, the
 *     queue has 0 `open` writs and 0 active rigs.
 *
 * Roots-only (D23): non-root writs never emit stuck/failed pulses; leaf
 * cause information is surfaced through the parent's
 * Clerk-cascaded resolution (parsed via `parseChildFailures`).
 *
 * Soft clockworks-retry dependency (D16): the retry cap is resolved at
 * emit time via `guild().apparatus<ClockworksRetryApi>('clockworks-retry')`.
 * When absent every stuck is terminal from the Reckoner's viewpoint.
 *
 * See: docs/architecture/apparatus/reckoner.md
 */

import type { Plugin, StartupContext } from '@shardworks/nexus-core';
import { guild } from '@shardworks/nexus-core';
import type { ReadOnlyBook, StacksApi } from '@shardworks/stacks-apparatus';
import type { WritDoc } from '@shardworks/clerk-apparatus';
import type { LatticeApi } from '@shardworks/lattice-apparatus';

import { isQueueDrained } from './drain.ts';
import {
  type SpiderStuckStatus,
  isTerminalStuck,
  parseChildFailures,
  writShortId,
} from './predicates.ts';
import {
  RECKONER_PLUGIN_ID,
  TRIGGER_QUEUE_DRAINED,
  TRIGGER_WRIT_FAILED,
  TRIGGER_WRIT_STUCK,
  type QueueDrainedContext,
  type ReckonerApi,
  type WritFailedContext,
  type WritStuckContext,
} from './types.ts';

/**
 * Minimal shape of the clockworks-retry API surface the Reckoner reads.
 * Re-declared locally so we do not force a hard dependency on
 * `@shardworks/clockworks-retry-apparatus` just to read one field.
 */
interface MaxAttemptsApi {
  readonly maxAttempts: number;
}

/**
 * Minimal shape of a Spider rig row — only `writId` and `status` are read.
 * Declared locally to avoid a hard Spider dependency.
 */
interface RigRow extends Record<string, unknown> {
  id: string;
  writId: string;
  status: string;
}

/** Resolve the clockworks-retry cap, or undefined if not installed. */
function resolveMaxAttempts(): number | undefined {
  try {
    const api = guild().apparatus<MaxAttemptsApi>('clockworks-retry');
    return api?.maxAttempts;
  } catch {
    return undefined;
  }
}

export function createReckoner(): Plugin {
  const triggerTypes = [
    TRIGGER_WRIT_STUCK,
    TRIGGER_WRIT_FAILED,
    TRIGGER_QUEUE_DRAINED,
  ] as const;

  const api: ReckonerApi = {
    source: RECKONER_PLUGIN_ID,
    triggerTypes: [...triggerTypes],
  };

  return {
    apparatus: {
      // Lattice and Clerk are hard requires — without them the Reckoner
      // has nothing to observe or nowhere to emit. Spider and
      // clockworks-retry are soft dependencies: Spider owns the rigs
      // book the Reckoner reads for retry-cap and drain evaluation;
      // clockworks-retry owns the cap constant. Both degrade gracefully:
      // no Spider → no rigs book → rigs counts return 0; no
      // clockworks-retry → maxAttempts is undefined → every stuck is
      // terminal from the Reckoner's viewpoint.
      requires: ['clerk', 'lattice', 'stacks'],
      recommends: ['spider', 'clockworks-retry', 'oculus'],

      provides: api,

      async start(_ctx: StartupContext): Promise<void> {
        const g = guild();
        const stacks = g.apparatus<StacksApi>('stacks');
        const lattice = g.apparatus<LatticeApi>('lattice');

        // Read-only handles. Spider's rigs book may not exist if Spider
        // is not installed — readBook still returns a valid handle but
        // find/count calls on it resolve to empty/zero. That is the
        // intended degradation path.
        const writsBook: ReadOnlyBook<WritDoc> = stacks.readBook<WritDoc>('clerk', 'writs');
        const rigsBook: ReadOnlyBook<RigRow> = stacks.readBook<RigRow>('spider', 'rigs');

        // Build and emit a stuck pulse for `writ`.
        async function emitStuck(writ: WritDoc): Promise<void> {
          const spiderStatus = writ.status?.spider as SpiderStuckStatus | undefined;
          const context: WritStuckContext = {
            writShortId: writShortId(writ.id),
            writPhase: 'stuck',
            writTitle: writ.title,
            writType: writ.type,
            ...(typeof spiderStatus?.stuckCause === 'string' ? { stuckCause: spiderStatus.stuckCause } : {}),
            ...(typeof spiderStatus?.retryable === 'boolean' ? { retryable: spiderStatus.retryable } : {}),
            ...(typeof spiderStatus?.detail === 'string' ? { detail: spiderStatus.detail } : {}),
          };
          const title = `Writ stuck: ${writ.title}`;
          const summaryParts: string[] = [
            `${writShortId(writ.id)} ("${writ.title}") is stuck.`,
          ];
          if (spiderStatus?.stuckCause) {
            summaryParts.push(`Cause: ${spiderStatus.stuckCause}.`);
          }
          if (spiderStatus?.detail) {
            summaryParts.push(`Detail: ${spiderStatus.detail}`);
          }
          const leafFailures = parseChildFailures(writ.resolution);
          if (leafFailures.length > 0) {
            summaryParts.push(
              `Originated from child ${leafFailures.map(writShortId).join(', ')}.`,
            );
          }
          await lattice.emit({
            source: RECKONER_PLUGIN_ID,
            triggerType: TRIGGER_WRIT_STUCK,
            writId: writ.id,
            title,
            summary: summaryParts.join(' '),
            linkUrl: null,
            context: context as unknown as Record<string, unknown>,
          });
        }

        // Build and emit a failed pulse for `writ`.
        async function emitFailed(writ: WritDoc): Promise<void> {
          const childFailures = parseChildFailures(writ.resolution);
          const context: WritFailedContext = {
            writShortId: writShortId(writ.id),
            writTitle: writ.title,
            writType: writ.type,
            ...(typeof writ.resolution === 'string' ? { resolution: writ.resolution } : {}),
            ...(childFailures.length > 0
              ? { childFailures: childFailures.map(writShortId) }
              : {}),
          };
          const title = `Writ failed: ${writ.title}`;
          const summaryParts: string[] = [
            `${writShortId(writ.id)} ("${writ.title}") failed.`,
          ];
          if (writ.resolution) {
            summaryParts.push(`Resolution: ${writ.resolution}`);
          }
          await lattice.emit({
            source: RECKONER_PLUGIN_ID,
            triggerType: TRIGGER_WRIT_FAILED,
            writId: writ.id,
            title,
            summary: summaryParts.join(' '),
            linkUrl: null,
            context: context as unknown as Record<string, unknown>,
          });
        }

        async function emitDrained(lastTerminal: WritDoc): Promise<void> {
          const now = new Date().toISOString();
          const context: QueueDrainedContext = {
            drainedAt: now,
            lastTerminalWritId: lastTerminal.id,
          };
          const title = 'Queue drained';
          const summary = `Queue drained after ${writShortId(lastTerminal.id)} ("${lastTerminal.title}") reached a terminal state.`;
          await lattice.emit({
            source: RECKONER_PLUGIN_ID,
            triggerType: TRIGGER_QUEUE_DRAINED,
            writId: null,
            title,
            summary,
            linkUrl: null,
            context: context as unknown as Record<string, unknown>,
          });
        }

        // ── Observer ────────────────────────────────────────────

        stacks.watch<WritDoc>(
          'clerk',
          'writs',
          async (event) => {
            // Only react to phase transitions on existing writs.
            if (event.type !== 'update') return;
            const writ = event.entry;
            const prev = event.prev;
            if (writ.phase === prev.phase) return;

            const enteredStuck = writ.phase === 'stuck' && prev.phase !== 'stuck';
            const enteredFailed = writ.phase === 'failed' && prev.phase !== 'failed';
            const enteredTerminal =
              writ.phase === 'completed' ||
              writ.phase === 'failed' ||
              writ.phase === 'cancelled';

            // Roots-only gate for the per-writ pulses. Children never emit
            // their own stuck/failed pulses — their cause surfaces in the
            // parent's resolution.
            const isRoot = !writ.parentId;

            if (isRoot && enteredStuck) {
              const spiderStatus = writ.status?.spider as SpiderStuckStatus | undefined;
              const maxAttempts = resolveMaxAttempts();
              const rigCount = await rigsBook.count([['writId', '=', writ.id]]);
              if (isTerminalStuck(spiderStatus, rigCount, maxAttempts)) {
                await emitStuck(writ);
              }
            }

            if (isRoot && enteredFailed) {
              await emitFailed(writ);
            }

            // Drain check runs after every terminal transition — even
            // non-root ones. The drain predicate is independent of the
            // roots-only gate.
            if (enteredTerminal) {
              const drained = await isQueueDrained(writsBook, rigsBook);
              if (drained) {
                await emitDrained(writ);
              }
            }
          },
          { failOnError: false },
        );
      },
    },
  };
}
