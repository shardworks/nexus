/**
 * Engine-failure context resolver — looks up the failed-engine details for
 * a `reckoner.writ-failed` pulse so the patron can see *which* engine
 * exhausted its retry budget without dropping into `nsg rig show`.
 *
 * The resolver is a pure function over the rigs book + a writ id. It is
 * called from the writ-failed emit path after the dedupe guard and before
 * the `lattice.emit()` call. When the lookup finds a rig in `failed`
 * status with at least one engine in `failed` status, it returns the
 * `EngineFailureContext` block that the emit path attaches to the pulse's
 * context. Otherwise it returns `undefined` and the pulse emits with the
 * existing legacy shape.
 *
 * The resolver lives in its own module — mirroring the predicate factoring
 * convention — so the lookup branches can be unit-tested without standing
 * up the full Phase 2 observer.
 *
 * Spider is *not* imported from. Engine-side row shapes are re-declared
 * locally on the consumer (see `RigRow` / `EngineInstance` / `EngineAttempt`
 * in `reckoner.ts`); this module accepts a narrowly-typed read handle so
 * the dependency direction stays one-way.
 */

import type { ReadOnlyBook } from '@shardworks/stacks-apparatus';

import type {
  EngineAttemptSummary,
  EngineFailureContext,
} from './types.ts';

/**
 * Local re-declaration of the per-attempt row this resolver reads. Mirrors
 * Spider's `EngineAttempt` narrowly; every field is optional so an
 * in-flight or shape-evolving entry round-trips without erroring.
 */
interface EngineAttemptRow {
  startedAt?: string;
  endedAt?: string;
  status?: 'completed' | 'failed';
  error?: string;
  sessionId?: string;
  yields?: unknown;
}

/**
 * Local re-declaration of the engine-instance row this resolver reads.
 * Captures only the fields the resolver scans (id, designId, status,
 * retry counter, attempts history).
 */
interface EngineInstanceRow {
  id: string;
  designId: string;
  status: string;
  attemptCount?: number;
  attempts?: EngineAttemptRow[];
}

/**
 * Local re-declaration of the rig row this resolver reads. Index signature
 * keeps the row compatible with the `BookEntry` constraint required by
 * `ReadOnlyBook`.
 */
interface RigRow extends Record<string, unknown> {
  id: string;
  writId: string;
  status: string;
  createdAt?: string;
  engines?: EngineInstanceRow[];
}

/**
 * Build the `attemptsSummary` array from an engine's `attempts[]`,
 * dropping the `yields` payload (D7). Each summary entry copies only the
 * scalar diagnostic fields. Returns an empty array when the source is
 * absent or empty so callers can rely on a stable array type.
 */
function summarizeAttempts(
  attempts: EngineAttemptRow[] | undefined,
): EngineAttemptSummary[] {
  if (!attempts || attempts.length === 0) return [];
  return attempts.map((a) => {
    const entry: EngineAttemptSummary = {};
    if (typeof a.startedAt === 'string') entry.startedAt = a.startedAt;
    if (typeof a.endedAt === 'string') entry.endedAt = a.endedAt;
    if (a.status === 'completed' || a.status === 'failed') entry.status = a.status;
    if (typeof a.error === 'string') entry.error = a.error;
    if (typeof a.sessionId === 'string') entry.sessionId = a.sessionId;
    return entry;
  });
}

/**
 * Resolve engine-failure context for a writ that just entered `failed`.
 *
 * Lookup steps:
 *
 *   1. Find the most-recent `failed` rig for this writ (latest by
 *      `createdAt desc`, limit 1). The post-reshape model is one rig
 *      per writ; the `desc + limit 1` tolerates legacy multi-rig writs
 *      and writs whose rig was respawned.
 *   2. Scan that rig's `engines` array for the first engine in
 *      `status === 'failed'`. Spider's behavior produces a single failed
 *      engine per rig, but the resolver picks the first explicitly so
 *      multi-failed-engine futures don't change the contract.
 *   3. Build the `EngineFailureContext` from the engine's identity, retry
 *      counter, latest-attempt error, and per-attempt summary.
 *
 * Returns `undefined` when no rig is found, no rig has `status='failed'`,
 * or no engine in the rig has `status='failed'`. The writ-failed pulse is
 * emitted with the existing legacy shape in that case (D5).
 *
 * The resolver never throws — it catches book-read errors and returns
 * `undefined` so a transient backend hiccup doesn't break pulse emission
 * (`failOnError: false` semantics on the Phase 2 watcher).
 */
export async function resolveEngineFailureContext(
  rigsBook: ReadOnlyBook<RigRow>,
  writId: string,
): Promise<EngineFailureContext | undefined> {
  let rig: RigRow | undefined;
  try {
    const candidates = await rigsBook.find({
      where: [
        ['writId', '=', writId],
        ['status', '=', 'failed'],
      ],
      orderBy: ['createdAt', 'desc'],
      limit: 1,
    });
    rig = candidates[0];
  } catch {
    return undefined;
  }

  if (!rig) return undefined;

  const engines = rig.engines;
  if (!engines || engines.length === 0) return undefined;

  const failedEngine = engines.find((e) => e.status === 'failed');
  if (!failedEngine) return undefined;

  const tail = failedEngine.attempts?.[failedEngine.attempts.length - 1];
  const lastError =
    tail && typeof tail.error === 'string' ? tail.error : undefined;

  const context: EngineFailureContext = {
    rigId: rig.id,
    engineId: failedEngine.id,
    engineDesignId: failedEngine.designId,
    attemptsSummary: summarizeAttempts(failedEngine.attempts),
  };
  if (typeof failedEngine.attemptCount === 'number') {
    context.attemptCount = failedEngine.attemptCount;
  }
  if (lastError !== undefined) {
    context.lastError = lastError;
  }
  return context;
}
