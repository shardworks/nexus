/**
 * @shardworks/loom — The Loom.
 *
 * Session context composition: weaves system prompts, initial prompts,
 * and (eventually) role instructions, curricula, and temperaments into
 * a WovenContext that The Animator can consume.
 *
 * See: docs/architecture/apparatus/loom.md
 */

// ── Loom API ─────────────────────────────────────────────────────────

export {
  type LoomApi,
  type WeaveRequest,
  type WovenContext,
  createLoom,
} from './loom.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

import { createLoom } from './loom.ts';
export default createLoom();
