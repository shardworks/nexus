/**
 * @shardworks/dispatch-apparatus — The Dispatch.
 *
 * Interim work runner: finds the oldest ready writ and executes it through
 * the guild's session machinery. Opens a draft binding on the target codex,
 * summons an anima via The Animator, and handles the aftermath (seal the
 * draft, transition the writ). Disposable — retired when the full rigging
 * system (Walker, Fabricator, Executor) is implemented.
 *
 * See: docs/architecture/apparatus/dispatch.md
 */

import { createDispatch } from './dispatch.ts';

// ── Dispatch API ──────────────────────────────────────────────────────

export {
  type DispatchApi,
  type DispatchRequest,
  type DispatchResult,
} from './types.ts';

export { createDispatch } from './dispatch.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createDispatch();
