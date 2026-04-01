/**
 * @shardworks/loom-apparatus — The Loom.
 *
 * Session context composition: weaves role instructions, curricula, and
 * temperaments into an AnimaWeave that The Animator can consume to
 * launch AI sessions.
 *
 * See: docs/specification.md (loom)
 */

import { createLoom } from './loom.ts';

// ── Loom API ─────────────────────────────────────────────────────────

export {
  type LoomApi,
  type WeaveRequest,
  type AnimaWeave,
  createLoom,
} from './loom.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createLoom();
