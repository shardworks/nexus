/**
 * @shardworks/loom-apparatus — The Loom.
 *
 * Session context composition: weaves system prompts, initial prompts,
 * and (eventually) role instructions, curricula, and temperaments into
 * a WovenContext that The Animator can consume.
 *
 * See: docs/specification.md (loom)
 */

import { createLoom } from './loom.ts';

// ── Loom API ─────────────────────────────────────────────────────────

export {
  type LoomApi,
  type WeaveRequest,
  type WovenContext,
  createLoom,
} from './loom.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createLoom();
