/**
 * Clockworks public types.
 *
 * All types exported from `@shardworks/clockworks-apparatus`.
 *
 * The Clockworks is the guild's event substrate (Pillar 5). It declares
 * events, accepts emissions into the `clockworks/events` book, and —
 * once runtime behavior lands in later commissions — dispatches each
 * event to every matching standing order, recording one
 * `clockworks/event_dispatches` document per handler invocation.
 *
 * This commission ships the type surface and the module augmentation
 * only. The apparatus factory and the CLI stubs live next to it; the
 * runtime (emit, dispatch, runner, CDC auto-wiring, daemon) arrives in
 * later commissions.
 */

// The explicit import anchors this file to `@shardworks/nexus-core` so
// TypeScript treats the `declare module` block below as an
// external-module augmentation (vs. a global augmentation). Without at
// least one import from the target module TS2664 fires at compile time.
import type {} from '@shardworks/nexus-core';
import type { BookEntry } from '@shardworks/stacks-apparatus';

// ── Config ───────────────────────────────────────────────────────────

/**
 * A custom event declaration in `guild.json` under `clockworks.events`.
 *
 * Framework events (e.g. `writ.stuck`, `session.end`) are declared by
 * the plugins that produce them; only operator-defined events need to
 * appear here.
 */
export interface EventDeclaration {
  /** Human-readable description of what this event means. */
  description?: string;
  /** Optional payload schema hint (not enforced in Phase 1). */
  schema?: Record<string, string>;
}

/**
 * A standing order — a registered response to an event.
 *
 * An order has one `on` field (the event name it listens for) and
 * exactly one action field:
 *   - `run`   — the name of a relay (registered tool-like handler).
 *   - `summon` — a role id; the Clockworks asks the Loom to open a
 *     session in that role, optionally with the given `prompt`.
 *   - `brief` — the path to a brief file; the Clockworks commissions a
 *     writ from it.
 */
export type StandingOrder =
  | { on: string; run: string }
  | { on: string; summon: string; prompt?: string }
  | { on: string; brief: string };

/**
 * The Clockworks configuration block in `guild.json` under the
 * `clockworks` key.
 */
export interface ClockworksConfig {
  /** Custom event declarations keyed by event name. */
  events?: Record<string, EventDeclaration>;
  /** Standing orders — event → action mappings. */
  standingOrders?: StandingOrder[];
}

// Augment GuildConfig so `guild().guildConfig().clockworks` is typed
// without requiring a manual type parameter at the call site. Every
// sibling apparatus owns its own config shape this way.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    clockworks?: ClockworksConfig;
  }
}

// ── Book documents ───────────────────────────────────────────────────

// Id schemes for this apparatus's two books, mirroring the
// `generateId`-produced shape used by pulses and writs. Events use
// `e-<base36_ts>-<hex>`; dispatches use `d-<base36_ts>-<hex>`.

/**
 * One document per emission into `clockworks/events`.
 *
 * The Clockworks itself assigns the id, records the emitter and fire
 * time, and — once runtime behavior lands — flips `processed` to true
 * after every matching standing order has been dispatched (or found to
 * have no match).
 */
export interface EventDoc extends BookEntry {
  /** Unique event id (`e-<base36_ts>-<hex>`). Sortable by creation time. */
  id: string;
  /**
   * Event name — framework events use `{pluginId}.{kebab-suffix}`
   * (e.g. `clerk.writ-stuck`); operator-defined events follow the same
   * grammar.
   */
  name: string;
  /**
   * Structured payload. Shape is keyed by event name; the Clockworks
   * does not enforce a schema in Phase 1.
   */
  payload: unknown;
  /** Plugin id of the emitter that produced this event. */
  emitter: string;
  /** ISO timestamp when the event was emitted. */
  firedAt: string;
  /**
   * Whether every matching standing order has been dispatched. The
   * runner flips this to true after dispatch; the CDC auto-wiring task
   * will rely on it to filter the work queue.
   */
  processed: boolean;
}

/**
 * One document per handler invocation triggered by an event, stored
 * in `clockworks/event_dispatches`.
 *
 * Each standing order that matches an event produces exactly one
 * dispatch row; the row carries its own lifecycle from `pending` to
 * `success` or `error` as the runner works through it.
 */
export interface EventDispatchDoc extends BookEntry {
  /** Unique dispatch id (`d-<base36_ts>-<hex>`). */
  id: string;
  /** Id of the event that produced this dispatch (foreign key into `events`). */
  eventId: string;
  /** Whether this dispatch runs a relay or summons an anima session. */
  handlerType: 'relay' | 'anima';
  /**
   * Name of the handler — relay name for `handlerType: 'relay'`,
   * role id for `handlerType: 'anima'`.
   */
  handlerName: string;
  /**
   * For `handlerType: 'anima'`, the role id the session is opened in.
   * Always null for `handlerType: 'relay'`.
   */
  targetRole: string | null;
  /**
   * Emitted pulse kind, if the dispatcher raised a notice (e.g. a
   * summon invitation). Null when the dispatcher did not emit a pulse.
   */
  noticeType: 'summon' | null;
  /** ISO timestamp when handler execution began, or null while pending. */
  startedAt: string | null;
  /** ISO timestamp when handler execution ended, or null if still pending. */
  endedAt: string | null;
  /** Lifecycle state of this dispatch. */
  status: 'pending' | 'success' | 'error';
  /** Error text when `status === 'error'`, null otherwise. */
  error: string | null;
}

// ── API & Kit ────────────────────────────────────────────────────────

/**
 * The Clockworks' runtime API — retrieved via
 * `guild().apparatus<ClockworksApi>('clockworks')`.
 *
 * The only write path in this commission is `emit()`. The dispatcher,
 * runner, standing-order engine, and CDC auto-wiring arrive in later
 * commissions and will extend this surface as needed.
 */
export interface ClockworksApi {
  /**
   * Persist an event into the `clockworks/events` book and return the
   * generated event id.
   *
   * The Clockworks eagerly attempts `JSON.stringify` on the payload
   * before writing so non-serializable values (circular references,
   * `BigInt`, functions, …) are surfaced as a descriptive error at the
   * API boundary rather than as an opaque failure inside the Stacks
   * persistence layer. An `undefined` payload is coerced to `null` so
   * the stored row shape stays predictable.
   *
   * @param name    Event name — framework events use `{pluginId}.{suffix}`;
   *                operator-defined events follow the same grammar.
   * @param payload JSON-serializable payload, or `null`/`undefined`.
   * @param emitter Identifier of the caller that produced this event —
   *                plugin id, anima name, `'framework'`, `'operator'`, etc.
   * @returns       The generated event id (`e-<base36_ts>-<hex>`).
   * @throws        When `payload` cannot be JSON-serialized.
   */
  emit(name: string, payload: unknown, emitter: string): Promise<string>;
}

/**
 * Kit contribution interface for plugins that extend the Clockworks.
 *
 * Intentionally empty in this commission. Task 2 (the relay SDK) owns
 * the `relays` contribution shape.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClockworksKit {}
