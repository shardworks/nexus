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
  type LoomConfig,
  type RoleDefinition,
  createLoom,
} from './loom.ts';

// ── GuildConfig augmentation ────────────────────────────────────────

// Augment GuildConfig so `guild().guildConfig().loom` is typed without
// requiring a manual type parameter at the call site.
import type { LoomConfig } from './loom.ts';
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    loom?: LoomConfig;
  }
}

// ── Default export: the apparatus plugin ──────────────────────────────

export default createLoom();
