/**
 * Relay SDK — the primary authoring interface for event-handler relays.
 *
 * A relay is a named side-effect handler the Clockworks dispatches an
 * event to. Relays are contributed by kits under the `relays` contribution
 * type and resolved by the Clockworks at dispatch time via the standing
 * order's `run:` field.
 *
 * This module is pure plumbing — no dispatch, no invocation, no runtime
 * policy. Its job is to shape the authoring surface plugin authors use to
 * declare a relay and to give the Clockworks a structural type guard for
 * registration-time validation.
 *
 * @example
 * ```typescript
 * import { relay } from '@shardworks/clockworks-apparatus';
 *
 * export default [
 *   relay({
 *     name: 'log-event',
 *     description: 'Write the event to stdout.',
 *     handler: async ({ event, home, params }) => {
 *       console.log(`[${home}] ${event.name}`, event.payload, params);
 *     },
 *   }),
 * ];
 * ```
 */

// ── Types ───────────────────────────────────────────────────────────

/**
 * A single emitted event as handed to a relay's handler.
 *
 * Shape mirrors the public contract in `docs/reference/core-api.md` and
 * the persisted `EventDoc` row in this package — minus the internal
 * `processed` bookkeeping flag, which is not part of the handler
 * contract.
 */
export interface GuildEvent {
  /** Unique event id (`e-<base36_ts>-<hex>`). */
  id: string;
  /**
   * Event name — framework events use `{pluginId}.{kebab-suffix}`
   * (e.g. `clerk.writ-stuck`); operator-defined events follow the same
   * grammar.
   */
  name: string;
  /** Structured payload. Shape is keyed by event name; unenforced. */
  payload: unknown;
  /** Plugin id of the emitter that produced this event. */
  emitter: string;
  /** ISO timestamp when the event was emitted. */
  firedAt: string;
}

/**
 * Runtime context handed to a relay's handler alongside the event.
 *
 * Only carries values that are not already obtainable from `event` or
 * from the `guild()` singleton. Notably:
 *   - `home` is included because it is a common handler need and the
 *     handler may run in a context where calling `guild()` is awkward.
 *   - `params` carries the standing order's optional `with:` block so a
 *     single relay can be reused by multiple orders with different
 *     configuration.
 */
export interface RelayContext {
  /** Absolute path to the guild home directory. */
  home: string;
  /**
   * Parameters from the standing order's `with:` block. Empty object when
   * the order did not declare one.
   */
  params: Record<string, unknown>;
}

/**
 * A fully-defined relay — the return type of `relay()`.
 *
 * Registered by the Clockworks under `name`; looked up by the dispatcher
 * (future task) via `resolveRelay(name)` and invoked as
 * `handler(event, context)`.
 */
export interface RelayDefinition {
  /** Relay name — registration key. Any non-empty string is accepted. */
  readonly name: string;
  /**
   * Optional human-readable description. Not consumed by the dispatcher;
   * reserved for future CLI / observability surfaces.
   */
  readonly description?: string;
  /**
   * The handler. May be sync or async — the dispatcher always awaits.
   * Signals failure by throwing; return values are not consumed.
   */
  readonly handler: (
    event: GuildEvent,
    context: RelayContext,
  ) => void | Promise<void>;
}

/** Input to `relay()` — the author's authoring shape. */
export interface RelayInput {
  name: string;
  description?: string;
  handler: (
    event: GuildEvent,
    context: RelayContext,
  ) => void | Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Define a Clockworks relay.
 *
 * Validates `name` and `handler` fail-loud at call time — a malformed
 * relay throws synchronously at module load rather than silently
 * registering a broken handler. The name must be a non-empty string
 * (format is otherwise unconstrained); the handler must be a function.
 *
 * Returns a plain `RelayDefinition`, not a Plugin wrapper — authors
 * compose multi-relay kits as `{ relays: [relay({...}), relay({...})] }`.
 */
export function relay(def: RelayInput): RelayDefinition {
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new Error(
      'relay(): "name" is required and must be a non-empty string.',
    );
  }
  if (typeof def.handler !== 'function') {
    throw new Error(
      `relay(): "handler" is required and must be a function (relay "${def.name}").`,
    );
  }
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    handler: def.handler,
  };
}

// ── Type guard ──────────────────────────────────────────────────────

/**
 * Structural type guard for `RelayDefinition`.
 *
 * Used by the Clockworks apparatus to validate per-entry contributions
 * from kits at registration time. Matches the shape produced by
 * `relay()` without requiring a discriminator marker.
 */
export function isRelayDefinition(obj: unknown): obj is RelayDefinition {
  if (typeof obj !== 'object' || obj === null) return false;
  const candidate = obj as Partial<RelayDefinition>;
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return false;
  }
  if (typeof candidate.handler !== 'function') return false;
  if (
    candidate.description !== undefined &&
    typeof candidate.description !== 'string'
  ) {
    return false;
  }
  return true;
}
