/**
 * Lattice public types.
 *
 * All types exported from @shardworks/lattice-apparatus.
 *
 * The Lattice is the guild's notification substrate: a `lattice/pulses` book
 * that persists pulse records, a channel-factory contribution vocabulary
 * (`latticeChannels`) that lets external kits contribute push surfaces, and a
 * Phase 2 CDC dispatcher that fans newly-emitted pulses out to every
 * configured channel.
 *
 * Pulses are immutable event records — the only mutable field is
 * `deliveryState`, which the Lattice itself rewrites as dispatches progress.
 * There is no update or delete on the public API surface.
 */

import type { BookEntry } from '@shardworks/stacks-apparatus';

// ── Pulse document ───────────────────────────────────────────────────

/**
 * Delivery state for a pulse.
 *
 *   - `pending`   — written but not yet dispatched to any channel.
 *   - `delivered` — every configured channel returned ok=true.
 *   - `failed`    — at least one configured channel returned ok=false or
 *                   threw; the Lattice records the failure and does not
 *                   retry (best-effort one-shot per D8).
 */
export type PulseDeliveryState = 'pending' | 'delivered' | 'failed';

/**
 * A pulse document as stored in the `lattice/pulses` book.
 *
 * Pulses are emitted by observers (the Reckoner, future emitters) and
 * dispatched by the Lattice to every channel materialized from guild config.
 */
export interface PulseDoc extends BookEntry {
  /** Unique pulse id (`p-{base36_timestamp}-{hex_random}`). Sortable by creation time. */
  id: string;
  /**
   * Plugin id of the emitter that produced this pulse.
   *
   * The Lattice trusts the emitter to stamp its own source id — ownership
   * is convention-only (the Lattice does not forge or validate), mirroring
   * the plugin-keyed sub-slot convention used by `ClerkApi.setWritStatus`.
   */
  source: string;
  /**
   * Trigger type — the "what" axis of a pulse, independent of the source.
   *
   * Format: `{pluginId}.{kebab-suffix}` (e.g. `reckoner.writ-stuck`). Same
   * grammar Clerk uses for link kinds.
   */
  triggerType: string;
  /** Optional writ this pulse is about. Null for pulses that are not writ-scoped (e.g. queue-drained). */
  writId: string | null;
  /** Short human-readable title suitable for a notification headline. */
  title: string;
  /** Plain-text summary (one or two short lines). Degrades gracefully across channel backends. */
  summary: string;
  /**
   * Deep link into a surface that lets the patron act on the pulse.
   *
   * Always `null` in the MVP — no canonical public URL base exists yet.
   * Future commissions may populate this for pulses that have a sensible
   * remote-viewable URL.
   */
  linkUrl: string | null;
  /**
   * Structured payload keyed by triggerType. See individual emitters for the
   * concrete shapes (e.g. the Reckoner's writ-stuck context).
   */
  context: Record<string, unknown>;
  /** Current delivery state. Rewritten by the dispatcher. */
  deliveryState: PulseDeliveryState;
  /** Reason when `deliveryState` is `failed`. Absent on pending/delivered. */
  deliveryError?: string;
  /** ISO timestamp when the pulse was emitted. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
}

// ── Channel abstraction ──────────────────────────────────────────────

/**
 * Outcome returned by a channel's `send()`.
 *
 * Channels must never throw across the boundary — any error is reported as
 * `{ ok: false, error }` instead. This keeps the dispatcher simple and makes
 * the per-channel failure policy explicit.
 */
export type DeliveryOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * A materialized channel instance.
 *
 * Channels are created once at startup from per-channel instance config and
 * re-used across dispatches. `type` is the factory id (e.g. `discord-webhook`).
 */
export interface LatticeChannel {
  /** Factory type id — matches `LatticeChannelFactory.type`. */
  readonly type: string;
  /**
   * Deliver a pulse. Must never throw across the boundary; any error is
   * reported as `{ ok: false, error }` instead.
   */
  send(pulse: PulseDoc): Promise<DeliveryOutcome>;
}

/**
 * A channel factory contributed by a kit via `latticeChannels`.
 *
 * The factory builds a `LatticeChannel` from per-instance config drawn from
 * `guild.json`'s `lattice.channels` array. Instance config carries the
 * caller-provided fields (e.g. a `webhookUrlEnvVar` naming the env var
 * holding the Discord webhook URL) — secrets are resolved at send time,
 * never persisted.
 */
export interface LatticeChannelFactory {
  /** Factory type id. Must be unique across contributed factories. */
  readonly type: string;
  /**
   * Build a channel instance from the per-instance config drawn from
   * `lattice.channels[i]` (with the `type` field included).
   */
  create(instanceConfig: LatticeChannelInstanceConfig): LatticeChannel;
}

/**
 * Per-channel instance config as it appears in `guild.json`'s
 * `lattice.channels` array. The `type` field selects the factory; all other
 * fields are factory-specific.
 */
export interface LatticeChannelInstanceConfig {
  /** Factory type id — selects the channel factory. */
  type: string;
  /** Caller-supplied instance fields (webhook env var, discord channel id, etc.). */
  [field: string]: unknown;
}

// ── Kit contribution interface ───────────────────────────────────────

/**
 * Kit contribution interface for plugins that extend the Lattice with
 * additional channel factories. Contribute an array of factories under
 * `latticeChannels`; each factory becomes selectable via its `type` field in
 * `lattice.channels`.
 */
export interface LatticeKit {
  /** Channel factories contributed by this kit. */
  latticeChannels?: LatticeChannelFactory[];
}

// ── Config ───────────────────────────────────────────────────────────

/**
 * Lattice apparatus configuration — lives under the `lattice` key in
 * `guild.json`.
 */
export interface LatticeConfig {
  /**
   * Configured channel instances. Each entry is passed to the factory whose
   * `type` field matches `entry.type`. Multiple entries may share a type —
   * e.g. two Discord webhook channels pointing at different endpoints.
   *
   * Secrets (webhook URLs, tokens, …) are never placed in this array
   * directly; instead entries name an env var (convention per-factory) that
   * is read at send time.
   */
  channels?: LatticeChannelInstanceConfig[];
}

// Augment GuildConfig so `guild().guildConfig().lattice` is typed without
// requiring a manual type parameter at the call site.
declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    lattice?: LatticeConfig;
  }
}

// ── Request / filter types ───────────────────────────────────────────

/**
 * Request to emit a new pulse. The Lattice fills in `id`, `deliveryState`
 * (`'pending'`), and timestamps; the caller supplies everything else.
 */
export interface EmitPulseRequest {
  /** Plugin id of the emitter (stamped onto `pulse.source`). */
  source: string;
  /** Trigger type — fully-qualified `{pluginId}.{kebab-suffix}` id. */
  triggerType: string;
  /** Optional writ this pulse is about. Null for non-writ-scoped pulses. */
  writId?: string | null;
  /** Short human-readable title. */
  title: string;
  /** Plain-text summary. */
  summary: string;
  /** Optional deep link (always null in MVP). */
  linkUrl?: string | null;
  /** Structured payload keyed by trigger type. Defaults to `{}`. */
  context?: Record<string, unknown>;
}

/**
 * Filters accepted by `LatticeApi.list` / `LatticeApi.count`.
 */
export interface PulseFilters {
  /** Filter by triggerType. Accepts a single value or an array (OR). */
  triggerType?: string | string[];
  /** Filter by source plugin id. */
  source?: string;
  /** Only pulses created at or after this ISO timestamp. */
  since?: string;
  /** Only pulses created at or before this ISO timestamp. */
  until?: string;
  /** Filter by delivery state. Accepts a single value or an array (OR). */
  deliveryState?: PulseDeliveryState | PulseDeliveryState[];
  /** Maximum number of results (default: 20). */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

// ── API ──────────────────────────────────────────────────────────────

/**
 * The Lattice's runtime API — retrieved via `guild().apparatus<LatticeApi>('lattice')`.
 *
 * The surface mirrors `ClerkApi`'s read-side shape: `emit`, `show`, `list`,
 * `count`, `resolveId`. There is no `update` or `delete` — pulses are
 * immutable event records. The only mutable field on a pulse is
 * `deliveryState`, and the Lattice itself is the only writer.
 */
export interface LatticeApi {
  /**
   * Emit a pulse. Assigns an id, timestamps, and `deliveryState: 'pending'`,
   * writes it to the pulses book, and returns the persisted document.
   *
   * Dispatch is handled asynchronously by the Lattice's Phase 2 CDC
   * watcher — `emit()` does not wait for delivery.
   */
  emit(request: EmitPulseRequest): Promise<PulseDoc>;

  /** Show a pulse by id. Throws if not found. */
  show(id: string): Promise<PulseDoc>;

  /**
   * Resolve a pulse id prefix to the full id. Throws when no pulse matches
   * or when the prefix is ambiguous.
   */
  resolveId(prefix: string): Promise<string>;

  /**
   * List pulses with optional filters, ordered by createdAt descending.
   * Default limit is 20; default `since` is 24h before now.
   */
  list(filters?: PulseFilters): Promise<PulseDoc[]>;

  /** Count pulses matching optional filters. */
  count(filters?: PulseFilters): Promise<number>;
}
