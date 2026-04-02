/**
 * @shardworks/walker-apparatus — The Walker.
 *
 * Rig execution engine: spawns rigs for ready writs, drives engine pipelines
 * to completion, and transitions writs via the Clerk on rig completion/failure.
 *
 * Public types (RigDoc, EngineInstance, WalkResult, WalkerApi, etc.) are
 * re-exported for consumers that inspect walk results or rig state.
 */

import { createWalker } from './walker.ts';

// ── Public types ──────────────────────────────────────────────────────

export type {
  EngineStatus,
  EngineInstance,
  RigStatus,
  RigDoc,
  WalkResult,
  WalkerApi,
  WalkerConfig,
  DraftYields,
  SealYields,
} from './types.ts';

// ── Default export: the apparatus plugin ──────────────────────────────

export default createWalker();
