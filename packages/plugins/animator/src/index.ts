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
  // Provider types (for implementors)
  type AnimatorSessionProvider,
  type SessionProviderConfig,
  type SessionProviderResult,
} from './types.ts';

export { createAnimator } from './animator.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createAnimator();
