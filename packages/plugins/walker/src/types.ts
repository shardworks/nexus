/**
 * The Walker — public types.
 *
 * Rig and engine data model, WalkResult, WalkerApi, and configuration.
 * Engine yield shapes (DraftYields, SealYields) live here too so downstream
 * packages can import them without depending on the engine implementation files.
 */

// ── Engine instance status ────────────────────────────────────────────

export type EngineStatus = 'pending' | 'running' | 'completed' | 'failed';

// ── Engine instance ───────────────────────────────────────────────────

/**
 * A single engine slot within a rig.
 *
 * `id` is the engine's position identifier (e.g. 'draft', 'implement').
 * For the static pipeline it matches `designId`.
 *
 * `givensSpec` holds literal values set at spawn time (writ, role, commands).
 * The Walker assembles `givens` from this directly; upstream yields arrive
 * via `context.upstream` as the escape hatch.
 */
export interface EngineInstance {
  /** Unique identifier within the rig (e.g. 'draft', 'implement'). */
  id: string;
  /** The engine design to look up in the Fabricator. */
  designId: string;
  /** Current execution status. */
  status: EngineStatus;
  /** Engine IDs that must be completed before this engine can run. */
  upstream: string[];
  /** Literal givens values set at rig spawn time. */
  givensSpec: Record<string, unknown>;
  /** Yields from a completed engine run (JSON-serializable). */
  yields?: unknown;
  /** Error message if this engine failed. */
  error?: string;
  /** Session ID from a launched quick engine, used by the collect step. */
  sessionId?: string;
  /** ISO timestamp when execution started. */
  startedAt?: string;
  /** ISO timestamp when execution completed (or failed). */
  completedAt?: string;
}

// ── Rig ──────────────────────────────────────────────────────────────

export type RigStatus = 'running' | 'completed' | 'failed';

/**
 * A rig — the execution context for a single writ.
 *
 * Stored in The Stacks (`walker/rigs` book). The `engines` array is the
 * ordered pipeline of engine instances. The Walker updates this document
 * in-place as engines run and complete.
 */
export interface RigDoc {
  /** Index signature required to satisfy BookEntry constraint. */
  [key: string]: unknown;
  /** Unique rig id. */
  id: string;
  /** The writ this rig is executing. */
  writId: string;
  /** Current rig status. */
  status: RigStatus;
  /** Ordered engine pipeline. */
  engines: EngineInstance[];
}

// ── WalkResult ────────────────────────────────────────────────────────

/**
 * The result of a single walk() call.
 *
 * Four variants, ordered by priority:
 * - 'collected'  — collected a running engine's terminal session result
 * - 'ran'        — ran a clockwork engine to completion inline
 * - 'launched'   — launched a quick engine's session
 * - 'spawned'    — created a new rig for a ready writ
 *
 * null means no work was available.
 */
export type WalkResult =
  | { type: 'collected'; rigId: string; engineId: string }
  | { type: 'ran'; rigId: string; engineId: string }
  | { type: 'launched'; rigId: string; engineId: string }
  | { type: 'spawned'; rigId: string; writId: string };

// ── WalkerApi ─────────────────────────────────────────────────────────

/**
 * The Walker's public API — retrieved via guild().apparatus<WalkerApi>('walker').
 */
export interface WalkerApi {
  /**
   * Execute one step of the walk loop.
   *
   * Priority ordering: collect > run > spawn.
   * Returns null when no work is available.
   */
  walk(): Promise<WalkResult | null>;
}

// ── Configuration ─────────────────────────────────────────────────────

/**
 * Walker apparatus configuration — lives under the `walker` key in guild.json.
 */
export interface WalkerConfig {
  /**
   * Role to summon for quick engine sessions.
   * Default: 'artificer'.
   */
  role?: string;
  /**
   * Polling interval for walkContinual tool (milliseconds).
   * Default: 5000.
   */
  pollIntervalMs?: number;
  /**
   * Build command to pass to quick engines.
   */
  buildCommand?: string;
  /**
   * Test command to pass to quick engines.
   */
  testCommand?: string;
}

// ── Engine yield shapes ───────────────────────────────────────────────

/**
 * Yields from the `draft` clockwork engine.
 * The Walker stores these in the engine instance and passes them
 * to downstream engines via context.upstream['draft'].
 */
export interface DraftYields {
  /** The draft's unique id. */
  draftId: string;
  /** Codex this draft belongs to. */
  codexName: string;
  /** Git branch name for the draft. */
  branch: string;
  /** Absolute filesystem path to the draft's worktree. */
  path: string;
}

/**
 * Yields from the `seal` clockwork engine.
 */
export interface SealYields {
  /** The commit SHA at head of the target branch after sealing. */
  sealedCommit: string;
  /** Git strategy used. */
  strategy: 'fast-forward' | 'rebase';
  /** Number of retry attempts. */
  retries: number;
  /** Number of inscriptions (commits) sealed. */
  inscriptionsSealed: number;
}

// Augment GuildConfig so `guild().guildConfig().walker` is typed.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    walker?: WalkerConfig;
  }
}
