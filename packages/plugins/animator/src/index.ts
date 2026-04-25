/**
 * @shardworks/animator-apparatus — The Animator.
 *
 * Session launch and telemetry recording: takes an AnimaWeave from The Loom,
 * launches an AI process via a session provider, monitors it until exit, and
 * records the result to The Stacks.
 *
 * See: docs/specification.md (animator)
 */

import { createAnimator } from './animator.ts';

// ── Animator API ─────────────────────────────────────────────────────

export {
  type AnimatorApi,
  type AnimateHandle,
  type AnimateRequest,
  type SummonRequest,
  type SessionResult,
  type SessionChunk,
  type TokenUsage,
  type SessionCost,
  type SessionDoc,
  type AnimatorConfig,
  type AnimatorRateLimitConfig,
  type AnimatorRateLimitBackoffConfig,
  type AnimatorStatusDoc,
  type AnimatorPauseReason,
  type SessionTerminationTag,
  type TerminationDiagnostic,
  // Provider types (for implementors)
  type AnimatorSessionProvider,
  type SessionProviderConfig,
  type SessionProviderResult,
} from './types.ts';

export { createAnimator } from './animator.ts';

// ── Canonical dispatchability predicate ──────────────────────────────
// Re-exported so cross-plugin consumers (Spider's crawl gate, the
// `animator-paused` block-type, etc.) compose against a single source of
// truth instead of hand-rolling their own equivalent.
export { isDispatchable } from './rate-limit-backoff.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createAnimator();
